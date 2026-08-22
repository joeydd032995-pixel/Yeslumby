import { hashGenome } from "@meta/genome";
import type {
  AssessInput,
  GenerationAssessment,
  GenerationAssessor,
  PromotionVerdict,
} from "@meta/evolution";
import { runBenchmark, type BenchmarkDeps, type BenchmarkSuite } from "./harness.js";
import { bootstrapPairedDelta, describePairedDelta } from "./significance.js";

/**
 * Judge evolutionary generations by benchmark suite rather than by one score.
 *
 * This is the implementation of `@meta/evolution`'s {@link GenerationAssessor}
 * port, and it lives here rather than there because bench already depends on
 * evolution — evolution importing bench would close the cycle.
 *
 * What it buys: `evolveEcosystem`'s default rule compares the Watcher's overall
 * score for one run against a fixed epsilon. One objective, one number, no way to
 * ask whether the difference is larger than the noise. Running a suite produces a
 * score per task, and per-task scores for two genomes on the same tasks are
 * paired observations — so "is this candidate better" becomes a question the
 * evidence can answer, and "we cannot tell" becomes an answer it can give.
 *
 * What it costs: a suite run per generation on top of the generation's own run,
 * plus one for the baseline. That spend is reported through
 * {@link GenerationAssessment.costUsd} and binds against the evolution budget.
 */

export interface BenchmarkAssessorOptions {
  deps: BenchmarkDeps;
  suite: BenchmarkSuite;
  /**
   * Base seed for the bootstrap resampling. Derived per comparison from the two
   * genome hashes, so a promotion decision replays identically — the point of a
   * reproducible runtime is lost if the rule that picks the winner is not.
   */
  seed?: string;
  /**
   * Bootstrap iterations. The default is adequate for a percentile interval on
   * the task counts a suite realistically has.
   */
  iterations?: number;
}

export function createBenchmarkAssessor(
  options: BenchmarkAssessorOptions,
): GenerationAssessor {
  const { deps, suite } = options;

  return {
    async assess(input: AssessInput): Promise<GenerationAssessment> {
      const report = await runBenchmark(deps, suite, {
        ecosystemId: input.ecosystemId,
        genomeVersionId: input.genomeVersionId,
        genome: input.genome,
        label: input.label,
      });

      return {
        score: report.tasks.length === 0 ? null : report.averageScore,
        perTask: report.tasks.map((t) => ({ taskId: t.taskId, score: t.overallScore })),
        costUsd: report.totalCostUsd,
        // The hash, not the label, is what identifies what was measured — two
        // generations can carry the same label and be different organizations.
        label: `${input.label} (${hashGenome(input.genome).slice(0, 12)})`,
      };
    },

    compare(
      champion: GenerationAssessment,
      candidate: GenerationAssessment,
    ): PromotionVerdict {
      const pairs = pairByTask(champion, candidate);

      // A suite where nothing paired says nothing about either genome. Retaining
      // the champion is the honest response: there is no evidence to displace it.
      if (pairs.length === 0) {
        return {
          promote: false,
          reason: "no tasks completed for both genomes; nothing to compare",
        };
      }

      const delta = bootstrapPairedDelta(
        pairs.map((p) => p.champion),
        pairs.map((p) => p.candidate),
        {
          ...(options.iterations !== undefined ? { iterations: options.iterations } : {}),
          seed: `${options.seed ?? suite.id}:${champion.label}:${candidate.label}`,
        },
      );

      const account = describePairedDelta(delta);

      // Promote only on a positive interval that clears zero. An interval
      // containing zero is the suite saying it cannot distinguish the two, and
      // promoting on that is how a lineage records drift as progress.
      return {
        promote: !delta.includesZero && delta.meanDelta > 0,
        reason: account,
      };
    },
  };
}

interface Pair {
  taskId: string;
  champion: number;
  candidate: number;
}

/**
 * Pair scores by task id.
 *
 * Only tasks both genomes completed can be paired: `runBenchmark` records a
 * failing task in `failures` and omits it from `tasks` rather than voiding the
 * suite, so the two sides can legitimately differ. Comparing unpaired scores
 * would attribute a difference in which tasks ran to a difference in
 * architecture.
 */
function pairByTask(
  champion: GenerationAssessment,
  candidate: GenerationAssessment,
): Pair[] {
  const championByTask = new Map((champion.perTask ?? []).map((t) => [t.taskId, t.score]));
  const pairs: Pair[] = [];

  for (const task of candidate.perTask ?? []) {
    const championScore = championByTask.get(task.taskId);
    if (championScore === undefined) continue;
    pairs.push({ taskId: task.taskId, champion: championScore, candidate: task.score });
  }

  // Sorted so the bootstrap's resampling order does not depend on the order the
  // harness happened to return tasks in.
  return pairs.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
}
