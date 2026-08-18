/**
 * Evolutionary Memory — what the ecosystem learned about *itself*.
 *
 * This store answers the question the product is actually built around: which
 * architectures work for which classes of problems. It is consumed by the
 * mutation engine, the breeding path, and the genome recommender — never by an
 * agent's proposal context. An agent reasoning about its own scaffolding while
 * answering a user's question is how a system starts optimizing for its own
 * evaluation rather than the task.
 *
 * Records are therefore keyed by `problem_class` and `genome_version_id`, which
 * knowledge memory has no notion of.
 */
import type { Sql } from "../client.js";
import type { EvolutionaryMemoryType, MemoryRow } from "../types.js";
import { toVector, distanceToSimilarity } from "./vector.js";

export interface InsertEvolutionaryMemoryInput {
  id: string;
  ecosystemId: string;
  type: EvolutionaryMemoryType;
  content: string;
  embedding: readonly number[];
  /** The class of task this lesson applies to, e.g. "causal-inference". */
  problemClass: string;
  genomeVersionId?: string | null;
  importance?: number;
  confidence?: number;
  sourceRunId?: string | null;
  sourceArtifactIds?: string[];
}

export async function insertEvolutionaryMemory(
  sql: Sql,
  input: InsertEvolutionaryMemoryInput,
): Promise<MemoryRow> {
  const [row] = await sql<MemoryRow[]>`
    INSERT INTO memories
      (id, ecosystem_id, scope, type, content, embedding, importance, confidence,
       problem_class, genome_version_id, source_run_id, source_artifact_ids)
    VALUES (
      ${input.id}, ${input.ecosystemId}, 'evolutionary', ${input.type}, ${input.content},
      ${toVector(input.embedding)}::vector,
      ${input.importance ?? 0.7}, ${input.confidence ?? 0.5},
      ${input.problemClass}, ${input.genomeVersionId ?? null},
      ${input.sourceRunId ?? null}, ${input.sourceArtifactIds ?? []}
    )
    RETURNING *
  `;
  if (!row) throw new Error("evolutionary memory insert returned no row");
  return row;
}

export type RecalledStructuralLesson = MemoryRow & { similarity: number };

export interface StructuralRecallOptions {
  ecosystemId: string;
  embedding: readonly number[];
  problemClass?: string;
  types?: EvolutionaryMemoryType[];
  limit?: number;
}

/**
 * Recall structural lessons. `scope = 'evolutionary'` is a literal for the same
 * reason it is in the knowledge module: the two stores must not be reachable
 * through one parameterized query.
 */
export async function recallStructuralLessons(
  sql: Sql,
  opts: StructuralRecallOptions,
): Promise<RecalledStructuralLesson[]> {
  const vector = toVector(opts.embedding);
  const rows = await sql<Array<MemoryRow & { distance: number }>>`
    SELECT *, embedding <=> ${vector}::vector AS distance
    FROM memories
    WHERE ecosystem_id = ${opts.ecosystemId}
      AND scope = 'evolutionary'
      ${opts.problemClass ? sql`AND problem_class = ${opts.problemClass}` : sql``}
      ${opts.types?.length ? sql`AND type = ANY(${opts.types})` : sql``}
    ORDER BY distance ASC
    LIMIT ${opts.limit ?? 10}
  `;
  return rows.map(({ distance, ...row }) => ({
    ...row,
    similarity: distanceToSimilarity(Number(distance)),
  }));
}

/**
 * Cross-ecosystem structural recall, for recommending a starting genome to a
 * user who has no history yet. Restricted to lessons learned in ecosystems the
 * caller can see; the caller passes the permitted set explicitly rather than
 * this module inferring authority.
 */
export async function recallStructuralLessonsAcross(
  sql: Sql,
  opts: {
    ecosystemIds: string[];
    embedding: readonly number[];
    problemClass?: string;
    limit?: number;
  },
): Promise<RecalledStructuralLesson[]> {
  if (opts.ecosystemIds.length === 0) return [];
  const vector = toVector(opts.embedding);
  const rows = await sql<Array<MemoryRow & { distance: number }>>`
    SELECT *, embedding <=> ${vector}::vector AS distance
    FROM memories
    WHERE ecosystem_id = ANY(${opts.ecosystemIds})
      AND scope = 'evolutionary'
      AND type = 'STRUCTURAL_LEARNING'
      ${opts.problemClass ? sql`AND problem_class = ${opts.problemClass}` : sql``}
    ORDER BY distance ASC
    LIMIT ${opts.limit ?? 10}
  `;
  return rows.map(({ distance, ...row }) => ({
    ...row,
    similarity: distanceToSimilarity(Number(distance)),
  }));
}

/** Outcomes of past mutations, so the engine stops re-proposing what failed. */
export async function getMutationOutcomes(
  sql: Sql,
  ecosystemId: string,
  limit = 50,
): Promise<MemoryRow[]> {
  return sql<MemoryRow[]>`
    SELECT * FROM memories
    WHERE ecosystem_id = ${ecosystemId}
      AND scope = 'evolutionary'
      AND type = 'MUTATION_OUTCOME'
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}

export async function countEvolutionary(sql: Sql, ecosystemId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM memories
    WHERE ecosystem_id = ${ecosystemId} AND scope = 'evolutionary'
  `;
  return Number(row?.count ?? 0);
}
