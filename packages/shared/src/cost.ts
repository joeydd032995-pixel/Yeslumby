/**
 * Token accounting and cost.
 *
 * Cost is a first-class metric, not a footnote: the Watcher scores efficiency,
 * benchmarks rank genomes by score-per-dollar, and stop criteria halt runs on
 * spend. Every model call therefore reports usage, and usage is priced here.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Cached-prompt tokens, billed at a reduced rate where the provider supports it. */
  cachedInputTokens?: number;
}

export interface ModelPricing {
  /** USD per 1M input tokens. */
  inputPerMillion: number;
  /** USD per 1M output tokens. */
  outputPerMillion: number;
  /** USD per 1M cached input tokens. Defaults to the input rate when absent. */
  cachedInputPerMillion?: number;
}

/**
 * Published list prices, keyed by gateway model id. Unknown models are priced at
 * zero and flagged, rather than throwing — an unpriced model must never take
 * down a run, but it must be visible in telemetry.
 *
 * This table is a fallback for providers that don't self-report cost. A
 * provider that does (e.g. OpenRouter's usage accounting) reports a real
 * per-call measurement, which the gateway prefers outright — so its number
 * may legitimately diverge from this table's list price for the same model
 * id (routing fees, price drift). That is expected, not a bug; no
 * reconciliation between the two is attempted.
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  "anthropic/claude-opus-4": { inputPerMillion: 15, outputPerMillion: 75 },
  "anthropic/claude-sonnet-4": { inputPerMillion: 3, outputPerMillion: 15 },
  "anthropic/claude-haiku-4": { inputPerMillion: 0.8, outputPerMillion: 4 },
  "openai/gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10 },
  "openai/gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "openai/o3": { inputPerMillion: 2, outputPerMillion: 8 },
  "google/gemini-2.5-pro": { inputPerMillion: 1.25, outputPerMillion: 10 },
  "google/gemini-2.5-flash": { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  // The deterministic test provider is free by construction.
  "simulator/deterministic": { inputPerMillion: 0, outputPerMillion: 0 },
});

export interface CostBreakdown {
  costUsd: number;
  /** True when the model had no pricing entry and cost is therefore understated. */
  unpriced: boolean;
}

/** Round to 10 decimals — matches the NUMERIC(20,10) column usage is stored in. */
function round(n: number): number {
  return Math.round(n * 1e10) / 1e10;
}

export function computeCost(modelId: string, usage: TokenUsage): CostBreakdown {
  const pricing = MODEL_PRICING[modelId];
  if (!pricing) return { costUsd: 0, unpriced: true };

  const cached = usage.cachedInputTokens ?? 0;
  const fresh = Math.max(0, usage.inputTokens - cached);
  const cachedRate = pricing.cachedInputPerMillion ?? pricing.inputPerMillion;

  const costUsd =
    (fresh * pricing.inputPerMillion +
      cached * cachedRate +
      usage.outputTokens * pricing.outputPerMillion) /
    1_000_000;

  return { costUsd: round(costUsd), unpriced: false };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const cached = (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
  };
}

export const zeroUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0 });

export const totalTokens = (u: TokenUsage): number => u.inputTokens + u.outputTokens;

/**
 * Intelligence efficiency: quality per dollar. Free runs (the deterministic
 * provider) report `null` rather than Infinity so downstream ranking can
 * exclude them instead of having them dominate every leaderboard.
 */
export function efficiency(score: number, costUsd: number): number | null {
  if (costUsd <= 0) return null;
  return round(score / costUsd);
}
