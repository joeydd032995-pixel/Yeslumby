import { RunPaused, StopCriterionError, addUsage, zeroUsage, type TokenUsage } from "@meta/shared";
import { runs, telemetry } from "@meta/db";
import type { RunContext } from "./context.js";
import { runContextStage } from "./stages/context.js";
import { runProposals } from "./stages/proposals.js";
import { runChallenges } from "./stages/challenges.js";
import { runFalsification } from "./stages/falsification.js";
import { runSynthesis } from "./stages/synthesis.js";
import { groundEfficiency, runWatcher } from "./stages/watcher.js";
import type { Synthesis, WatcherEvaluation } from "./schemas.js";
import type { ProposalOutcome } from "./stages/proposals.js";
import type { ChallengeOutcome } from "./stages/challenges.js";
import type { FalsificationOutcome } from "./stages/falsification.js";

/**
 * The run state machine.
 *
 * CONTEXT → PROPOSALS → CHALLENGES → FALSIFICATION → [HUMAN_APPROVAL] →
 * SYNTHESIS → WATCHER → COMPLETE.
 *
 * Mutation and memory consolidation happen after a round completes, in the
 * orchestrator, because both operate on the round's outcome rather than
 * producing part of it.
 *
 * Every stage runs inside a journaled step, so the entire function is safe to
 * re-enter. Resuming is not a special code path: `resumeRun` calls the same
 * `executeRound`, and completed stages replay from the journal. That is why a
 * pause for human approval costs nothing to resume from — and why a crash
 * mid-run does not repeat a single model call.
 */

export const STAGES = [
  "CONTEXT",
  "PROPOSALS",
  "CHALLENGES",
  "FALSIFICATION",
  "HUMAN_APPROVAL",
  "SYNTHESIS",
  "WATCHER",
  "MUTATION",
  "MEMORY",
  "COMPLETE",
] as const;
export type Stage = (typeof STAGES)[number];

export interface RoundResult {
  synthesis: Synthesis;
  synthesisArtifactId: string;
  evaluation?: WatcherEvaluation;
  watcherArtifactId?: string;
  rejectedMutations: Array<{ type: string; reason: string }>;
  proposals: ProposalOutcome[];
  challenges: ChallengeOutcome[];
  falsifications: FalsificationOutcome[];
  disagreementLevel: number;
  usage: TokenUsage;
  costUsd: number;
  /** True when every stage replayed, i.e. nothing new was computed. */
  fullyReplayed: boolean;
}

/** Does this genome require a human to approve before synthesis? */
export function requiresApproval(level: string): boolean {
  return level === "all" || level === "high_risk";
}

export async function executeRound(ctx: RunContext): Promise<RoundResult> {
  const genome = ctx.genome;
  let usage = zeroUsage();
  let costUsd = 0;
  const replayFlags: boolean[] = [];

  const track = (c: { usage: TokenUsage; costUsd: number }) => {
    usage = addUsage(usage, c.usage);
    costUsd += c.costUsd;
  };

  await runs.updateRunProgress(ctx.sql, ctx.run.id, {
    status: "RUNNING",
    stage: "CONTEXT",
    iteration: ctx.iteration,
  });

  // --- CONTEXT -------------------------------------------------------------
  const context = await runContextStage(ctx);
  track(context.cost);
  replayFlags.push(context.replayed);

  // --- PROPOSALS (independent fan-out) -------------------------------------
  await runs.updateRunProgress(ctx.sql, ctx.run.id, { stage: "PROPOSALS" });
  const proposals = await runProposals(ctx, {
    objective: ctx.run.objective,
    context: context.context,
    memories: context.memories,
  });
  track(proposals.cost);
  replayFlags.push(...proposals.proposals.map((p) => p.replayed));

  assertWithinBudget(ctx, costUsd, usage);

  // --- CHALLENGES (edge-driven) --------------------------------------------
  let challenges: ChallengeOutcome[] = [];
  let disagreementLevel = 0;
  if (genome.protocols.crossChallenge) {
    await runs.updateRunProgress(ctx.sql, ctx.run.id, { stage: "CHALLENGES" });
    const result = await runChallenges(ctx, proposals.proposals);
    track(result.cost);
    challenges = result.challenges;
    disagreementLevel = result.disagreementLevel;
    replayFlags.push(...result.challenges.map((c) => c.replayed));
  }

  // --- FALSIFICATION -------------------------------------------------------
  let falsifications: FalsificationOutcome[] = [];
  if (genome.protocols.falsificationRequired) {
    await runs.updateRunProgress(ctx.sql, ctx.run.id, { stage: "FALSIFICATION" });
    const result = await runFalsification(ctx, proposals.proposals, challenges);
    track(result.cost);
    falsifications = result.falsifications;
    replayFlags.push(...result.falsifications.map((f) => f.replayed));
  }

  // --- HUMAN APPROVAL ------------------------------------------------------
  if (requiresApproval(genome.protocols.humanApproval)) {
    await gateOnApproval(ctx, {
      disagreementLevel,
      proposals: proposals.proposals.length,
      challenges: challenges.length,
      costSoFarUsd: costUsd,
    });
  }

  // --- SYNTHESIS -----------------------------------------------------------
  await runs.updateRunProgress(ctx.sql, ctx.run.id, { stage: "SYNTHESIS" });
  const synthesis = await runSynthesis(ctx, {
    proposals: proposals.proposals,
    challenges,
    falsifications,
    disagreementLevel,
  });
  track(synthesis.cost);
  replayFlags.push(synthesis.replayed);

  // --- WATCHER -------------------------------------------------------------
  await runs.updateRunProgress(ctx.sql, ctx.run.id, { stage: "WATCHER" });
  const watcher = await runWatcher(ctx, {
    proposals: proposals.proposals,
    challenges,
    falsifications,
    synthesis: synthesis.synthesis,
    disagreementLevel,
    costUsd,
    totalTokens: usage.inputTokens + usage.outputTokens,
  });

  let evaluation: WatcherEvaluation | undefined;
  if (watcher) {
    track(watcher.cost);
    replayFlags.push(watcher.replayed);
    evaluation = {
      ...watcher.evaluation,
      scores: groundEfficiency(
        watcher.evaluation.scores,
        costUsd + watcher.cost.costUsd,
        genome.stopCriteria.maxCostUsd,
      ),
    };

    await telemetry.insertEvaluation(ctx.sql, {
      id: ctx.ids.next("evaluation"),
      runId: ctx.run.id,
      genomeVersionId: ctx.run.genomeVersionId,
      iteration: ctx.iteration,
      scores: evaluation.scores,
      failureModes: evaluation.failureModes,
      suggestedMutations: evaluation.suggestedMutations,
      recommendation: evaluation.recommendation,
      modelId: genome.watcher.model.primary,
      costUsd: watcher.cost.costUsd,
    });
  }

  await runs.addRunUsage(ctx.sql, ctx.run.id, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd,
  });

  return {
    synthesis: synthesis.synthesis,
    synthesisArtifactId: synthesis.artifactId,
    ...(evaluation ? { evaluation } : {}),
    ...(watcher ? { watcherArtifactId: watcher.artifactId } : {}),
    rejectedMutations: watcher?.rejectedMutations ?? [],
    proposals: proposals.proposals,
    challenges,
    falsifications,
    disagreementLevel,
    usage,
    costUsd,
    fullyReplayed: replayFlags.length > 0 && replayFlags.every(Boolean),
  };
}

/**
 * Park the run until a human decides.
 *
 * The approval row is the durable record; the run status reflects it. Raising
 * {@link RunPaused} unwinds the stack without marking the run failed, and the
 * journal means everything already computed survives the pause.
 */
async function gateOnApproval(ctx: RunContext, payload: Record<string, unknown>): Promise<void> {
  const existing = await runs.getApproval(
    ctx.sql,
    ctx.run.id,
    ctx.iteration,
    "HUMAN_APPROVAL",
  );

  if (existing?.status === "APPROVED") return;
  if (existing?.status === "REJECTED") {
    throw new StopCriterionError("run rejected at human approval", {
      runId: ctx.run.id,
      note: existing.note,
    });
  }

  const approval =
    existing ??
    (await runs.upsertApproval(ctx.sql, {
      id: ctx.ids.next("evaluation"),
      runId: ctx.run.id,
      iteration: ctx.iteration,
      stage: "HUMAN_APPROVAL",
      payload,
    }));

  await runs.updateRunProgress(ctx.sql, ctx.run.id, {
    status: "AWAITING_APPROVAL",
    stage: "HUMAN_APPROVAL",
  });
  ctx.emit({ type: "run.paused", stage: "HUMAN_APPROVAL", approvalId: approval.id });

  throw new RunPaused(ctx.run.id, "HUMAN_APPROVAL", { approvalId: approval.id });
}

function assertWithinBudget(ctx: RunContext, costUsd: number, usage: TokenUsage): void {
  const stop = ctx.genome.stopCriteria;
  if (costUsd > stop.maxCostUsd) {
    throw new StopCriterionError(
      `run exceeded its cost ceiling: $${costUsd.toFixed(4)} > $${stop.maxCostUsd}`,
      { runId: ctx.run.id, costUsd, limit: stop.maxCostUsd },
    );
  }
  const total = usage.inputTokens + usage.outputTokens;
  if (total > stop.maxTokens) {
    throw new StopCriterionError(`run exceeded its token ceiling: ${total} > ${stop.maxTokens}`, {
      runId: ctx.run.id,
      totalTokens: total,
      limit: stop.maxTokens,
    });
  }
}

/** Should the orchestrator run another iteration? */
export function shouldContinue(
  ctx: RunContext,
  result: RoundResult,
  iteration: number,
): { continue: boolean; reason: string } {
  const stop = ctx.genome.stopCriteria;

  if (iteration + 1 >= stop.maxIterations) {
    return { continue: false, reason: "reached maxIterations" };
  }
  const overall = result.evaluation?.scores.overall;
  if (overall !== undefined && overall >= stop.targetScore) {
    return { continue: false, reason: `reached target score (${overall.toFixed(2)})` };
  }
  if (result.costUsd >= stop.maxCostUsd) {
    return { continue: false, reason: "reached cost ceiling" };
  }
  const recommendation = result.evaluation?.recommendation;
  if (recommendation === "stop") return { continue: false, reason: "watcher recommended stop" };
  if (recommendation === "human_review") {
    return { continue: false, reason: "watcher escalated to human review" };
  }
  return { continue: true, reason: recommendation ?? "continue" };
}
