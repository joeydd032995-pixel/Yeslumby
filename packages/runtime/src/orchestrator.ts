import { addUsage, zeroUsage, RunPaused, StopCriterionError, type TokenUsage } from "@meta/shared";
import { runs } from "@meta/db";
import { executeRound, shouldContinue, type RoundResult } from "./machine.js";
import type { PriorRound } from "./stages/context.js";
import type { RunContext } from "./context.js";
import { serializeError } from "./journal.js";

/**
 * Multi-round execution within a single run.
 *
 * This is the *inner* loop, and it is important not to confuse it with the
 * generational one. A run is pinned to one immutable genome version for its
 * whole life — `runs.genome_version_id` is a single foreign key, and the product
 * thesis is that an execution is reproducible against a named version. Letting a
 * run swap architectures between iterations would make "which version produced
 * this?" unanswerable.
 *
 * So what changes between iterations here is not the organization but its
 * knowledge of the problem: round N receives round N−1's synthesis as shared
 * framing. Changing the architecture is the job of `evolveEcosystem`, which
 * operates across runs.
 *
 * Every iteration's steps are journaled under their own iteration number, so a
 * crash in round 3 replays rounds 1 and 2 for free rather than re-running them.
 */

export interface IterationRecord {
  iteration: number;
  /** Watcher's overall score, or null when the watcher is disabled. */
  score: number | null;
  costUsd: number;
  disagreementLevel: number;
  contestedCount: number;
  highConfidenceCount: number;
  unknownsCount: number;
  replayed: boolean;
}

export interface EcosystemRunResult {
  /** One record per completed iteration, in order. */
  trajectory: IterationRecord[];
  /** The last round that completed. */
  final: RoundResult;
  finalIteration: number;
  stoppedBecause: string;
  totalUsage: TokenUsage;
  totalCostUsd: number;
  /** True when the score never improved after the first iteration. */
  stagnated: boolean;
}

export interface RunEcosystemOptions {
  /** Hard ceiling regardless of genome settings. Guards against a bad genome. */
  maxIterations?: number;
  onIteration?: (record: IterationRecord, round: RoundResult) => void | Promise<void>;
  /** Mark the run row COMPLETED/FAILED when the loop ends. Default true. */
  finalizeRun?: boolean;
}

/** Absolute cap. `stopCriteria.maxIterations` maxes at 20; this is the backstop. */
const HARD_ITERATION_CAP = 25;

export async function runEcosystem(
  ctx: RunContext,
  options: RunEcosystemOptions = {},
): Promise<EcosystemRunResult> {
  const cap = Math.min(
    options.maxIterations ?? ctx.genome.stopCriteria.maxIterations,
    HARD_ITERATION_CAP,
  );

  const trajectory: IterationRecord[] = [];
  let totalUsage = zeroUsage();
  let totalCostUsd = 0;
  let prior: PriorRound | undefined;
  let final: RoundResult | undefined;
  let finalIteration = 0;
  let stoppedBecause = "no iterations ran";

  try {
    for (let iteration = 0; iteration < cap; iteration++) {
      // A fresh context per iteration rather than mutating in place: the
      // iteration number is part of every journal step key, and a shared
      // mutable field would be a race waiting to happen once rounds overlap.
      const iterationCtx: RunContext = { ...ctx, iteration };

      const round = await executeRound(
        iterationCtx,
        prior ? { prior } : {},
      );

      final = round;
      finalIteration = iteration;
      totalUsage = addUsage(totalUsage, round.usage);
      totalCostUsd += round.costUsd;

      const record: IterationRecord = {
        iteration,
        score: round.evaluation?.scores.overall ?? null,
        costUsd: round.costUsd,
        disagreementLevel: round.disagreementLevel,
        contestedCount: round.synthesis.contested.length,
        highConfidenceCount: round.synthesis.highConfidence.length,
        unknownsCount: round.synthesis.unknowns.length,
        replayed: round.fullyReplayed,
      };
      trajectory.push(record);
      await options.onIteration?.(record, round);

      // Cumulative spend, which no single round can see. A genome whose
      // per-round cost sits just under the ceiling would otherwise iterate
      // forever without any one round tripping the budget check.
      if (totalCostUsd >= ctx.genome.stopCriteria.maxCostUsd) {
        stoppedBecause = "reached cumulative cost ceiling";
        break;
      }

      const decision = shouldContinue(iterationCtx, round, iteration);
      if (!decision.continue) {
        stoppedBecause = decision.reason;
        break;
      }

      if (iteration + 1 >= cap) {
        stoppedBecause = "reached iteration cap";
        break;
      }

      prior = summarizeRound(round, iteration);
    }

    if (!final) {
      throw new StopCriterionError("run produced no iterations", { runId: ctx.run.id });
    }

    if (options.finalizeRun !== false) {
      await runs.finishRun(ctx.sql, ctx.run.id, {
        status: "COMPLETED",
        result: {
          synthesis: final.synthesis,
          trajectory,
          stoppedBecause,
        },
      });
    }

    ctx.emit({ type: "run.finished", status: "COMPLETED" });

    return {
      trajectory,
      final,
      finalIteration,
      stoppedBecause,
      totalUsage,
      totalCostUsd,
      stagnated: isStagnant(trajectory),
    };
  } catch (error) {
    // A pause is not a failure: the run is parked awaiting a human and the
    // journal holds everything computed so far. Marking it FAILED here would
    // lose that distinction and make resumption look like a retry.
    if (error instanceof RunPaused) throw error;

    if (options.finalizeRun !== false) {
      await runs.finishRun(ctx.sql, ctx.run.id, {
        status: "FAILED",
        error: serializeError(error),
      });
    }
    ctx.emit({ type: "run.finished", status: "FAILED" });
    throw error;
  }
}

/** Distil a completed round into what the next one needs to know. */
export function summarizeRound(round: RoundResult, iteration: number): PriorRound {
  return {
    iteration,
    summary: round.synthesis.summary,
    contestedQuestions: round.synthesis.contested.map((c) => c.question),
    unknowns: round.synthesis.unknowns,
    failureModes: round.evaluation?.failureModes.map((f) => f.mode) ?? [],
  };
}

/**
 * Did the organization stop getting better?
 *
 * Reported rather than acted on inside the loop: `shouldContinue` owns the stop
 * decision, and a caller running a generational search wants to know that more
 * rounds are not helping so it can change the *architecture* instead.
 */
export function isStagnant(trajectory: readonly IterationRecord[]): boolean {
  const scored = trajectory.filter((t) => t.score !== null);
  if (scored.length < 2) return false;
  const best = Math.max(...scored.map((t) => t.score!));
  return (scored[0]!.score ?? 0) >= best;
}
