/**
 * Knowledge Memory — what the ecosystem learned about the external world.
 *
 * This is the only memory store an agent's context builder may read. It is a
 * separate module from evolutionary memory on purpose: the separation is
 * visible in the import graph, so a context builder that reaches for
 * self-knowledge has to import a module it has no business importing, and the
 * database CHECK constraint rejects the write regardless.
 */
import type { Sql } from "../client.js";
import type { KnowledgeMemoryType, MemoryRow } from "../types.js";
import { toVector, distanceToSimilarity } from "./vector.js";

export interface InsertKnowledgeMemoryInput {
  id: string;
  ecosystemId: string;
  type: KnowledgeMemoryType;
  content: string;
  embedding: readonly number[];
  importance?: number;
  confidence?: number;
  sourceRunId?: string | null;
  sourceArtifactIds?: string[];
  supersedesId?: string | null;
  contradictsIds?: string[];
  expiresAt?: Date | null;
}

export async function insertKnowledgeMemory(
  sql: Sql,
  input: InsertKnowledgeMemoryInput,
): Promise<MemoryRow> {
  const [row] = await sql<MemoryRow[]>`
    INSERT INTO memories
      (id, ecosystem_id, scope, type, content, embedding, importance, confidence,
       source_run_id, source_artifact_ids, supersedes_id, contradicts_ids, expires_at)
    VALUES (
      ${input.id}, ${input.ecosystemId}, 'knowledge', ${input.type}, ${input.content},
      ${toVector(input.embedding)}::vector,
      ${input.importance ?? 0.5}, ${input.confidence ?? 0.5},
      ${input.sourceRunId ?? null}, ${input.sourceArtifactIds ?? []},
      ${input.supersedesId ?? null}, ${input.contradictsIds ?? []},
      ${input.expiresAt ?? null}
    )
    RETURNING *
  `;
  if (!row) throw new Error("knowledge memory insert returned no row");
  return row;
}

export interface KnowledgeRecallOptions {
  ecosystemId: string;
  embedding: readonly number[];
  limit?: number;
  /** Cosine similarity floor in [0,1]. */
  minSimilarity?: number;
  types?: KnowledgeMemoryType[];
}

export type RecalledMemory = MemoryRow & { similarity: number };

/**
 * Semantic recall over knowledge memory only.
 *
 * `scope = 'knowledge'` is a literal, not a parameter — there is deliberately
 * no argument through which a caller could widen this to evolutionary memory.
 */
export async function recallKnowledge(
  sql: Sql,
  opts: KnowledgeRecallOptions,
): Promise<RecalledMemory[]> {
  const limit = opts.limit ?? 10;
  const minSimilarity = opts.minSimilarity ?? 0;
  const vector = toVector(opts.embedding);

  const rows = await sql<Array<MemoryRow & { distance: number }>>`
    SELECT *, embedding <=> ${vector}::vector AS distance
    FROM memories
    WHERE ecosystem_id = ${opts.ecosystemId}
      AND scope = 'knowledge'
      AND (expires_at IS NULL OR expires_at > now())
      ${opts.types?.length ? sql`AND type = ANY(${opts.types})` : sql``}
      AND embedding <=> ${vector}::vector <= ${1 - minSimilarity}
    ORDER BY distance ASC
    LIMIT ${limit}
  `;

  return rows.map(({ distance, ...row }) => ({
    ...row,
    similarity: distanceToSimilarity(Number(distance)),
  }));
}

/** Nearest existing memory, used by the novelty check before inserting. */
export async function findNearestKnowledge(
  sql: Sql,
  ecosystemId: string,
  embedding: readonly number[],
): Promise<RecalledMemory | undefined> {
  const [row] = await recallKnowledge(sql, { ecosystemId, embedding, limit: 1 });
  return row;
}

export async function markKnowledgeAccessed(sql: Sql, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await sql`
    UPDATE memories
    SET access_count = access_count + 1, last_accessed_at = now()
    WHERE id = ANY(${ids}) AND scope = 'knowledge'
  `;
}

export async function supersedeKnowledge(
  sql: Sql,
  oldId: string,
  newId: string,
): Promise<void> {
  await sql`
    UPDATE memories SET supersedes_id = ${oldId}
    WHERE id = ${newId} AND scope = 'knowledge'
  `;
}

export async function recordContradiction(
  sql: Sql,
  id: string,
  contradictsId: string,
): Promise<void> {
  await sql`
    UPDATE memories
    SET contradicts_ids = array_append(contradicts_ids, ${contradictsId})
    WHERE id = ${id} AND NOT (${contradictsId} = ANY(contradicts_ids))
  `;
}

export async function countKnowledge(sql: Sql, ecosystemId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM memories
    WHERE ecosystem_id = ${ecosystemId} AND scope = 'knowledge'
  `;
  return Number(row?.count ?? 0);
}
