import { ModelCallError, computeCost, systemClock, type Clock } from "@meta/shared";
import type {
  ModelCallRequest,
  ModelCallResult,
  ModelGateway,
  ModelProvider,
  UsageSink,
} from "./types.js";

/**
 * Routing, failover, retry, and cost accounting around a set of providers.
 *
 * Providers stay dumb — one request in, one response out. Everything policy-ish
 * lives here so it behaves identically whether the underlying provider is a
 * hosted model or the deterministic simulator.
 */

export interface GatewayOptions {
  providers: readonly ModelProvider[];
  usageSink?: UsageSink;
  clock?: Clock;
  /** Attempts per model before moving to the next in the chain. */
  maxAttemptsPerModel?: number;
  /** Injected so tests do not spend real time on backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** Base backoff in ms; doubles per attempt. */
  backoffMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Gateway implements ModelGateway {
  readonly #providers: readonly ModelProvider[];
  readonly #usageSink: UsageSink | undefined;
  readonly #clock: Clock;
  readonly #maxAttempts: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #backoffMs: number;

  constructor(options: GatewayOptions) {
    if (options.providers.length === 0) {
      throw new Error("Gateway requires at least one provider");
    }
    this.#providers = options.providers;
    this.#usageSink = options.usageSink;
    this.#clock = options.clock ?? systemClock;
    this.#maxAttempts = options.maxAttemptsPerModel ?? 2;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#backoffMs = options.backoffMs ?? 250;
  }

  async generate(request: ModelCallRequest): Promise<ModelCallResult> {
    const chain = [request.modelId, ...(request.fallbacks ?? [])];
    let attempts = 0;
    let lastError: unknown;

    for (const [index, modelId] of chain.entries()) {
      const provider = this.#providers.find((p) => p.supports(modelId));
      if (!provider) {
        lastError = new ModelCallError(`no provider serves "${modelId}"`, false, { modelId });
        continue;
      }

      for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
        attempts++;
        const startedAt = this.#clock.monotonicMs();
        try {
          const result = await provider.generate({
            modelId,
            system: request.system,
            prompt: request.prompt,
            temperature: request.temperature,
            maxOutputTokens: request.maxOutputTokens,
            ...(request.jsonSchema ? { jsonSchema: request.jsonSchema } : {}),
            seed: request.seed,
          });

          const latencyMs = Math.max(0, Math.round(this.#clock.monotonicMs() - startedAt));

          // Structured output: the provider may hand back a parsed value, or
          // only text. The gateway guarantees `json` is populated when a schema
          // was requested; validating it against the caller's Zod schema is the
          // caller's job, since only it holds the schema.
          let json = result.json;
          if (request.jsonSchema && json === undefined) {
            json = parseJsonOrThrow(result.text, modelId);
          }

          // Priced against the model that actually served, so a fallback to a
          // cheaper model shows up honestly in cost telemetry.
          const { costUsd, unpriced } = computeCost(modelId, result.usage);

          await this.#usageSink?.record({
            modelId,
            provider: provider.name,
            usage: result.usage,
            costUsd,
            unpriced,
            latencyMs,
            attribution: request.attribution ?? {},
          });

          return {
            modelId,
            text: result.text,
            ...(json !== undefined ? { json } : {}),
            usage: result.usage,
            costUsd,
            unpriced,
            latencyMs,
            attempts,
            fallbackUsed: index > 0,
            finishReason: result.finishReason,
          };
        } catch (error) {
          lastError = error;
          const retryable = error instanceof ModelCallError ? error.retryable : true;
          if (!retryable || attempt === this.#maxAttempts) break;
          await this.#sleep(this.#backoffMs * 2 ** (attempt - 1));
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new ModelCallError(`all models failed for ${request.modelId}`, false, {
          chain,
          attempts,
        });
  }
}

function parseJsonOrThrow(text: string, modelId: string): unknown {
  const trimmed = extractJson(text);
  try {
    return JSON.parse(trimmed);
  } catch {
    // Retryable: a differently sampled response may parse. This is the common
    // failure mode for structured output and is worth one more attempt.
    throw new ModelCallError("model did not return parseable JSON", true, {
      modelId,
      preview: text.slice(0, 200),
    });
  }
}

/** Tolerate a fenced code block or leading prose around a JSON body. */
function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) return fenced[1].trim();

  const start = text.search(/[[{]/);
  if (start === -1) return text.trim();
  const openChar = text[start];
  const closeChar = openChar === "{" ? "}" : "]";
  const end = text.lastIndexOf(closeChar);
  return end > start ? text.slice(start, end + 1) : text.trim();
}
