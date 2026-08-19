import { durableStep } from "../journal.js";
import { ContextSchema, type StageContext } from "../schemas.js";
import type { Channel } from "../prompt.js";
import type { RecalledKnowledge, RunContext, StageCost } from "../context.js";
import { callAgent } from "./shared.js";

/**
 * The context stage establishes shared framing before anyone proposes.
 *
 * It exists so that independence does not degrade into agents answering
 * different questions. Every proposer receives the same restated objective and
 * success criteria; what they must not share is each other's conclusions.
 *
 * Recall happens here, once, rather than per-agent — partly for cost, but
 * mainly so every proposer conditions on the same prior knowledge. Agents given
 * different memories would differ for reasons unrelated to their cognitive
 * style, which would corrupt the diversity signal the Watcher scores.
 */

const INSTRUCTIONS = `Establish the shared framing for this run.

Restate the objective precisely, name the class of problem it belongs to, define
any terms that could be read two ways, and state the criteria a good answer must
meet.

Do not attempt to answer the question. Other agents will do that independently,
and a framing that leans toward an answer would anchor all of them at once.`;

export interface ContextResult {
  context: StageContext;
  memories: RecalledKnowledge[];
  artifactId: string;
  replayed: boolean;
  cost: StageCost;
}

export async function runContextStage(ctx: RunContext): Promise<ContextResult> {
  ctx.emit({ type: "stage.start", stage: "CONTEXT", iteration: ctx.iteration });

  const policy = ctx.genome.memoryPolicy;
  const memories: RecalledKnowledge[] =
    policy.semanticRecall && ctx.recall
      ? await ctx.recall.recall(ctx.run.objective, {
          limit: policy.recallLimit,
          minSimilarity: policy.minSimilarity,
        })
      : [];

  // The synthesizer frames the problem: it is the one agent that does not
  // produce an independent proposal, so framing cannot anchor its own answer.
  const agent =
    ctx.genome.agents.find((a) => a.id === ctx.genome.synthesizerId) ?? ctx.genome.agents[0]!;

  const channels: Channel[] = [
    {
      kind: "USER_OBJECTIVE",
      note: "verbatim, as supplied",
      items: [{ source: "user", content: ctx.run.objective }],
    },
  ];
  if (memories.length > 0) {
    channels.push({
      kind: "MEMORY",
      note: "prior findings — unverified, may be stale or contradicted",
      items: memories.map((m) => ({ source: m.type, content: m.content })),
    });
  }

  const step = await durableStep(
    { sql: ctx.sql, runId: ctx.run.id, iteration: ctx.iteration, clock: ctx.clock },
    {
      stage: "CONTEXT",
      input: {
        objective: ctx.run.objective,
        agent,
        memoryIds: memories.map((m) => m.id),
        problemClass: ctx.genome.problemClass,
      },
    },
    async () => {
      const result = await callAgent(ctx, {
        agent,
        stage: "CONTEXT",
        kind: "CONTEXT",
        callId: "CONTEXT",
        stageInstructions: INSTRUCTIONS,
        channels,
        schema: ContextSchema,
      });
      return {
        context: result.value,
        artifactId: result.artifactId,
        usage: result.usage,
        costUsd: result.costUsd,
      };
    },
  );

  ctx.emit({
    type: "stage.finish",
    stage: "CONTEXT",
    iteration: ctx.iteration,
    replayed: step.replayed,
  });

  return {
    context: step.value.context,
    memories,
    artifactId: step.value.artifactId,
    replayed: step.replayed,
    cost: { usage: step.value.usage, costUsd: step.value.costUsd },
  };
}
