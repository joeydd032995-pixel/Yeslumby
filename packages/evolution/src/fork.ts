import { genomes, tenancy, type Sql } from "@meta/db";
import { hashGenome, parseGenome, type ArchitectureGenome } from "@meta/genome";
import type { IdGenerator } from "@meta/shared";

/**
 * Forking an ecosystem.
 *
 * A fork copies a genome into a new ecosystem and records permanent lineage in
 * both directions: the new ecosystem knows its source, and the source's version
 * is a parent of the fork's seed version. Lineage is recorded rather than
 * inferred, because the source ecosystem may later be deleted or made private
 * and attribution should survive that.
 *
 * Only the genome is copied. Runs, memories, and benchmark history stay with
 * the original — a fork inherits an architecture, not someone else's evidence.
 */

export interface ForkInput {
  sourceEcosystemId: string;
  sourceVersionId: string;
  targetWorkspaceId: string;
  name: string;
  slug: string;
  description?: string | null;
  createdBy?: string | null;
  visibility?: "private" | "public";
}

export interface ForkResult {
  ecosystemId: string;
  versionId: string;
  genome: ArchitectureGenome;
}

export async function forkEcosystem(
  deps: { sql: Sql; ids: IdGenerator },
  input: ForkInput,
): Promise<ForkResult> {
  const source = await genomes.getGenomeVersion(deps.sql, input.sourceVersionId);
  if (!source) throw new Error(`genome version ${input.sourceVersionId} not found`);
  if (source.ecosystem_id !== input.sourceEcosystemId) {
    throw new Error("genome version does not belong to the source ecosystem");
  }

  // Re-parse rather than trusting the stored blob: a genome written under an
  // older schema must be brought up to current shape before it runs.
  const genome = parseGenome(source.genome);

  const ecosystemId = deps.ids.next("ecosystem");
  await genomes.createEcosystem(deps.sql, {
    id: ecosystemId,
    workspaceId: input.targetWorkspaceId,
    name: input.name,
    slug: input.slug,
    description: input.description ?? null,
    visibility: input.visibility ?? "private",
    forkedFromEcosystemId: input.sourceEcosystemId,
    forkedFromVersionId: input.sourceVersionId,
    createdBy: input.createdBy ?? null,
  });

  const { version } = await genomes.createGenomeVersion(deps.sql, {
    id: deps.ids.next("genomeVersion"),
    ecosystemId,
    genomeHash: hashGenome(genome),
    genome,
    // The source version is a real parent, so the evolution graph spans the
    // fork boundary instead of the copy appearing to arise from nothing.
    parentIds: [input.sourceVersionId],
    origin: "FORK",
    createdBy: input.createdBy ?? null,
  });

  await genomes.setCurrentGenomeVersion(deps.sql, ecosystemId, version.id);

  const orgId = await tenancy.getOrgIdForEcosystem(deps.sql, ecosystemId);
  await tenancy.writeAuditEntry(deps.sql, {
    id: deps.ids.next("auditEntry"),
    orgId: orgId ?? null,
    actorUserId: input.createdBy ?? null,
    action: "ecosystem.fork",
    subjectType: "ecosystem",
    subjectId: ecosystemId,
    metadata: {
      sourceEcosystemId: input.sourceEcosystemId,
      sourceVersionId: input.sourceVersionId,
    },
  });

  return { ecosystemId, versionId: version.id, genome };
}

/** Register a bred candidate as a new version with both parents recorded. */
export async function materializeChild(
  deps: { sql: Sql; ids: IdGenerator },
  input: {
    ecosystemId: string;
    genome: ArchitectureGenome;
    parentVersionIds: string[];
    createdBy?: string | null;
  },
): Promise<{ versionId: string; version: number; created: boolean }> {
  const { version, created } = await genomes.createGenomeVersion(deps.sql, {
    id: deps.ids.next("genomeVersion"),
    ecosystemId: input.ecosystemId,
    genomeHash: hashGenome(input.genome),
    genome: input.genome,
    parentIds: input.parentVersionIds,
    origin: "BREEDING",
    createdBy: input.createdBy ?? null,
  });
  return { versionId: version.id, version: version.version, created };
}
