import { knowledgeMemory, evolutionaryMemory, type Sql } from "@meta/db";
import type { EmbeddingProvider } from "./embedding.js";

/**
 * Read paths for the two persistent memories.
 *
 * They are deliberately separate functions with separate call sites. The
 * knowledge reader is handed to a RunContext; the structural reader is not, and
 * has no way to reach one. An agent that could read which architectures score
 * well would be able to optimize for its own evaluation rather than the user's
 * question — a failure mode that is very hard to detect after the fact, because
 * the outputs still look like good answers.
 */

export interface KnowledgeRecallOptions {
  limit: number;
  minSimilarity: number;
}

export interface RecalledKnowledgeItem {
  id: string;
  type: string;
  content: string;
  similarity: number;
}

/**
 * Build the knowledge reader passed into a run.
 *
 * Recalled rows have their access counters bumped, which is what makes
 * retention decisions possible later: a memory nothing ever recalls is a
 * candidate for expiry regardless of how important it looked when written.
 */
export function createKnowledgeRecall(
  sql: Sql,
  embedder: EmbeddingProvider,
  ecosystemId: string,
) {
  return {
    async recall(
      query: string,
      opts: KnowledgeRecallOptions,
    ): Promise<RecalledKnowledgeItem[]> {
      if (opts.limit <= 0) return [];

      const [embedding] = await embedder.embed([query]);
      if (!embedding) return [];

      const rows = await knowledgeMemory.recallKnowledge(sql, {
        ecosystemId,
        embedding,
        limit: opts.limit,
        minSimilarity: opts.minSimilarity,
      });

      await knowledgeMemory.markKnowledgeAccessed(
        sql,
        rows.map((r) => r.id),
      );

      return rows.map((r) => ({
        id: r.id,
        type: r.type,
        content: r.content,
        similarity: r.similarity,
      }));
    },
  };
}

export interface StructuralLesson {
  id: string;
  content: string;
  problemClass: string | null;
  genomeVersionId: string | null;
  importance: number;
  similarity: number;
}

/**
 * Read structural lessons for the mutation engine and genome recommender.
 *
 * Not exposed to a run. Callers are the evolutionary machinery, which operates
 * between rounds rather than inside one.
 */
export async function recallStructural(
  sql: Sql,
  embedder: EmbeddingProvider,
  opts: { ecosystemId: string; query: string; problemClass?: string; limit?: number },
): Promise<StructuralLesson[]> {
  const [embedding] = await embedder.embed([opts.query]);
  if (!embedding) return [];

  const rows = await evolutionaryMemory.recallStructuralLessons(sql, {
    ecosystemId: opts.ecosystemId,
    embedding,
    ...(opts.problemClass ? { problemClass: opts.problemClass } : {}),
    limit: opts.limit ?? 10,
  });

  return rows.map(toLesson);
}

/**
 * Structural lessons across several ecosystems, for recommending a starting
 * architecture to someone with no history of their own.
 *
 * The caller passes the ecosystems it is entitled to read. This function does
 * not infer authority — deciding who may learn from whose runs is an
 * authorization question, and answering it here would put that decision
 * somewhere nobody thinks to audit.
 */
export async function recallStructuralAcross(
  sql: Sql,
  embedder: EmbeddingProvider,
  opts: {
    ecosystemIds: string[];
    query: string;
    problemClass?: string;
    limit?: number;
  },
): Promise<StructuralLesson[]> {
  if (opts.ecosystemIds.length === 0) return [];
  const [embedding] = await embedder.embed([opts.query]);
  if (!embedding) return [];

  const rows = await evolutionaryMemory.recallStructuralLessonsAcross(sql, {
    ecosystemIds: opts.ecosystemIds,
    embedding,
    ...(opts.problemClass ? { problemClass: opts.problemClass } : {}),
    limit: opts.limit ?? 10,
  });
  return rows.map(toLesson);
}

function toLesson(row: {
  id: string;
  content: string;
  problem_class: string | null;
  genome_version_id: string | null;
  importance: number;
  similarity: number;
}): StructuralLesson {
  return {
    id: row.id,
    content: row.content,
    problemClass: row.problem_class,
    genomeVersionId: row.genome_version_id,
    importance: row.importance,
    similarity: row.similarity,
  };
}
