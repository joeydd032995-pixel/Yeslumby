import { zeroUsage } from "@meta/shared";
import type { AgentSpec } from "@meta/genome";
import { durableStep } from "../journal.js";
import { ProposalSchema, type Proposal, type StageContext } from "../schemas.js";
import type { Channel } from "../prompt.js";
import type { RecalledKnowledge, RunContext, StageCost } from "../context.js";
import { addCost, callAgent } from "./shared.js";

/**
 * Independent proposal fan-out.
 *
 * No agent may see another agent's proposal until the whole stage completes.
 * That is enforced by the shape of {@link ProposalInputs}, not by discipline:
 * there is no field on it through which peer output could travel, and
 * `buildProposalChannels` accepts nothing else. Adding peer visibility here
 * would require changing this type, which is a reviewable act rather than an
 * accident.
 *
 * The reason is anchoring. Agents shown a peer's answer converge on it,
 * including on its errors, and the resulting agreement looks like corroboration
 * while carrying none of its evidential weight. Independence is what makes the
 * later challenge stage informative.
 */

/**
 * Everything a proposing agent is allowed to condition on.
 *
 * Deliberately closed. Note the absence of any `peers`, `priorProposals`, or
 * `otherAgents` member.
 */
export interface ProposalInputs {
  objective: string;
  context: StageContext;
  memories: RecalledKnowledge[];
}

export function buildProposalChannels(inputs: ProposalInputs): Channel[] {
  const channels: Channel[] = [
    {
      kind: "USER_OBJECTIVE",
      note: "what the user asked for",
      items: [{ source: "user", content: inputs.objective }],
    },
    {
      kind: "USER_OBJECTIVE",
      note: "shared framing",
      items: [
        {
          source: "context-stage",
          content:
            `Restated objective: ${inputs.context.restatedObjective}\n` +
            `Problem class: ${inputs.context.problemClass}\n` +
            `Success criteria:\n${inputs.context.successCriteria.map((c) => `- ${c}`).join("\n")}`,
        },
      ],
    },
  ];

  if (inputs.memories.length > 0) {
    channels.push({
      kind: "MEMORY",
      note: "recalled knowledge — treat as unverified prior findings",
      items: inputs.memories.map((m) => ({
        source: `${m.type} (similarity ${m.similarity.toFixed(2)})`,
        content: m.content,
      })),
    });
  }

  return channels;
}

const INSTRUCTIONS = `Produce your own independent analysis of the objective.

You are answering alone. You have not been shown any other agent's work, and you
should not speculate about what others might say or try to pre-empt them —
your value to this organization is an position arrived at independently.

Requirements:
- State each substantive claim separately, with a stable id and a confidence in [0,1].
- Give the evidence or reasoning for each claim. An unsupported claim should
  carry low confidence and say what would raise it.
- List the assumptions your account depends on.
- List what you could not determine. An explicit unknown is more useful than a
  confident guess, and will be scored as such.`;

export interface ProposalOutcome {
  agentId: string;
  artifactId: string;
  proposal: Proposal;
  replayed: boolean;
}

export interface ProposalsResult {
  proposals: ProposalOutcome[];
  cost: StageCost;
}

export async function runProposals(
  ctx: RunContext,
  inputs: ProposalInputs,
): Promise<ProposalsResult> {
  const proposers = ctx.genome.agents.filter((a) => a.proposes);
  ctx.emit({ type: "stage.start", stage: "PROPOSALS", iteration: ctx.iteration });

  // Genuinely concurrent. Each agent's call is journaled separately, so a
  // failure part-way through this stage replays the completed ones on resume.
  const settled = await Promise.all(
    proposers.map((agent) => proposeOne(ctx, agent, inputs)),
  );

  const cost = settled.reduce(
    (acc, s) => addCost(acc, { usage: s.usage, costUsd: s.costUsd }),
    { usage: zeroUsage(), costUsd: 0 },
  );

  ctx.emit({
    type: "stage.finish",
    stage: "PROPOSALS",
    iteration: ctx.iteration,
    replayed: settled.every((s) => s.replayed),
  });

  return {
    proposals: settled.map((s) => ({
      agentId: s.agentId,
      artifactId: s.artifactId,
      proposal: s.proposal,
      replayed: s.replayed,
    })),
    cost,
  };
}

async function proposeOne(ctx: RunContext, agent: AgentSpec, inputs: ProposalInputs) {
  ctx.emit({ type: "agent.start", stage: "PROPOSALS", agentId: agent.id });

  const step = await durableStep(
    { sql: ctx.sql, runId: ctx.run.id, iteration: ctx.iteration, clock: ctx.clock },
    {
      stage: "PROPOSALS",
      unitId: agent.id,
      // The input hash covers the agent's own definition and the shared
      // framing. Change either and this step recomputes; change a peer and it
      // does not, because a peer cannot affect an independent proposal.
      input: {
        agent,
        objective: inputs.objective,
        context: inputs.context,
        memoryIds: inputs.memories.map((m) => m.id),
      },
    },
    async () => {
      const result = await callAgent(ctx, {
        agent,
        stage: "PROPOSALS",
        kind: "PROPOSAL",
        callId: `PROPOSALS:${agent.id}`,
        stageInstructions: INSTRUCTIONS,
        channels: buildProposalChannels(inputs),
        schema: ProposalSchema,
      });
      return {
        agentId: agent.id,
        artifactId: result.artifactId,
        proposal: result.value,
        usage: result.usage,
        costUsd: result.costUsd,
      };
    },
  );

  ctx.emit({
    type: "agent.finish",
    stage: "PROPOSALS",
    agentId: agent.id,
    costUsd: step.value.costUsd,
    latencyMs: step.latencyMs,
    replayed: step.replayed,
  });

  return { ...step.value, replayed: step.replayed };
}
