import { createRng } from "@meta/shared";

/**
 * Is a candidate architecture actually better, or did it draw a better sample?
 *
 * The promotion rule this replaces compares two scalars against a fixed epsilon.
 * That rule cannot distinguish a small real gain from evaluator noise, and the
 * epsilon has to be guessed in advance without knowing the noise it is meant to
 * clear.
 *
 * A paired bootstrap answers the question with the data instead. Two genomes run
 * the same tasks, so the per-task differences are paired observations; resampling
 * them gives an interval around the mean difference, and an interval that
 * straddles zero means the suite cannot tell the two architectures apart. That is
 * a finding rather than a failure — it says "do not promote on this evidence",
 * which is precisely what the epsilon rule was unable to say.
 *
 * Pairing is by task, and champion and candidate get different seeds on the same
 * task by design: {@link benchmarkSeed} derives from the genome hash so neither
 * genome benefits from a luckier sample. The task is held fixed and only the
 * architecture varies, which is what makes the pairing valid.
 *
 * `packages/validation/src/stats.ts` holds the sibling estimators used by the
 * validation experiments. They are not reused here because `@meta/validation`
 * depends on `@meta/bench`, so importing it would close a package cycle — and it
 * has no paired-delta estimator in any case: `bootstrapCorrelation` measures
 * association and `wilson` measures a proportion.
 */

export interface PairedDelta {
  /** Mean of candidate − champion across paired tasks. Positive favours the candidate. */
  meanDelta: number;
  low: number;
  high: number;
  /** Number of paired observations the interval rests on. */
  n: number;
  /** True when the 95% interval contains zero — no difference this suite can detect. */
  includesZero: boolean;
}

export interface PairedDeltaOptions {
  iterations?: number;
  /** Seed for the resampling, so a promotion decision replays identically. */
  seed?: string;
}

const DEFAULT_ITERATIONS = 2000;

/**
 * Percentile bootstrap over paired differences.
 *
 * Resampling rather than a t-interval because the per-task scores are bounded in
 * [0,1], are not normal, and come from a handful of tasks — the regime where a
 * closed form quietly misstates its own confidence.
 */
export function bootstrapPairedDelta(
  championScores: readonly number[],
  candidateScores: readonly number[],
  options: PairedDeltaOptions = {},
): PairedDelta {
  if (championScores.length !== candidateScores.length) {
    throw new Error(
      `paired comparison needs equal-length inputs, got ${championScores.length} and ${candidateScores.length}`,
    );
  }

  const n = championScores.length;
  const deltas = candidateScores.map((score, i) => score - championScores[i]!);
  const meanDelta = n === 0 ? 0 : round4(mean(deltas));

  // Below three pairs the interval is not worth reporting: any bound the
  // resampling produces is an artifact of having almost nothing to resample.
  // Mirrors the same guard in validation's bootstrapCorrelation.
  if (n < 3) {
    return { meanDelta, low: -1, high: 1, n, includesZero: true };
  }

  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const rng = createRng(options.seed ?? "paired-delta");

  const samples: number[] = [];
  for (let iter = 0; iter < iterations; iter++) {
    let total = 0;
    for (let i = 0; i < n; i++) {
      total += deltas[Math.floor(rng.next() * n)]!;
    }
    samples.push(total / n);
  }

  samples.sort((a, b) => a - b);
  const at = (q: number) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))]!;
  const low = round4(at(0.025));
  const high = round4(at(0.975));

  return { meanDelta, low, high, n, includesZero: low <= 0 && high >= 0 };
}

/** A one-line account of the comparison that refuses to overstate a small sample. */
export function describePairedDelta(delta: PairedDelta): string {
  const range = `[${delta.low.toFixed(3)}, ${delta.high.toFixed(3)}]`;
  if (delta.n < 3) {
    return `mean delta ${delta.meanDelta.toFixed(3)} over ${delta.n} task(s) — too few to test`;
  }
  const verdict = delta.includesZero
    ? "indistinguishable from no difference"
    : delta.meanDelta > 0
      ? "candidate better"
      : "candidate worse";
  return `mean delta ${delta.meanDelta.toFixed(3)} 95% CI ${range} n=${delta.n} — ${verdict}`;
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
