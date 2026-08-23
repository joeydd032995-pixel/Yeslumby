import { ModelCallError } from "@meta/shared";
import type { ModelProvider, ProviderRequest, ProviderResult } from "./types.js";

/**
 * OpenRouter provider.
 *
 * A swap-in alternative to the Vercel AI Gateway provider, not a second
 * permanently-registered one: both speak the same OpenAI-compatible
 * chat-completions shape and OpenRouter's own model catalog already uses the
 * genome's `vendor/model` id convention (`anthropic/claude-sonnet-4`,
 * `meta-llama/llama-3.1-70b-instruct`, ...), so no id translation or prefix
 * is needed here either. Which backend is actually active is a composition-
 * root decision (see `resolveGateway` in ./index.ts), not something this
 * provider needs to know about — `supports()` claims the same id shape
 * `AiGatewayProvider` does, so this class works standalone too.
 *
 * Talks to OpenRouter over fetch rather than through an SDK, matching
 * ai-gateway.ts's reasoning: the surface used is small and stable, and it
 * keeps a provider that cannot be exercised without credentials from pulling
 * in a large dependency tree.
 *
 * Unlike Vercel's gateway, OpenRouter passes `response_format` through to
 * whatever model it routes a call to, and not every routed model honors
 * structured output — a request for JSON schema may be silently ignored by
 * an unsupporting model. No special-case handling is added for this here:
 * the gateway's existing empty-content and unparseable-JSON retry already
 * covers it (see `parseJsonOrThrow` in ./gateway.ts).
 */

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Per-request timeout. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Optional attribution header (OpenRouter's public rankings). */
  siteUrl?: string;
  /** Optional attribution header (OpenRouter's public rankings). */
  appName?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    /** USD cost for this call, present when the request asked for usage accounting. */
    cost?: number;
  };
  error?: { message?: string; type?: string };
}

export class OpenRouterProvider implements ModelProvider {
  readonly name = "openrouter";
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #siteUrl: string | undefined;
  readonly #appName: string | undefined;

  constructor(options: OpenRouterOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENROUTER_API_KEY is not set. Use the simulator provider, or supply a key.",
      );
    }
    this.#apiKey = apiKey;
    this.#baseUrl = (options.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? DEFAULT_BASE_URL)
      .replace(/\/$/, "");
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#siteUrl = options.siteUrl ?? process.env.OPENROUTER_SITE_URL;
    this.#appName = options.appName ?? process.env.OPENROUTER_APP_NAME;
  }

  /** OpenRouter fronts a large catalog under the same `vendor/model` shape. */
  supports(modelId: string): boolean {
    return modelId.includes("/") && !modelId.startsWith("simulator/");
  }

  async generate(request: ProviderRequest): Promise<ProviderResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#apiKey}`,
          ...(this.#siteUrl ? { "HTTP-Referer": this.#siteUrl } : {}),
          ...(this.#appName ? { "X-Title": this.#appName } : {}),
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: request.modelId,
          temperature: request.temperature,
          max_tokens: request.maxOutputTokens,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.prompt },
          ],
          // Requests OpenRouter's usage-accounting extension, which returns
          // real per-call USD cost on the response's usage object — that's
          // what lets the gateway price against a measurement instead of the
          // static MODEL_PRICING table for the much larger set of models
          // OpenRouter routes to.
          usage: { include: true },
          ...(request.jsonSchema
            ? {
                response_format: {
                  type: "json_schema",
                  json_schema: {
                    name: "stage_output",
                    strict: true,
                    schema: request.jsonSchema,
                  },
                },
              }
            : {}),
        }),
      });

      if (!response.ok) {
        throw new ModelCallError(
          `openrouter returned ${response.status}: ${(await safeText(response)).slice(0, 300)}`,
          isRetryableStatus(response.status),
          { modelId: request.modelId, status: response.status },
        );
      }

      const body = (await response.json()) as ChatCompletionResponse;
      if (body.error) {
        throw new ModelCallError(body.error.message ?? "openrouter error", false, {
          modelId: request.modelId,
          type: body.error.type,
        });
      }

      const choice = body.choices?.[0];
      const text = choice?.message?.content ?? "";
      if (!text) {
        // Empty content usually means a transient truncation or filter event
        // rather than a real answer; worth one retry.
        throw new ModelCallError("openrouter returned empty content", true, {
          modelId: request.modelId,
          finishReason: choice?.finish_reason,
        });
      }

      const cached = body.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      return {
        text,
        usage: {
          inputTokens: body.usage?.prompt_tokens ?? 0,
          outputTokens: body.usage?.completion_tokens ?? 0,
          ...(cached > 0 ? { cachedInputTokens: cached } : {}),
        },
        finishReason: choice?.finish_reason ?? "stop",
        ...(body.usage?.cost !== undefined ? { costUsd: body.usage.cost } : {}),
      };
    } catch (error) {
      if (error instanceof ModelCallError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new ModelCallError(`openrouter request timed out after ${this.#timeoutMs}ms`, true, {
          modelId: request.modelId,
        });
      }
      throw new ModelCallError(
        error instanceof Error ? error.message : "openrouter request failed",
        true,
        { modelId: request.modelId },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 408/409/429 and 5xx are transient; other 4xx are caller errors. 402
 * (insufficient OpenRouter account credit) is deliberately left
 * non-retryable — retrying will not fix an empty balance.
 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable body>";
  }
}

/** True when hosted inference through OpenRouter is configured for this process. */
export function hasOpenRouterCredentials(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}
