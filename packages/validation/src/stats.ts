/**
 * Statistics for the validation experiments.
 *
 * These exist so a negative result is legible rather than smoothed over. Every
 * estimate is reported with an interval, because the sample sizes involved
 * (tens of runs, not thousands) produce correlations that look impressive and
 * mean nothing. A point estimate of 0.4 from twenty runs is compatible with
 * "no relationship at all", and the harness should say so rather than let a
 * number stand unqualified.
 */

/** Ranks with ties averaged, which is what Spearman requires. */
export function rank(values: readonly number[]): number[] {
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value);

  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]!.value === order[i]!.value) j++;
    // Average rank across the tied block, 1-based.
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k]!.index] = shared;
    i = j + 1;
  }
  return ranks;
}

/** Pearson correlation. Returns null when either input has no variance. */
export function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i]! - mx;
    const b = ys[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

/** Spearman rank correlation — Pearson over ranks, so monotone but non-linear
 *  relationships still register. */
export function spearman(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length !== ys.length || xs.length < 2) return null;
  return pearson(rank(xs), rank(ys));
}

export interface Interval {
  estimate: number | null;
  low: number;
  high: number;
  n: number;
  /** True when the interval contains zero — i.e. no detectable relationship. */
  includesZero: boolean;
}

/**
 * Bootstrap confidence interval for a correlation.
 *
 * Resampling rather than a closed form because the sample sizes are small and
 * the scores are neither normal nor independent of the objective they came
 * from. A deterministic seed keeps the reported interval reproducible.
 */
export function bootstrapCorrelation(
  xs: readonly number[],
  ys: readonly number[],
  options: { iterations?: number; seed?: number; method?: "spearman" | "pearson" } = {},
): Interval {
  const iterations = options.iterations ?? 2000;
  const method = options.method ?? "spearman";
  const correlate = method === "spearman" ? spearman : pearson;
  const n = xs.length;
  const estimate = correlate(xs, ys);

  if (n < 3) {
    return { estimate, low: -1, high: 1, n, includesZero: true };
  }

  // mulberry32, so the interval is identical across runs of the same data.
  let state = (options.seed ?? 0x9e3779b9) >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const samples: number[] = [];
  for (let iter = 0; iter < iterations; iter++) {
    const bx: number[] = [];
    const by: number[] = [];
    for (let i = 0; i < n; i++) {
      const pick = Math.floor(next() * n);
      bx.push(xs[pick]!);
      by.push(ys[pick]!);
    }
    const r = correlate(bx, by);
    if (r !== null) samples.push(r);
  }

  if (samples.length === 0) {
    return { estimate, low: -1, high: 1, n, includesZero: true };
  }

  samples.sort((a, b) => a - b);
  const at = (q: number) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))]!;
  const low = at(0.025);
  const high = at(0.975);
  return { estimate, low, high, n, includesZero: low <= 0 && high >= 0 };
}

/**
 * Wilson score interval for a proportion.
 *
 * Used for win rates. The normal approximation is badly wrong near 0 and 1 and
 * at small n — exactly where a head-to-head comparison lives — and would report
 * a clean sweep of eight trials as certainty.
 */
export function wilson(successes: number, trials: number, z = 1.96): Interval {
  if (trials === 0) return { estimate: null, low: 0, high: 1, n: 0, includesZero: true };
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denom;
  const spread = (z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials)) / denom;
  const low = Math.max(0, centre - spread);
  const high = Math.min(1, centre + spread);
  // For a win rate, "no effect" is 0.5 rather than 0.
  return { estimate: p, low, high, n: trials, includesZero: low <= 0.5 && high >= 0.5 };
}

/** A one-line verdict that refuses to overstate a small sample. */
export function describe(interval: Interval, label: string): string {
  if (interval.estimate === null) return `${label}: no estimate (n=${interval.n})`;
  const e = interval.estimate.toFixed(3);
  const range = `[${interval.low.toFixed(3)}, ${interval.high.toFixed(3)}]`;
  const verdict = interval.includesZero
    ? "INDISTINGUISHABLE FROM NO EFFECT"
    : "effect detected";
  return `${label}: ${e} 95% CI ${range} n=${interval.n} — ${verdict}`;
}
