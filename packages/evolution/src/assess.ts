import type { ArchitectureGenome } from "@meta/genome";

/**
 * How a generation is judged against the reigning champion.
 *
 * By default {@link evolveEcosystem} promotes on the Watcher's overall score for
 * the generation's run — one scalar, from one objective, against a fixed epsilon.
 * That is a sample of one, and a mutation engine steered by a noisy evaluator at
 * n=1 cannot tell a real improvement from a lucky draw.
 *
 * This port is the seam where a caller substitutes a better judgement. An
 * implementation may execute a whole benchmark suite and return per-task scores,
 * which is what makes a paired statistical test possible; see
 * `createBenchmarkAssessor` in `@meta/bench`.
 *
 * It is a port rather than a direct dependency because `@meta/bench` already
 * depends on `@meta/evolution` — it reaches `repair` for ablation. Importing bench
 * from here would close that cycle. Defining the contract on this side and
 * implementing it on the other keeps the dependency pointing one way, and keeps
 * the choice of judgement at the call site where it can be seen.
 */

/** What an assessor measured about one genome version. */
export interface GenerationAssessment {
  /** Aggregate quality, comparable across assessments from the same assessor. */
  score: number | null;
  /**
   * Per-task detail, when the assessor produced any. This is what a paired test
   * consumes; an assessor returning only an aggregate limits `compare` to
   * whatever a single scalar can support.
   */
  perTask?: ReadonlyArray<{ taskId: string; score: number }>;
  /** Spend incurred by the assessment itself, folded into the evolution budget. */
  costUsd: number;
  /** Human-readable identifier for the thing assessed, for the generation record. */
  label: string;
}

/**
 * Whether a candidate should displace the champion.
 *
 * `reason` is surfaced on the generation record verbatim, so it should read as an
 * account of the decision rather than a status word — the point of replacing the
 * epsilon rule is that the reason for a rejection becomes legible.
 */
export interface PromotionVerdict {
  promote: boolean;
  reason: string;
}

export interface AssessInput {
  ecosystemId: string;
  genomeVersionId: string;
  genome: ArchitectureGenome;
  /** Identifies the generation being assessed, for labelling and seeding. */
  label: string;
}

export interface GenerationAssessor {
  assess(input: AssessInput): Promise<GenerationAssessment>;
  /**
   * Decide the promotion. Called with the champion's standing assessment and the
   * candidate's fresh one; the champion's is carried forward rather than
   * recomputed, so this must not assume both were measured at the same moment.
   */
  compare(
    champion: GenerationAssessment,
    candidate: GenerationAssessment,
  ): PromotionVerdict;
}
