import type { z } from "zod";
import { StageOutputError, zeroUsage, type TokenUsage } from "@meta/shared";
import { runs } from "@meta/db";
import type { AgentSpec } from "@meta/genome";
import type { ArtifactKind } from "@meta/db";
import { buildPrompt, type Channel } from "../prompt.js";
import { jsonSchemaFor } from "../schemas.js";
import type { RunContext } from "../context.js";

/**
 * One model call by one agent, validated, recorded, and attributed.
 *
 * Structured output is requested via JSON Schema and then validated against the
 * Zod contract. A response that parses as JSON but violates the contract gets
 * exactly one corrective retry — enough to recover from a model that omitted a
 * required field, without letting a stage spin.
 */

export interface AgentCallInput<S extends z.ZodType> {
  agent: AgentSpec;
  stage: string;
  kind: ArtifactKind;
  /** Distinguishes calls within a stage, e.g. `skeptic->empiricist`. */
  callId: string;
  stageInstructions: string;
  channels: Channel[];
  schema: S;
  parentArtifactIds?: string[];
}

export interface AgentCallResult<T> {
  value: T;
  artifactId: string;
  usage: TokenUsage;
  costUsd: number;
  latencyMs: number;
  modelId: string;
  /** The assembled prompt, retained so tests can assert on isolation. */
  prompt: { system: string; prompt: string; nonce: string };
}

export async function callAgent<S extends z.ZodType>(
  ctx: RunContext,
  input: AgentCallInput<S>,
): Promise<AgentCallResult<z.output<S>>> {
  const seed = `${ctx.run.seed}:${ctx.iteration}:${input.callId}`;

  const directive: Channel = {
    kind: "GENOME_DIRECTIVE",
    note: `role of ${input.agent.name}`,
    items: [{ source: input.agent.id, content: input.agent.systemPrompt }],
  };

  const built = buildPrompt({
    stageInstructions: input.stageInstructions,
    channels: [directive, ...input.channels],
    seed: ctx.run.seed,
    callId: `${ctx.iteration}:${input.callId}`,
  });

  const jsonSchema = jsonSchemaFor(input.schema);

  let lastIssue: string | undefined;
  let totalUsage: TokenUsage = zeroUsage();
  let totalCost = 0;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt =
      attempt === 1
        ? built.prompt
        : `${built.prompt}\n\n# CORRECTION (trusted)\n\nYour previous response did not satisfy the required output contract: ${lastIssue}\nReturn only JSON matching the schema.`;

    const response = await ctx.gateway.generate({
      modelId: input.agent.model.primary,
      fallbacks: input.agent.model.fallbacks,
      system: built.system,
      prompt,
      temperature: input.agent.model.temperature,
      maxOutputTokens: input.agent.model.maxOutputTokens,
      jsonSchema,
      seed: attempt === 1 ? seed : `${seed}:retry`,
      attribution: { ...ctx.attribution, agentId: input.agent.id, stage: input.stage },
    });

    totalUsage = {
      inputTokens: totalUsage.inputTokens + response.usage.inputTokens,
      outputTokens: totalUsage.outputTokens + response.usage.outputTokens,
    };
    totalCost += response.costUsd;

    const parsed = input.schema.safeParse(response.json);
    if (!parsed.success) {
      lastIssue = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      if (attempt === 2) {
        throw new StageOutputError(
          `${input.agent.id} produced output violating the ${input.stage} contract`,
          { stage: input.stage, agentId: input.agent.id, issues: lastIssue },
        );
      }
      continue;
    }

    const artifact = await runs.insertArtifact(ctx.sql, {
      id: ctx.ids.next("artifact"),
      runId: ctx.run.id,
      iteration: ctx.iteration,
      stage: input.stage,
      agentId: input.agent.id,
      kind: input.kind,
      content: parsed.data as unknown,
      modelId: response.modelId,
      inputTokens: totalUsage.inputTokens,
      outputTokens: totalUsage.outputTokens,
      costUsd: totalCost,
      latencyMs: response.latencyMs,
      parentArtifactIds: input.parentArtifactIds ?? [],
    });

    return {
      value: parsed.data as z.output<S>,
      artifactId: artifact.id,
      usage: totalUsage,
      costUsd: totalCost,
      latencyMs: response.latencyMs,
      modelId: response.modelId,
      prompt: built,
    };
  }

  // Unreachable: the loop either returns or throws on attempt 2.
  throw new StageOutputError(`${input.stage} exhausted attempts`, { stage: input.stage });
}

/** Render a claim list as fenced peer material. */
export function summarizeProposal(value: {
  summary: string;
  claims: Array<{ id: string; text: string; confidence: number }>;
}): string {
  const claims = value.claims
    .map((c) => `- [${c.id}] (confidence ${c.confidence.toFixed(2)}) ${c.text}`)
    .join("\n");
  return `${value.summary}\n\nClaims:\n${claims}`;
}

export const addCost = (a: { usage: TokenUsage; costUsd: number }, b: { usage: TokenUsage; costUsd: number }) => ({
  usage: {
    inputTokens: a.usage.inputTokens + b.usage.inputTokens,
    outputTokens: a.usage.outputTokens + b.usage.outputTokens,
  },
  costUsd: a.costUsd + b.costUsd,
});
