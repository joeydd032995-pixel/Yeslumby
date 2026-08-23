import { efficiency } from "@meta/shared";
// FATAL_DISAGREEMENT_FLOOR is referenced by the reasoning on scoreDisagreement
// rather than by its arithmetic; see there for why the score does not apply it.
import type { RoundResult } from "@meta/runtime";

/**
 * Benchmark scoring.
 *
 * An honest note about what this can and cannot measure. Without labelled
 * answers there is no way to score correctness, and pretending otherwise would
 * produce a leaderboard that rewards confident wrong answers. What *is*
 * measurable from the artifacts, without ground truth, is exactly what this
 * product claims to optimize: whether the organization cited evidence, whether
 * it preserved disagreement it actually had, whether its claims were made
 * falsifiable, and what it cost.
 *
 * Where a task supplies expected findings, a coverage figure is also computed —
 * but under {@link DEFAULT_DIMENSIONS} it is deliberately **not** part of the
 * score. See that constant for why. It is recorded as a diagnostic, and every
 * dimension that does count measures how the organization *behaved* rather than
 * whether it was right.
 *
 * A caller may pass its own `dimensions` list to {@link weightedScore} (via
 * `BenchmarkSuite.dimensions`), and one that includes a `coverage` entry *will*
 * weight it. Every claim below about coverage not counting is scoped to the
 * default list.
 */

export interface ScoringDimension {
  key: string;
  weight: number;
}

export interface BenchmarkTask {
  id: string;
  objective: string;
  problemClass?: string;
  /**
   * Terms that ought to appear if the organization engaged with the question.
   * Feeds the `coverage` figure, which under {@link DEFAULT_DIMENSIONS} is a
   * diagnostic and does not affect a task's score — but a suite supplying its
   * own `dimensions` that include `coverage` makes these load-bearing.
   */
  expectedFindings?: string[];
}

export interface DimensionScores {
  evidenceQuality: number;
  disagreementPreserved: number;
  falsifiability: number;
  structuralDepth: number;
  watcherOverall: number;
  /**
   * Present when the task supplied `expectedFindings`. **Not** in
   * {@link DEFAULT_DIMENSIONS}, so under the default list it contributes nothing
   * to `overallScore` and is a diagnostic — persisted alongside the scored
   * dimensions so "did the organization reach the expected ground?" stays
   * answerable without letting a keyword match decide which architecture wins.
   *
   * A suite that supplies its own `dimensions` including `coverage` overrides
   * that and makes it a scored dimension; read the reasoning on
   * {@link DEFAULT_DIMENSIONS} before doing so.
   */
  coverage?: number;
}

/**
 * The dimensions that count by default.
 *
 * This is a default, not a rule: `runBenchmark` uses `suite.dimensions ?? DEFAULT_DIMENSIONS`,
 * so a suite may supply its own list and weight whatever it likes — including
 * `coverage`.
 *
 * `coverage` is absent here on purpose, and the omission is easy to misread as
 * an oversight — so, concretely, why it is excluded:
 *
 * **It is too coarse to weight.** `scoreCoverage` returns `hits / expected.length`,
 * and tasks carry one or two findings each — so coverage is a step function over
 * {0, 0.5, 1}, or {0, 1} for a single-finding task. Weighted at 0.2 it would move
 * an affected task's score by 0.083–0.167 every time one literal substring
 * appeared or did not. Real differences between two architectures on this suite
 * run around 0.05 across twelve tasks. The measurement would be several times
 * coarser than the effect it is meant to inform, so a promotion decision could
 * turn on whether one word happened to be written.
 *
 * **Under the deterministic provider it is close to noise.** Simulated output is
 * generated from the stage's JSON Schema, so whether the text contains
 * "confound" is largely arbitrary — and that provider is the path the
 * reproducibility claim rests on.
 *
 * **It is the only outcome measure here.** Every dimension below scores how the
 * organization behaved. Coverage gestures at whether it was *right*, which this
 * suite has no labels to judge; promoting it to a weighted dimension is exactly
 * the "leaderboard that rewards confident wrong answers" this module opens by
 * refusing to build.
 *
 * Weighting it would need many more findings per task (to de-quantize it) and a
 * real gateway (so the text means something). Both, not either.
 */
export const DEFAULT_DIMENSIONS: ScoringDimension[] = [
  { key: "evidenceQuality", weight: 0.25 },
  { key: "disagreementPreserved", weight: 0.2 },
  { key: "falsifiability", weight: 0.2 },
  { key: "structuralDepth", weight: 0.15 },
  { key: "watcherOverall", weight: 0.2 },
];

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function scoreRound(result: RoundResult, task: BenchmarkTask): DimensionScores {
  const synthesis = result.synthesis;
  const allClaims = [...synthesis.highConfidence, ...synthesis.workingHypotheses];

  // Every claim should trace to an artifact. Unsourced claims are assertions.
  const evidenceQuality =
    allClaims.length === 0
      ? 0
      : allClaims.filter((c) => c.sources.length > 0).length / allClaims.length;

  // Did the synthesis preserve disagreement proportional to what actually
  // occurred? Both erasing real disagreement and manufacturing fake
  // disagreement are penalized.
  const disagreementPreserved = scoreDisagreement(
    result.disagreementLevel,
    synthesis.contested.length,
    allClaims.length,
  );

  const falsifiability =
    result.falsifications.length === 0
      ? 0
      : result.falsifications.filter((f) => f.falsification.verdict === "falsifiable").length /
        result.falsifications.length;

  // Did the organization surface structure, or just answer? Unknowns and
  // recommended experiments are the marks of an account that knows its own
  // boundary.
  const structuralDepth = clamp01(
    (Math.min(synthesis.unknowns.length, 3) / 3) * 0.5 +
      (Math.min(synthesis.recommendedExperiments.length, 3) / 3) * 0.5,
  );

  const watcherOverall = result.evaluation?.scores.overall ?? 0;

  const scores: DimensionScores = {
    evidenceQuality: round3(evidenceQuality),
    disagreementPreserved: round3(disagreementPreserved),
    falsifiability: round3(falsifiability),
    structuralDepth: round3(structuralDepth),
    watcherOverall: round3(watcherOverall),
  };

  if (task.expectedFindings && task.expectedFindings.length > 0) {
    scores.coverage = round3(scoreCoverage(result, task.expectedFindings));
  }

  return scores;
}

/**
 * Reward matching the disagreement that actually happened.
 *
 * A synthesis reporting nothing contested after a round of fatal objections is
 * flattening. A synthesis reporting everything contested after unanimous
 * agreement is manufacturing doubt, which is equally uninformative. The score
 * peaks when the reported proportion tracks the measured level.
 *
 * **Why this counts claims rather than weighing them by severity.** Contested
 * claims now carry a severity, and weighting by it is the obvious next step. It
 * was tried and reverted, because the two sides of this comparison are not the
 * same kind of quantity and severity makes that mismatch bite:
 *
 * - The measured level is a *mean over challenges* — `computeDisagreement`
 *   floors one challenge at {@link FATAL_DISAGREEMENT_FLOOR} when an objection
 *   is fatal, then averages across all of them, so a single fatal objection
 *   among ten challenges measures 0.075. Applying that same floor to the
 *   *synthesis as a whole* produced 0.75 against a measured 0.075, and scored
 *   correctly surfacing the fatal objection at 0.325 while scoring flattening
 *   it away at 0.925 — an inversion of the dimension's entire purpose.
 * - `computeDisagreement` distinguishes only fatal from non-fatal; minor and
 *   substantive both fall through to `agreementScore`. Weighting them apart on
 *   the reported side alone is a lever with no counterweight, and it paid:
 *   relabelling a truthful `minor` as `substantive` improved the score.
 *
 * Both are fixable, but only by making the measured side severity-aware and
 * aggregating both sides identically — which changes `computeDisagreement`, and
 * with it `checkDisagreementPreserved`, the gate that rejects a synthesis for
 * erasing disagreement. That is a change to how runs *behave*, not just how they
 * are scored, and it belongs in its own change rather than riding along here.
 *
 * So severity is recorded on the claim and visible in artifacts, and the score
 * does not read it yet. A coarse metric beats an inverted one.
 */
export function scoreDisagreement(
  disagreementLevel: number,
  contestedCount: number,
  totalClaims: number,
): number {
  const denominator = contestedCount + totalClaims;
  if (denominator === 0) return disagreementLevel < 0.2 ? 1 : 0;
  const reportedRatio = contestedCount / denominator;
  return clamp01(1 - Math.abs(reportedRatio - disagreementLevel));
}

function scoreCoverage(result: RoundResult, expected: readonly string[]): number {
  const haystack = [
    result.synthesis.summary,
    ...result.synthesis.highConfidence.map((c) => c.text),
    ...result.synthesis.workingHypotheses.map((c) => c.text),
    ...result.synthesis.contested.map((c) => c.question),
    ...result.synthesis.unknowns,
  ]
    .join(" ")
    .toLowerCase();

  const hits = expected.filter((finding) => haystack.includes(finding.toLowerCase()));
  return hits.length / expected.length;
}

/**
 * Weights are renormalized over the dimensions actually present, so a caller
 * supplying `dimensions` that include an optional key is not silently penalized
 * on tasks where that key is absent.
 *
 * Note this iterates `dimensions`, not `scores` — a value present on the scores
 * object but missing from the dimension list contributes nothing, by design.
 * That is how `coverage` stays a diagnostic under {@link DEFAULT_DIMENSIONS}.
 */
export function weightedScore(
  scores: DimensionScores,
  dimensions: readonly ScoringDimension[] = DEFAULT_DIMENSIONS,
): number {
  const lookup: Record<string, number | undefined> = { ...scores };
  const active = dimensions.filter((d) => lookup[d.key] !== undefined);
  const totalWeight = active.reduce((s, d) => s + d.weight, 0);
  if (totalWeight === 0) return 0;

  const sum = active.reduce((s, d) => s + (lookup[d.key] ?? 0) * d.weight, 0);
  return round3(sum / totalWeight);
}

export interface TaskOutcome {
  taskId: string;
  scores: DimensionScores;
  overallScore: number;
  costUsd: number;
  totalTokens: number;
  /** Quality per dollar. Null for free runs, so they cannot top a leaderboard. */
  efficiency: number | null;
}

export function summarizeTask(
  task: BenchmarkTask,
  result: RoundResult,
  dimensions?: readonly ScoringDimension[],
): TaskOutcome {
  const scores = scoreRound(result, task);
  const overallScore = weightedScore(scores, dimensions);
  const totalTokens = result.usage.inputTokens + result.usage.outputTokens;
  return {
    taskId: task.id,
    scores,
    overallScore,
    costUsd: result.costUsd,
    totalTokens,
    efficiency: efficiency(overallScore, result.costUsd),
  };
}
