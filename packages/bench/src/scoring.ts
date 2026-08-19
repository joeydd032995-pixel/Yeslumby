import { efficiency } from "@meta/shared";
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
 * Where a task does supply expected findings, a coverage dimension is added.
 * That is a keyword proxy for accuracy and is weighted alongside the structural
 * dimensions rather than dominating them.
 */

export interface ScoringDimension {
  key: string;
  weight: number;
}

export interface BenchmarkTask {
  id: string;
  objective: string;
  problemClass?: string;
  /** Optional expected findings, enabling the coverage dimension. */
  expectedFindings?: string[];
}

export interface DimensionScores {
  evidenceQuality: number;
  disagreementPreserved: number;
  falsifiability: number;
  structuralDepth: number;
  watcherOverall: number;
  coverage?: number;
}

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
 * Weights are renormalized over the dimensions actually present, so a suite
 * whose tasks lack expected findings is not silently penalized for the missing
 * coverage dimension.
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
