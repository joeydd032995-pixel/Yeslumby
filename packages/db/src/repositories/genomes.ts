import { contentHash } from "@meta/shared";
import type { Sql } from "../client.js";
import type { EcosystemRow, GenomeOrigin, GenomeVersionRow } from "../types.js";

export interface CreateGenomeVersionInput {
  id: string;
  ecosystemId: string;
  /**
   * Optional. The hash is computed here regardless; supplying it asks this
   * function to verify your computation agrees.
   */
  genomeHash?: string;
  genome: unknown;
  parentIds?: string[];
  origin: GenomeOrigin;
  createdBy?: string | null;
}

export interface CreateGenomeVersionResult {
  version: GenomeVersionRow;
  /** False when an identical genome already existed and was returned as-is. */
  created: boolean;
}

/**
 * Materialize a new immutable genome version.
 *
 * Two properties matter here:
 *
 * - **Version numbers are allocated under an advisory lock** scoped to the
 *   ecosystem. Without it, two concurrent mutations both read MAX(version)=N
 *   and race for N+1; the UNIQUE constraint would reject one and lose the work.
 *
 * - **Identical content does not fork the lineage.** If a mutation happens to
 *   reproduce an existing genome exactly, the existing version is returned
 *   rather than a duplicate created. Content addressing makes this detectable.
 *
 * - **The hash is computed here, not accepted from the caller.** These rows are
 *   append-only, so a wrong content address is permanent: it would make two
 *   different genomes deduplicate into one, or two identical genomes fork the
 *   lineage. A caller-supplied hash is treated as an assertion to check, never
 *   as the value to store.
 */
export async function createGenomeVersion(
  sql: Sql,
  input: CreateGenomeVersionInput,
): Promise<CreateGenomeVersionResult> {
  const genomeHash = contentHash(input.genome);
  if (input.genomeHash !== undefined && input.genomeHash !== genomeHash) {
    throw new Error(
      `genome hash mismatch: caller supplied ${input.genomeHash.slice(0, 12)} but the ` +
        `genome content hashes to ${genomeHash.slice(0, 12)}`,
    );
  }

  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${input.ecosystemId}))`;

    const existing = await tx<GenomeVersionRow[]>`
      SELECT * FROM genome_versions
      WHERE ecosystem_id = ${input.ecosystemId} AND genome_hash = ${genomeHash}
    `;
    if (existing[0]) return { version: existing[0], created: false };

    const [next] = await tx<{ next: number }[]>`
      SELECT COALESCE(MAX(version), 0) + 1 AS next
      FROM genome_versions WHERE ecosystem_id = ${input.ecosystemId}
    `;

    const [row] = await tx<GenomeVersionRow[]>`
      INSERT INTO genome_versions
        (id, ecosystem_id, version, genome_hash, genome, parent_ids, origin, created_by)
      VALUES (
        ${input.id},
        ${input.ecosystemId},
        ${next?.next ?? 1},
        ${genomeHash},
        ${tx.json(input.genome as never)},
        ${input.parentIds ?? []},
        ${input.origin},
        ${input.createdBy ?? null}
      )
      RETURNING *
    `;
    if (!row) throw new Error("genome version insert returned no row");
    return { version: row, created: true };
  }) as Promise<CreateGenomeVersionResult>;
}

export async function getGenomeVersion(
  sql: Sql,
  id: string,
): Promise<GenomeVersionRow | undefined> {
  const [row] = await sql<GenomeVersionRow[]>`
    SELECT * FROM genome_versions WHERE id = ${id}
  `;
  return row;
}

export async function getGenomeVersionByNumber(
  sql: Sql,
  ecosystemId: string,
  version: number,
): Promise<GenomeVersionRow | undefined> {
  const [row] = await sql<GenomeVersionRow[]>`
    SELECT * FROM genome_versions
    WHERE ecosystem_id = ${ecosystemId} AND version = ${version}
  `;
  return row;
}

export async function listGenomeVersions(
  sql: Sql,
  ecosystemId: string,
): Promise<GenomeVersionRow[]> {
  return sql<GenomeVersionRow[]>`
    SELECT * FROM genome_versions
    WHERE ecosystem_id = ${ecosystemId}
    ORDER BY version ASC
  `;
}

/**
 * Walk the lineage of a version back to its roots.
 *
 * Breeding gives a version multiple parents, so the ancestry is a DAG rather
 * than a chain and a plain recursive walk can revisit shared ancestors. The
 * CTE tracks visited ids to terminate, and `depth` lets the UI lay out the
 * evolution graph without a second pass.
 */
export async function getLineage(
  sql: Sql,
  versionId: string,
): Promise<Array<GenomeVersionRow & { depth: number }>> {
  // As with provenance, a shared ancestor is reachable at several depths and
  // `depth` makes those rows distinct to the UNION. Collapse to the shortest
  // path so the graph draws one node per version.
  return sql<Array<GenomeVersionRow & { depth: number }>>`
    WITH RECURSIVE ancestry AS (
      SELECT gv.*, 0 AS depth
      FROM genome_versions gv
      WHERE gv.id = ${versionId}

      UNION

      SELECT parent.*, a.depth + 1
      FROM ancestry a
      JOIN genome_versions parent ON parent.id = ANY(a.parent_ids)
      WHERE a.depth < 200
    ),
    shallowest AS (
      SELECT DISTINCT ON (id) * FROM ancestry ORDER BY id, depth ASC
    )
    SELECT * FROM shallowest ORDER BY depth ASC, version ASC
  `;
}

/** Direct children of a version, for rendering the evolution graph downward. */
export async function getDescendants(
  sql: Sql,
  versionId: string,
): Promise<GenomeVersionRow[]> {
  return sql<GenomeVersionRow[]>`
    SELECT * FROM genome_versions
    WHERE ${versionId} = ANY(parent_ids)
    ORDER BY version ASC
  `;
}

export async function setCurrentGenomeVersion(
  sql: Sql,
  ecosystemId: string,
  versionId: string,
): Promise<void> {
  await sql`
    UPDATE ecosystems
    SET current_genome_version_id = ${versionId}, updated_at = now()
    WHERE id = ${ecosystemId}
  `;
}

export interface CreateEcosystemInput {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  description?: string | null;
  visibility?: "private" | "public";
  forkedFromEcosystemId?: string | null;
  forkedFromVersionId?: string | null;
  createdBy?: string | null;
}

export async function createEcosystem(
  sql: Sql,
  input: CreateEcosystemInput,
): Promise<EcosystemRow> {
  const [row] = await sql<EcosystemRow[]>`
    INSERT INTO ecosystems
      (id, workspace_id, name, slug, description, visibility,
       forked_from_ecosystem_id, forked_from_version_id, created_by)
    VALUES (
      ${input.id}, ${input.workspaceId}, ${input.name}, ${input.slug},
      ${input.description ?? null}, ${input.visibility ?? "private"},
      ${input.forkedFromEcosystemId ?? null}, ${input.forkedFromVersionId ?? null},
      ${input.createdBy ?? null}
    )
    RETURNING *
  `;
  if (!row) throw new Error("ecosystem insert returned no row");
  return row;
}

export async function getEcosystem(sql: Sql, id: string): Promise<EcosystemRow | undefined> {
  const [row] = await sql<EcosystemRow[]>`SELECT * FROM ecosystems WHERE id = ${id}`;
  return row;
}

export async function listEcosystems(sql: Sql, workspaceId: string): Promise<EcosystemRow[]> {
  return sql<EcosystemRow[]>`
    SELECT * FROM ecosystems WHERE workspace_id = ${workspaceId} ORDER BY created_at DESC
  `;
}

export async function listPublicEcosystems(sql: Sql, limit = 50): Promise<EcosystemRow[]> {
  return sql<EcosystemRow[]>`
    SELECT * FROM ecosystems WHERE visibility = 'public'
    ORDER BY updated_at DESC LIMIT ${limit}
  `;
}
