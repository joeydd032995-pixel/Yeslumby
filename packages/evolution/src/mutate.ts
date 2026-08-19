import {
  applyPatches,
  diffGenomes,
  hashGenome,
  isEmptyDiff,
  type ArchitectureGenome,
  type MutationPatchInput,
} from "@meta/genome";
import { genomes, mutations, type Sql } from "@meta/db";
import { MutationPolicyError, type IdGenerator } from "@meta/shared";
import { consolidateStructural, type ConsolidationDeps } from "@meta/memory";

/**
 * The mutation engine.
 *
 * A mutation is always a proposal first and an applied version second, and the
 * two are separate rows in separate states. That separation is what makes the
 * approval gate meaningful: a patch set that a human has not approved exists,
 * is inspectable, and has not touched the lineage.
 *
 * Nothing here ever edits a genome. Every path produces a *new* immutable
 * version whose parent is the version it came from, so rollback is selecting an
 * older version rather than undoing anything.
 */

export type MutationResult =
  | {
      status: "applied";
      mutationId: string;
      versionId: string;
      version: number;
      genome: ArchitectureGenome;
      diff: ReturnType<typeof diffGenomes>;
    }
  | { status: "awaiting_approval"; mutationId: string }
  | { status: "rejected"; mutationId: string; reason: string }
  | { status: "no_op"; reason: string };

export interface MutationDeps {
  sql: Sql;
  ids: IdGenerator;
  /** Supply to record what the mutation taught the ecosystem about itself. */
  memory?: Omit<ConsolidationDeps, "ids"> & { ids?: IdGenerator };
}

export interface ProposeMutationInput {
  ecosystemId: string;
  fromVersionId: string;
  genome: ArchitectureGenome;
  patches: readonly MutationPatchInput[];
  actor: "WATCHER" | "HUMAN" | "BREEDING";
  runId?: string | null;
  rationale?: string;
  /** True when a human has explicitly approved this patch set. */
  humanApproved?: boolean;
  createdBy?: string | null;
}

export async function proposeAndApplyMutation(
  deps: MutationDeps,
  input: ProposeMutationInput,
): Promise<MutationResult> {
  if (input.patches.length === 0) {
    return { status: "no_op", reason: "no patches proposed" };
  }

  const policy = input.genome.mutationPolicy;
  const needsApproval =
    input.actor === "WATCHER" && policy.humanApprovalRequired && !input.humanApproved;

  const mutationId = deps.ids.next("mutation");
  await mutations.proposeMutation(deps.sql, {
    id: mutationId,
    ecosystemId: input.ecosystemId,
    runId: input.runId ?? null,
    fromVersionId: input.fromVersionId,
    patches: input.patches,
    rationale: input.rationale ?? null,
    proposedBy: input.actor,
    status: needsApproval ? "PROPOSED" : "APPROVED",
  });

  if (needsApproval) {
    // Recorded and inspectable, but the lineage is untouched until a human
    // decides. This is the state the approval queue reads.
    return { status: "awaiting_approval", mutationId };
  }

  let mutated: ArchitectureGenome;
  try {
    mutated = applyPatches(input.genome, input.patches, {
      actor: input.actor,
      ...(input.humanApproved !== undefined ? { humanApproved: input.humanApproved } : {}),
    }).genome;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await mutations.rejectMutation(deps.sql, mutationId, reason);
    // Policy violations are recorded, not swallowed: a Watcher repeatedly
    // proposing forbidden patches is itself a signal worth seeing.
    if (error instanceof MutationPolicyError) {
      return { status: "rejected", mutationId, reason };
    }
    throw error;
  }

  const diff = diffGenomes(input.genome, mutated);
  if (isEmptyDiff(diff)) {
    await mutations.rejectMutation(deps.sql, mutationId, "patches produced no change");
    return { status: "no_op", reason: "patches produced no change" };
  }

  const { version, created } = await genomes.createGenomeVersion(deps.sql, {
    id: deps.ids.next("genomeVersion"),
    ecosystemId: input.ecosystemId,
    genomeHash: hashGenome(mutated),
    genome: mutated,
    parentIds: [input.fromVersionId],
    origin: input.actor === "BREEDING" ? "BREEDING" : "MUTATION",
    createdBy: input.createdBy ?? null,
  });

  await mutations.markMutationApplied(deps.sql, mutationId, version.id);

  if (!created) {
    // The patches reproduced a genome this ecosystem already has. Recording it
    // as a MUTATION_OUTCOME is what stops the engine proposing it a third time.
    await recordOutcome(deps, input, mutated, "reverted to an existing genome version");
    return {
      status: "applied",
      mutationId,
      versionId: version.id,
      version: version.version,
      genome: mutated,
      diff,
    };
  }

  await recordOutcome(deps, input, mutated, describeDiff(diff));

  return {
    status: "applied",
    mutationId,
    versionId: version.id,
    version: version.version,
    genome: mutated,
    diff,
  };
}

/**
 * Apply a mutation a human has since approved.
 *
 * Re-reads the proposal rather than trusting a caller-supplied patch set: the
 * thing approved must be the thing applied.
 */
export async function applyApprovedMutation(
  deps: MutationDeps,
  input: {
    mutationId: string;
    ecosystemId: string;
    genome: ArchitectureGenome;
    approvedBy?: string | null;
  },
): Promise<MutationResult> {
  const record = await mutations.getMutation(deps.sql, input.mutationId);
  if (!record) return { status: "no_op", reason: "mutation not found" };
  if (record.status === "APPLIED") {
    return { status: "no_op", reason: "mutation already applied" };
  }
  if (record.status === "REJECTED") {
    return { status: "rejected", mutationId: record.id, reason: "mutation was rejected" };
  }

  await mutations.approveMutation(deps.sql, record.id, input.approvedBy ?? null);

  return proposeAndApplyMutation(deps, {
    ecosystemId: input.ecosystemId,
    fromVersionId: record.from_version_id,
    genome: input.genome,
    patches: record.patches as MutationPatchInput[],
    actor: record.proposed_by,
    runId: record.run_id,
    ...(record.rationale !== null ? { rationale: record.rationale } : {}),
    humanApproved: true,
    createdBy: input.approvedBy ?? null,
  });
}

/** Point an ecosystem at a version. Rollback is this, with an older version. */
export async function promoteVersion(
  sql: Sql,
  ecosystemId: string,
  versionId: string,
): Promise<void> {
  await genomes.setCurrentGenomeVersion(sql, ecosystemId, versionId);
}

async function recordOutcome(
  deps: MutationDeps,
  input: ProposeMutationInput,
  mutated: ArchitectureGenome,
  summary: string,
): Promise<void> {
  if (!deps.memory) return;
  await consolidateStructural(
    { ...deps.memory, ids: deps.memory.ids ?? deps.ids },
    [
      {
        content:
          `Mutation by ${input.actor} on "${input.genome.name}": ${summary}. ` +
          `Rationale: ${input.rationale ?? "not stated"}.`,
        type: "MUTATION_OUTCOME",
        problemClass: mutated.problemClass,
        importance: 0.7,
        sourceRunId: input.runId ?? null,
      },
    ],
  );
}

export function describeDiff(diff: ReturnType<typeof diffGenomes>): string {
  const parts: string[] = [];
  if (diff.agentsAdded.length) parts.push(`added ${diff.agentsAdded.join(", ")}`);
  if (diff.agentsRemoved.length) parts.push(`removed ${diff.agentsRemoved.join(", ")}`);
  if (diff.agentsChanged.length) {
    parts.push(
      `changed ${diff.agentsChanged.map((a) => `${a.id}(${a.fields.join("/")})`).join(", ")}`,
    );
  }
  if (diff.edgesAdded.length) parts.push(`+${diff.edgesAdded.length} edges`);
  if (diff.edgesRemoved.length) parts.push(`-${diff.edgesRemoved.length} edges`);
  if (diff.protocolChanges.length) {
    parts.push(`protocols ${diff.protocolChanges.map((p) => p.key).join(", ")}`);
  }
  if (diff.watcherChanged) parts.push("watcher config");
  if (diff.memoryPolicyChanged) parts.push("memory policy");
  if (diff.stopCriteriaChanged) parts.push("stop criteria");
  return parts.length ? parts.join("; ") : "no structural change";
}
