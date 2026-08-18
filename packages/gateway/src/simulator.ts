import { ModelCallError, createRng } from "@meta/shared";
import { synthesize, topicWords, type SynthContext } from "./synth.js";
import type { ProviderRequest, ProviderResult, ModelProvider } from "./types.js";

/**
 * Deterministic model provider.
 *
 * This is not a mock bolted on for testing — it is the substrate that makes the
 * product's central claim checkable. "Every execution runs against an immutable
 * genome version" only buys reproducibility if a run can actually be replayed
 * and compared, and no hosted model gives you that. Under this provider, the
 * same genome, seed, and objective produce byte-identical artifacts, so
 * breeding, benchmark ranking, and mutation attribution can be tested for
 * correctness rather than plausibility.
 *
 * It serves whatever model id it is asked for and reports usage against it, so
 * a genome of Opus agents and one of Haiku agents produce different simulated
 * costs. Efficiency (score per dollar) therefore remains a meaningful signal
 * with no real spend.
 */

export interface ScriptedResponse {
  text?: string;
  json?: unknown;
  /** Throw instead of responding, to exercise retry and fallback paths. */
  error?: { message: string; retryable: boolean };
}

/** Matches a call for scripting or fault injection. */
export interface CallMatcher {
  modelId?: string;
  /** Substring that must appear in the assembled prompt. */
  promptContains?: string;
  /** Substring that must appear in the system channel. */
  systemContains?: string;
}

interface ScriptEntry {
  matcher: CallMatcher;
  response: ScriptedResponse;
  /** Remaining times this entry applies. `Infinity` for always. */
  remaining: number;
}

export interface SimulatorOptions {
  /** Latency reported per call, in ms. Deterministic; no real waiting. */
  latencyMs?: number;
  /** Fixed characters-per-token ratio for usage estimation. */
  charsPerToken?: number;
}

export class SimulatorProvider implements ModelProvider {
  readonly name = "simulator";
  readonly #script: ScriptEntry[] = [];
  readonly #latencyMs: number;
  readonly #charsPerToken: number;
  #callCount = 0;
  readonly calls: ProviderRequest[] = [];

  constructor(options: SimulatorOptions = {}) {
    this.#latencyMs = options.latencyMs ?? 12;
    this.#charsPerToken = options.charsPerToken ?? 4;
  }

  supports(): boolean {
    return true;
  }

  /** Force a specific response for matching calls. */
  script(matcher: CallMatcher, response: ScriptedResponse, times = Infinity): this {
    this.#script.push({ matcher, response, remaining: times });
    return this;
  }

  /**
   * Fail the next matching call. Used to prove that a run resumes from the
   * journal without repeating completed work.
   */
  failNext(matcher: CallMatcher, message = "simulated provider failure", retryable = false): this {
    return this.script(matcher, { error: { message, retryable } }, 1);
  }

  /** Total calls served, for asserting that replayed steps made none. */
  get callCount(): number {
    return this.#callCount;
  }

  reset(): void {
    this.#script.length = 0;
    this.calls.length = 0;
    this.#callCount = 0;
  }

  async generate(request: ProviderRequest): Promise<ProviderResult> {
    this.#callCount++;
    this.calls.push(request);

    const scripted = this.#match(request);
    if (scripted?.error) {
      throw new ModelCallError(scripted.error.message, scripted.error.retryable, {
        modelId: request.modelId,
        provider: this.name,
      });
    }

    const ctx: SynthContext = {
      topic: topicWords(request.prompt),
      voice: this.#voice(request),
    };

    let text: string;
    let json: unknown;

    if (scripted?.json !== undefined) {
      json = scripted.json;
      text = JSON.stringify(scripted.json);
    } else if (scripted?.text !== undefined) {
      text = scripted.text;
    } else if (request.jsonSchema) {
      json = synthesize(request.jsonSchema, request.seed, ctx);
      text = JSON.stringify(json);
    } else {
      text = this.#prose(request, ctx);
    }

    return {
      text,
      ...(json !== undefined ? { json } : {}),
      usage: {
        inputTokens: Math.ceil((request.system.length + request.prompt.length) / this.#charsPerToken),
        outputTokens: Math.ceil(text.length / this.#charsPerToken),
      },
      finishReason: "stop",
    };
  }

  #match(request: ProviderRequest): ScriptedResponse | undefined {
    for (const entry of this.#script) {
      if (entry.remaining <= 0) continue;
      const { matcher } = entry;
      if (matcher.modelId && matcher.modelId !== request.modelId) continue;
      if (matcher.promptContains && !request.prompt.includes(matcher.promptContains)) continue;
      if (matcher.systemContains && !request.system.includes(matcher.systemContains)) continue;
      entry.remaining -= 1;
      return entry.response;
    }
    return undefined;
  }

  /** A stable label for whoever is speaking, derived from the seed. */
  #voice(request: ProviderRequest): string {
    const fromSeed = request.seed.split(/[:\s]/).filter(Boolean);
    return fromSeed.at(-1) ?? request.modelId;
  }

  #prose(request: ProviderRequest, ctx: SynthContext): string {
    const rng = createRng(request.seed);
    const lines = Array.from({ length: rng.int(2, 4) }, () =>
      synthesize({ type: "string" }, `${request.seed}:${rng.next()}`, ctx),
    );
    return lines.join(" ");
  }

  /** Reported latency. Constant so run duration is reproducible. */
  get latencyMs(): number {
    return this.#latencyMs;
  }
}
