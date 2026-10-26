import { z } from "zod";
import {
  ContextSchema,
  ProposalSchema,
  ChallengeSchema,
  FalsificationSchema,
  SynthesisSchema,
  WatcherEvaluationSchema,
} from "./schemas.js";

/**
 * What the journal stores, as opposed to what a model produces.
 *
 * Every journaled stage result is model output wrapped in facts the runtime
 * established around it — which artifact row it became, what it cost, which
 * model actually served. Those facts were never covered by any schema, so a
 * replayed step could come back with `costUsd` absent and nothing would notice.
 * They are contracts now, for the same reason the model's half is: the journal
 * hands these values back to a possibly-newer build of this code.
 *
 * These deliberately do not live in `schemas.ts`. Everything in that file is a
 * *model* contract, fed through {@link jsonSchemaFor} and sent to the provider.
 * Nothing here may ever take that path: a model does not report its own cost,
 * and an envelope that reached a provider would be asking it to.
 */

/**
 * Usage as the runtime records it.
 *
 * `TokenUsage` carries an optional `cachedInputTokens`, but `callAgent` rebuilds
 * usage from the two magnitudes alone, so no stored row has ever held it and it
 * is absent here. A tripwire if that changes: unknown keys are stripped, so a
 * fresh value would carry cached tokens and its replay would silently not. The
 * field has to be added here at the same time, which `exactOptionalPropertyTypes`
 * makes awkward — `z.optional()` infers `number | undefined` where `TokenUsage`
 * declares `number`.
 *
 * Not `.int()`, and only `.min(0)` on the magnitudes: providers are not
 * contractually bound to integers, and a schema stricter than its producer
 * turns a cosmetic oddity into a re-executed step that costs real money.
 * `z.number()` already rejects NaN, and jsonb cannot hold NaN or Infinity
 * anyway — `sql.json` serializes both to null, which this then catches.
 */
export const StoredUsageSchema = z.object({
  inputTokens: z.number().min(0),
  outputTokens: z.number().min(0),
});

/** Carried by every journaled stage, whatever the stage. */
const envelope = {
  artifactId: z.string().min(1),
  usage: StoredUsageSchema,
  costUsd: z.number().min(0),
};

export const StoredContextSchema = z.object({
  context: ContextSchema,
  ...envelope,
});

export const StoredProposalSchema = z.object({
  agentId: z.string().min(1),
  proposal: ProposalSchema,
  ...envelope,
});

export const StoredChallengeSchema = z.object({
  fromAgentId: z.string().min(1),
  targetAgentId: z.string().min(1),
  /**
   * Post-processed before storage: the runtime overrides `targetAgentId` and
   * filters `objections` through `keepGroundedObjections`, so this is not
   * literally the value the model returned. It still satisfies
   * `ChallengeSchema`, which is what makes one schema serve both the call and
   * the journal — but note that `objections`' min(1) holds only because
   * `keepGroundedObjections` retains one when every objection is ungrounded.
   */
  challenge: ChallengeSchema,
  ...envelope,
});

export const StoredFalsificationSchema = z.object({
  agentId: z.string().min(1),
  targetAgentId: z.string().min(1),
  falsification: FalsificationSchema,
  ...envelope,
});

/**
 * Note the *static* `SynthesisSchema`, not `makeSynthesisSchema`.
 *
 * The scoped schema narrows source ids to the artifacts of one particular round
 * and sets a confidence floor, so it would fold the citation check in — but it
 * also makes `contested[].severity` required, where the static schema supplies
 * the default. A row stored before that field existed therefore costs a model
 * call under the scoped schema and nothing at all under this one.
 *
 * What this schema cannot carry, `runSynthesis` passes as `validateReplay`:
 * `checkSourcesResolve` and `checkDisagreementPreserved` depend on the run
 * around the value — which artifacts are in it, where the genome's
 * disagreement bar sits — so they are checked there rather than here, on
 * replayed values as well as fresh ones.
 *
 * Still not guaranteed, and worth knowing: `disagreementThreshold` is not part
 * of the synthesis step's hashed input, so lowering it in a genome does not
 * invalidate a stored synthesis the way moving `consensusThreshold` does. The
 * violation is caught at replay rather than prevented by the hash.
 */
export const StoredSynthesisSchema = z.object({
  synthesis: SynthesisSchema,
  ...envelope,
});

export const StoredWatcherSchema = z.object({
  evaluation: WatcherEvaluationSchema,
  /** Absent on rows written before the serving model was recorded. */
  modelId: z.string().min(1).optional(),
  ...envelope,
});

export type StoredUsage = z.output<typeof StoredUsageSchema>;
export type StoredContext = z.output<typeof StoredContextSchema>;
export type StoredProposal = z.output<typeof StoredProposalSchema>;
export type StoredChallenge = z.output<typeof StoredChallengeSchema>;
export type StoredFalsification = z.output<typeof StoredFalsificationSchema>;
export type StoredSynthesis = z.output<typeof StoredSynthesisSchema>;
export type StoredWatcher = z.output<typeof StoredWatcherSchema>;
