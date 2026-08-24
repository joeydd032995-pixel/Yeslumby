import { StageOutputError } from "@meta/shared";
import { runs } from "@meta/db";
import { durableStep } from "../journal.js";
import { makeSynthesisSchema, jsonSchemaFor, type Synthesis } from "../schemas.js";
import { buildPrompt, type Channel } from "../prompt.js";
import type { RunContext, StageCost } from "../context.js";
import { summarizeProposal } from "./shared.js";
import type { ProposalOutcome } from "./proposals.js";
import type { ChallengeOutcome } from "./challenges.js";
import type { FalsificationOutcome } from "./falsification.js";

/**
 * Synthesis, which must not collapse to a vote.
 *
 * Two mechanisms enforce that, because the schema alone is not enough. The
 * schema removes the *place* to put a flattened verdict — there is no
 * `answer` field, and a `contested` entry requires at least two positions. But
 * a model can still satisfy the schema by returning an empty `contested` list
 * and filing everything as high-confidence, which is majority voting with extra
 * steps.
 *
 * So the runtime independently measures how much the organization disagreed
 * during the challenge stage, and rejects a synthesis that reports no contested
 * claims when disagreement exceeded the genome's threshold. The model does not
 * get to decide whether disagreement happened; the challenge artifacts already
 * settled that.
 */

const INSTRUCTIONS = `Integrate the full argument graph into a structured result.

You are not producing a consensus. You are reporting what this organization
actually established, and what it did not.

Sort every conclusion by epistemic status:
- highConfidence: survived challenge and falsification, with evidence.
- workingHypotheses: plausible and useful, but not established.
- contested: agents reached different positions and the evidence does not settle
  which is right. Record every position with who held it and why, and rate each
  contested item minor, substantive, or fatal — the same scale the challengers
  used, judged by what turns on the question rather than how heated it got.
- unknowns: questions raised that nobody could answer.
- recommendedExperiments: what would resolve the contested items.

Rules:
- Do NOT average competing positions into a middle statement. Two agents
  disagreeing is information; a blended answer destroys it.
- Do NOT promote a claim to highConfidence because more agents asserted it.
  Agreement between agents that reasoned from the same evidence is not
  independent corroboration.
- Every claim carries sources naming the artifacts it rests on.
- A disagreement you cannot resolve belongs in contested. That is a successful
  outcome, not a failure to converge.`;

export interface SynthesisResult {
  synthesis: Synthesis;
  artifactId: string;
  replayed: boolean;
  cost: StageCost;
}

export interface SynthesisInputs {
  proposals: ProposalOutcome[];
  challenges: ChallengeOutcome[];
  falsifications: FalsificationOutcome[];
  disagreementLevel: number;
}

/**
 * Reject citations to artifacts that were never supplied.
 *
 * "Every final claim is traceable back to its evidence" is only true if the
 * citations are real. A synthesis is model output like any other, and nothing
 * in the schema stops it inventing a plausible-looking artifact id, citing one
 * from another run, or attributing a claim to material it was never shown. The
 * runtime knows exactly which artifacts fed this stage, so it checks.
 *
 * Returns a corrective instruction, or undefined when every citation resolves.
 */
export function checkSourcesResolve(
  synthesis: Synthesis,
  allowedArtifactIds: ReadonlySet<string>,
): string | undefined {
  const fabricated = new Set<string>();

  const check = (sources: ReadonlyArray<{ artifactId: string }>) => {
    for (const source of sources) {
      if (!allowedArtifactIds.has(source.artifactId)) fabricated.add(source.artifactId);
    }
  };

  for (const claim of [...synthesis.highConfidence, ...synthesis.workingHypotheses]) {
    check(claim.sources);
  }
  for (const contested of synthesis.contested) {
    for (const position of contested.positions) check(position.sources);
  }

  if (fabricated.size === 0) return undefined;

  return (
    `These source artifact ids do not exist in this run: ${[...fabricated].slice(0, 8).join(", ")}. ` +
    `Cite only the artifact ids shown in the material you were given — they appear in each ` +
    `source label. A claim you cannot attribute to supplied material belongs in unknowns.`
  );
}

/**
 * Reject a synthesis that erased real disagreement.
 *
 * Returns a corrective instruction, or undefined when the output is acceptable.
 */
export function checkDisagreementPreserved(
  synthesis: Synthesis,
  disagreementLevel: number,
  threshold: number,
): string | undefined {
  if (disagreementLevel < threshold) return undefined;
  if (synthesis.contested.length > 0) return undefined;

  return (
    `The challenge stage recorded a disagreement level of ${disagreementLevel.toFixed(2)}, ` +
    `at or above this organization's threshold of ${threshold.toFixed(2)}, but your synthesis ` +
    `reported no contested claims. Unresolved disagreement must be preserved. Re-examine the ` +
    `objections — particularly those rated substantive or fatal — and record the positions that ` +
    `were not reconciled, each with the agents holding it and the reasoning behind it.`
  );
}

export async function runSynthesis(
  ctx: RunContext,
  inputs: SynthesisInputs,
): Promise<SynthesisResult> {
  ctx.emit({ type: "stage.start", stage: "SYNTHESIS", iteration: ctx.iteration });

  const agent = ctx.genome.agents.find((a) => a.id === ctx.genome.synthesizerId);
  if (!agent) {
    throw new StageOutputError(`synthesizer "${ctx.genome.synthesizerId}" not found`, {
      stage: "SYNTHESIS",
    });
  }

  const threshold = ctx.genome.protocols.disagreementThreshold;
  const consensusThreshold = ctx.genome.protocols.consensusThreshold;

  const step = await durableStep(
    { sql: ctx.sql, runId: ctx.run.id, iteration: ctx.iteration, clock: ctx.clock },
    {
      stage: "SYNTHESIS",
      input: {
        agent,
        // Part of the input because it is part of the *contract* the output has
        // to satisfy: it sets the floor on `confidence` in the scoped schema
        // below. The journal decides whether stored output is still valid by
        // hashing this, so a synthesis recorded under a different bar — or under
        // none, before this existed — must not replay as though it still holds.
        consensusThreshold,
        proposals: inputs.proposals.map((p) => p.proposal),
        challenges: inputs.challenges.map((c) => c.challenge),
        falsifications: inputs.falsifications.map((f) => f.falsification),
        disagreementLevel: inputs.disagreementLevel,
      },
    },
    async () => {
      // Exactly the artifacts this stage was shown. Any citation outside this
      // set is fabricated, whatever it looks like.
      const allowedArtifactIds = new Set<string>([
        ...inputs.proposals.map((p) => p.artifactId),
        ...inputs.challenges.map((c) => c.artifactId),
        ...inputs.falsifications.map((f) => f.artifactId),
      ]);

      // Citations are constrained to these ids in the schema itself, so a
      // fabricated reference cannot be generated in the first place.
      const scopedSchema = makeSynthesisSchema([...allowedArtifactIds], consensusThreshold);

      const channels = buildSynthesisChannels(inputs);
      const built = buildPrompt({
        stageInstructions: INSTRUCTIONS,
        channels: [
          {
            kind: "GENOME_DIRECTIVE",
            note: `role of ${agent.name}`,
            items: [{ source: agent.id, content: agent.systemPrompt }],
          },
          ...channels,
        ],
        seed: ctx.run.seed,
        callId: `${ctx.iteration}:SYNTHESIS`,
      });

      const jsonSchema = jsonSchemaFor(scopedSchema);
      let correction: string | undefined;
      let usage = { inputTokens: 0, outputTokens: 0 };
      let costUsd = 0;

      // Up to three attempts: schema failure and disagreement-erasure are both
      // recoverable with a targeted correction.
      for (let attempt = 1; attempt <= 3; attempt++) {
        const prompt = correction
          ? `${built.prompt}\n\n# CORRECTION (trusted)\n\n${correction}`
          : built.prompt;

        const response = await ctx.gateway.generate({
          modelId: agent.model.primary,
          fallbacks: agent.model.fallbacks,
          system: built.system,
          prompt,
          temperature: agent.model.temperature,
          maxOutputTokens: agent.model.maxOutputTokens,
          jsonSchema,
          seed: `${ctx.run.seed}:${ctx.iteration}:SYNTHESIS:${attempt}`,
          attribution: { ...ctx.attribution, agentId: agent.id, stage: "SYNTHESIS" },
        });

        usage = {
          inputTokens: usage.inputTokens + response.usage.inputTokens,
          outputTokens: usage.outputTokens + response.usage.outputTokens,
        };
        costUsd += response.costUsd;

        const parsed = scopedSchema.safeParse(response.json);
        if (!parsed.success) {
          correction =
            `Your output did not satisfy the required contract: ` +
            parsed.error.issues
              .slice(0, 5)
              .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
              .join("; ");
          if (attempt === 3) {
            throw new StageOutputError("synthesis violated its output contract", {
              stage: "SYNTHESIS",
              issues: correction,
            });
          }
          continue;
        }

        const erasure = checkDisagreementPreserved(
          parsed.data,
          inputs.disagreementLevel,
          threshold,
        );
        if (erasure) {
          correction = erasure;
          if (attempt === 3) {
            throw new StageOutputError(
              "synthesis erased disagreement that the challenge stage recorded",
              {
                stage: "SYNTHESIS",
                disagreementLevel: inputs.disagreementLevel,
                threshold,
              },
            );
          }
          continue;
        }

        const fabricated = checkSourcesResolve(parsed.data, allowedArtifactIds);
        if (fabricated) {
          correction = fabricated;
          if (attempt === 3) {
            throw new StageOutputError("synthesis cited artifacts that do not exist in this run", {
              stage: "SYNTHESIS",
              detail: fabricated,
            });
          }
          continue;
        }

        const artifact = await runs.insertArtifact(ctx.sql, {
          id: ctx.ids.next("artifact"),
          runId: ctx.run.id,
          iteration: ctx.iteration,
          stage: "SYNTHESIS",
          agentId: agent.id,
          kind: "SYNTHESIS",
          content: parsed.data,
          modelId: response.modelId,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd,
          latencyMs: response.latencyMs,
          // Provenance: synthesis descends from every artifact that fed it.
          parentArtifactIds: [
            ...inputs.proposals.map((p) => p.artifactId),
            ...inputs.challenges.map((c) => c.artifactId),
            ...inputs.falsifications.map((f) => f.artifactId),
          ],
        });

        return { synthesis: parsed.data, artifactId: artifact.id, usage, costUsd };
      }

      throw new StageOutputError("synthesis exhausted attempts", { stage: "SYNTHESIS" });
    },
  );

  ctx.emit({
    type: "stage.finish",
    stage: "SYNTHESIS",
    iteration: ctx.iteration,
    replayed: step.replayed,
  });

  return {
    synthesis: step.value.synthesis,
    artifactId: step.value.artifactId,
    replayed: step.replayed,
    cost: { usage: step.value.usage, costUsd: step.value.costUsd },
  };
}

function buildSynthesisChannels(inputs: SynthesisInputs): Channel[] {
  const channels: Channel[] = [
    {
      kind: "PEER_OUTPUT",
      note: "independent proposals — each produced without seeing the others",
      items: inputs.proposals.map((p) => ({
        source: `${p.agentId} (artifact ${p.artifactId})`,
        content: summarizeProposal(p.proposal),
      })),
    },
  ];

  if (inputs.challenges.length > 0) {
    channels.push({
      kind: "PEER_OUTPUT",
      note: "objections raised, with the challenger's stated agreement level",
      items: inputs.challenges.map((c) => ({
        source: `${c.fromAgentId} → ${c.targetAgentId} (artifact ${c.artifactId})`,
        content:
          `agreementScore: ${c.challenge.agreementScore.toFixed(2)}\n` +
          c.challenge.objections
            .map((o) => `[${o.severity}] on ${o.targetClaimId}: ${o.objection} — ${o.reasoning}`)
            .join("\n") +
          (c.challenge.concessions.length
            ? `\nconceded: ${c.challenge.concessions.join("; ")}`
            : ""),
      })),
    });
  }

  if (inputs.falsifications.length > 0) {
    channels.push({
      kind: "PEER_OUTPUT",
      note: "falsification analysis",
      items: inputs.falsifications.map((f) => ({
        source: `${f.agentId} on ${f.targetAgentId} (artifact ${f.artifactId})`,
        content:
          `verdict: ${f.falsification.verdict}\n` +
          `predictions: ${f.falsification.falsifiablePredictions.join("; ")}\n` +
          `disconfirming: ${f.falsification.disconfirmingEvidence.join("; ")}`,
      })),
    });
  }

  return channels;
}
