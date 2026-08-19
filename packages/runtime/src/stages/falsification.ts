import { zeroUsage } from "@meta/shared";
import { durableStep } from "../journal.js";
import { FalsificationSchema, type Falsification } from "../schemas.js";
import type { RunContext, StageCost } from "../context.js";
import { addCost, callAgent, summarizeProposal } from "./shared.js";
import type { ProposalOutcome } from "./proposals.js";
import type { ChallengeOutcome } from "./challenges.js";

/**
 * Falsification — a separate stage from critique, on purpose.
 *
 * Critique asks "what is weak about this argument?" Falsification asks a
 * different and harder question: "what observation would show this is wrong?"
 * An account can survive extensive critique and still be unfalsifiable, which
 * is a defect the challenge stage structurally cannot surface. Keeping them
 * apart means the organization has to answer both.
 *
 * The output schema requires at least one falsifiable prediction, one
 * disconfirming observation, and one concrete test per surviving proposal, so
 * "nothing would change my mind" is not an available answer — it can only be
 * reported as the `unfalsifiable` verdict, which is itself a finding.
 */

const INSTRUCTIONS = `For the analysis you have been shown, state what would prove it wrong.

This is not a critique. Do not restate objections. Answer the specific question:
under what observation would this account have to be abandoned?

Requirements:
- falsifiablePredictions: things that must be true if the account holds, stated
  so they could fail.
- disconfirmingEvidence: observations that would count against it. "None" is not
  an acceptable answer — if you genuinely cannot name any, return the verdict
  'unfalsifiable', which is a finding about the account, not a failure by you.
- concreteTests: something an investigator could actually run, each paired with
  what result would falsify the claim.
- verdict: 'falsifiable', 'unfalsifiable', or 'already-contradicted' if the
  challenges already produced disconfirming evidence.`;

export interface FalsificationOutcome {
  agentId: string;
  targetAgentId: string;
  artifactId: string;
  falsification: Falsification;
  replayed: boolean;
}

export interface FalsificationResult {
  falsifications: FalsificationOutcome[];
  cost: StageCost;
}

/**
 * Choose who falsifies.
 *
 * An adversarial or critical agent is preferred, since the task suits that
 * disposition, but never the proposal's own author — self-falsification is the
 * same anchoring problem the proposal stage exists to avoid.
 */
export function selectFalsifier(
  ctx: RunContext,
  targetAgentId: string,
): { id: string } | undefined {
  const candidates = ctx.genome.agents.filter((a) => a.id !== targetAgentId);
  if (candidates.length === 0) return undefined;
  return (
    candidates.find((a) => a.cognitiveMode === "adversarial") ??
    candidates.find((a) => a.cognitiveMode === "critical") ??
    candidates.find((a) => a.id === ctx.genome.synthesizerId) ??
    candidates[0]
  );
}

export async function runFalsification(
  ctx: RunContext,
  proposals: ProposalOutcome[],
  challenges: ChallengeOutcome[],
): Promise<FalsificationResult> {
  ctx.emit({ type: "stage.start", stage: "FALSIFICATION", iteration: ctx.iteration });

  const settled = await Promise.all(
    proposals.map(async (target) => {
      const pick = selectFalsifier(ctx, target.agentId);
      const agent = pick ? ctx.genome.agents.find((a) => a.id === pick.id) : undefined;
      if (!agent) return undefined;

      const related = challenges.filter((c) => c.targetAgentId === target.agentId);

      ctx.emit({ type: "agent.start", stage: "FALSIFICATION", agentId: agent.id });

      const step = await durableStep(
        { sql: ctx.sql, runId: ctx.run.id, iteration: ctx.iteration, clock: ctx.clock },
        {
          stage: "FALSIFICATION",
          unitId: target.agentId,
          input: {
            agent,
            target: target.proposal,
            challenges: related.map((c) => c.challenge),
          },
        },
        async () => {
          const result = await callAgent(ctx, {
            agent,
            stage: "FALSIFICATION",
            kind: "FALSIFICATION",
            callId: `FALSIFICATION:${target.agentId}`,
            stageInstructions: INSTRUCTIONS,
            channels: [
              {
                kind: "PEER_OUTPUT",
                note: `analysis under test, by ${target.agentId}`,
                items: [
                  { source: target.agentId, content: summarizeProposal(target.proposal) },
                ],
              },
              ...(related.length > 0
                ? [
                    {
                      kind: "PEER_OUTPUT" as const,
                      note: "objections already raised against it",
                      items: related.map((c) => ({
                        source: c.fromAgentId,
                        content: c.challenge.objections
                          .map((o) => `[${o.severity}] ${o.objection} — ${o.reasoning}`)
                          .join("\n"),
                      })),
                    },
                  ]
                : []),
            ],
            schema: FalsificationSchema,
            parentArtifactIds: [target.artifactId, ...related.map((c) => c.artifactId)],
          });

          return {
            agentId: agent.id,
            targetAgentId: target.agentId,
            artifactId: result.artifactId,
            falsification: { ...result.value, targetAgentId: target.agentId },
            usage: result.usage,
            costUsd: result.costUsd,
          };
        },
      );

      ctx.emit({
        type: "agent.finish",
        stage: "FALSIFICATION",
        agentId: agent.id,
        costUsd: step.value.costUsd,
        latencyMs: step.latencyMs,
        replayed: step.replayed,
      });

      return { ...step.value, replayed: step.replayed };
    }),
  );

  const results = settled.filter((s): s is NonNullable<typeof s> => s !== undefined);

  const cost = results.reduce(
    (acc, r) => addCost(acc, { usage: r.usage, costUsd: r.costUsd }),
    { usage: zeroUsage(), costUsd: 0 },
  );

  ctx.emit({
    type: "stage.finish",
    stage: "FALSIFICATION",
    iteration: ctx.iteration,
    replayed: results.every((r) => r.replayed),
  });

  return {
    falsifications: results.map(({ usage: _u, costUsd: _c, ...rest }) => rest),
    cost,
  };
}
