import { PRIVILEGE_BEARING_MUTATIONS } from "@meta/genome";
import { durableStep } from "../journal.js";
import { WatcherEvaluationSchema, type WatcherEvaluation } from "../schemas.js";
import type { RunContext, StageCost } from "../context.js";
import { callAgent } from "./shared.js";
import type { ProposalOutcome } from "./proposals.js";
import type { ChallengeOutcome } from "./challenges.js";
import type { FalsificationOutcome } from "./falsification.js";
import type { Synthesis } from "../schemas.js";

/**
 * The Watcher evaluates the organization, not the answer.
 *
 * That distinction is the point. Scoring the final answer tells you whether one
 * run went well; scoring the structure tells you which architectures produce
 * good runs, which is the signal the whole evolutionary loop is steered by. So
 * the dimensions are organizational — did the agents actually differ, did
 * challenges engage, was independence real, was evidence cited, what did it
 * cost — and the Watcher is given the *shape* of the round alongside its
 * content.
 *
 * The Watcher proposes mutations but never applies them, and its proposals are
 * untrusted model output like any other. Two of its outputs are filtered here
 * before they can reach the mutation engine.
 */

const INSTRUCTIONS = `Evaluate this organization's performance as an organization.

You are not grading the answer. You are grading the structure that produced it.
A correct answer reached by three agents who never actually disagreed is a weak
result; a contested answer reached through real challenge may be a strong one.

Score each requested dimension in [0,1]:
- diversity: did the agents bring genuinely different perspectives, or restate
  each other in different words?
- challengeQuality: did challenges engage with specific claims and change
  anything, or were they decorative?
- independence: do the proposals look independently derived? Convergence on the
  same framing and the same blind spots suggests they were not.
- evidenceQuality: were claims grounded and sourced, or asserted?
- efficiency: was the result worth what it cost in tokens and calls?

Then:
- failureModes: what specifically went wrong, with the evidence you saw.
- suggestedMutations: concrete structural changes, as typed patches. Propose a
  change only if you can name the failure mode it addresses.
- memoryRetention: what is worth keeping. 'knowledge' is about the world;
  'structural' is about which architectural choices worked here.
- recommendation: continue, mutate, human_review, or stop.

Do not propose mutations that expand any agent's capabilities or alter the
watcher configuration. Those require human review and will be rejected.`;

export interface WatcherInputs {
  proposals: ProposalOutcome[];
  challenges: ChallengeOutcome[];
  falsifications: FalsificationOutcome[];
  synthesis: Synthesis;
  disagreementLevel: number;
  /** Observed cost of the round so far, so efficiency is grounded in fact. */
  costUsd: number;
  totalTokens: number;
}

export interface WatcherResult {
  evaluation: WatcherEvaluation;
  artifactId: string;
  replayed: boolean;
  cost: StageCost;
  /** Mutations removed because they would escalate privilege. */
  rejectedMutations: Array<{ type: string; reason: string }>;
}

export async function runWatcher(
  ctx: RunContext,
  inputs: WatcherInputs,
): Promise<WatcherResult | undefined> {
  if (!ctx.genome.watcher.enabled) return undefined;

  ctx.emit({ type: "stage.start", stage: "WATCHER", iteration: ctx.iteration });

  // The Watcher is not one of the genome's agents — it observes them — so it is
  // given a synthetic agent spec carrying its own model config.
  const watcherAgent = {
    id: "__watcher__",
    name: "Watcher",
    role: "Evaluate the organization",
    cognitiveMode: "critical" as const,
    systemPrompt:
      "You observe this organization from outside it. You have no stake in any " +
      "agent's position and no role in producing the answer.",
    model: ctx.genome.watcher.model,
    capabilities: [],
    weight: 1,
    proposes: false,
  };

  const step = await durableStep(
    { sql: ctx.sql, runId: ctx.run.id, iteration: ctx.iteration, clock: ctx.clock },
    {
      stage: "WATCHER",
      input: {
        model: ctx.genome.watcher.model,
        dimensions: ctx.genome.watcher.dimensions,
        proposals: inputs.proposals.map((p) => p.proposal),
        challenges: inputs.challenges.map((c) => c.challenge),
        synthesis: inputs.synthesis,
        costUsd: inputs.costUsd,
      },
    },
    async () => {
      const result = await callAgent(ctx, {
        agent: watcherAgent,
        stage: "WATCHER",
        kind: "WATCHER",
        callId: "WATCHER",
        stageInstructions: `${INSTRUCTIONS}\n\nDimensions requested by this genome: ${ctx.genome.watcher.dimensions.join(", ")}.`,
        channels: [
          {
            kind: "PEER_OUTPUT",
            note: "structure of the round",
            items: [
              {
                source: "runtime-metrics",
                content:
                  `agents proposing: ${inputs.proposals.length}\n` +
                  `challenges fired: ${inputs.challenges.length}\n` +
                  `measured disagreement: ${inputs.disagreementLevel.toFixed(3)}\n` +
                  `contested claims preserved: ${inputs.synthesis.contested.length}\n` +
                  `unknowns recorded: ${inputs.synthesis.unknowns.length}\n` +
                  `cost so far: $${inputs.costUsd.toFixed(6)} over ${inputs.totalTokens} tokens\n` +
                  `cognitive modes present: ${[...new Set(ctx.genome.agents.map((a) => a.cognitiveMode))].join(", ")}`,
              },
            ],
          },
          {
            kind: "PEER_OUTPUT",
            note: "the proposals produced",
            items: inputs.proposals.map((p) => ({
              source: p.agentId,
              content: `${p.proposal.summary}\nclaims: ${p.proposal.claims.length}, assumptions: ${p.proposal.assumptions.length}, open questions: ${p.proposal.openQuestions.length}`,
            })),
          },
          {
            kind: "PEER_OUTPUT",
            note: "the challenges raised",
            items: inputs.challenges.map((c) => ({
              source: `${c.fromAgentId} → ${c.targetAgentId}`,
              content:
                `agreement ${c.challenge.agreementScore.toFixed(2)}; ` +
                `${c.challenge.objections.length} objections ` +
                `(${c.challenge.objections.filter((o) => o.severity === "fatal").length} fatal)`,
            })),
          },
          {
            kind: "PEER_OUTPUT",
            note: "the synthesis produced",
            items: [
              {
                source: ctx.genome.synthesizerId,
                content:
                  `${inputs.synthesis.summary}\n` +
                  `high confidence: ${inputs.synthesis.highConfidence.length}, ` +
                  `hypotheses: ${inputs.synthesis.workingHypotheses.length}, ` +
                  `contested: ${inputs.synthesis.contested.length}`,
              },
            ],
          },
        ],
        schema: WatcherEvaluationSchema,
        parentArtifactIds: [
          ...inputs.proposals.map((p) => p.artifactId),
          ...inputs.challenges.map((c) => c.artifactId),
        ],
      });
      return {
        evaluation: result.value,
        artifactId: result.artifactId,
        usage: result.usage,
        costUsd: result.costUsd,
      };
    },
  );

  // Filter before anything downstream sees these. The mutation engine enforces
  // the same rule independently; doing it here as well means a privileged
  // proposal never even reaches the approval queue, where a human might wave it
  // through without noticing what it grants.
  const { kept, rejected } = filterPrivilegedMutations(step.value.evaluation);

  ctx.emit({
    type: "stage.finish",
    stage: "WATCHER",
    iteration: ctx.iteration,
    replayed: step.replayed,
  });

  return {
    evaluation: { ...step.value.evaluation, suggestedMutations: kept },
    artifactId: step.value.artifactId,
    replayed: step.replayed,
    cost: { usage: step.value.usage, costUsd: step.value.costUsd },
    rejectedMutations: rejected,
  };
}

export function filterPrivilegedMutations(evaluation: WatcherEvaluation) {
  const kept: WatcherEvaluation["suggestedMutations"] = [];
  const rejected: Array<{ type: string; reason: string }> = [];

  for (const patch of evaluation.suggestedMutations) {
    if (PRIVILEGE_BEARING_MUTATIONS.includes(patch.type)) {
      rejected.push({
        type: patch.type,
        reason: "watcher may not propose mutations that widen permissions",
      });
      continue;
    }
    kept.push(patch);
  }
  return { kept, rejected };
}

/**
 * Recompute efficiency from measured cost rather than trusting the Watcher's
 * self-reported number, and fold it into the overall score.
 *
 * The Watcher is asked to score efficiency, but it is scoring a system whose
 * spend it only knows because we told it. Anchoring the dimension to observed
 * cost keeps the benchmark comparable across genomes.
 */
export function groundEfficiency(
  scores: WatcherEvaluation["scores"],
  costUsd: number,
  budgetUsd: number,
): WatcherEvaluation["scores"] {
  if (budgetUsd <= 0) return scores;
  const utilization = Math.min(1, costUsd / budgetUsd);
  const measured = Math.round((1 - utilization) * 1000) / 1000;
  return { ...scores, efficiency: measured };
}
