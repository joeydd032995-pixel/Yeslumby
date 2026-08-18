import { knowledgeMemory, evolutionaryMemory, type MemoryRow, type Sql } from "@meta/db";
import type { MemoryPolicy } from "@meta/genome";
import type { IdGenerator } from "@meta/shared";
import type { EmbeddingProvider } from "./embedding.js";

/**
 * Memory consolidation.
 *
 * Writing everything an agent said into memory produces a store that gets
 * worse as it grows: near-duplicates crowd out recall slots, stale claims
 * outlive their evidence, and contradictions accumulate silently until recall
 * returns both sides of a question with equal confidence. Three checks run
 * before anything is inserted.
 *
 *   - **Importance.** Below the genome's floor, a candidate is dropped. The
 *     Watcher assigns importance, which is the right place for the judgement:
 *     it is the only component that saw the whole round.
 *   - **Novelty.** At or above the novelty threshold a candidate is a
 *     duplicate, and the existing row is reinforced instead of a second copy
 *     being written.
 *   - **Contradiction.** Similar-but-opposed content is recorded as a
 *     contradiction link rather than quietly stored alongside its opposite.
 */

export interface KnowledgeCandidate {
  content: string;
  type: "FACT" | "HYPOTHESIS" | "FAILED_APPROACH" | "USER_PREFERENCE";
  importance: number;
  confidence?: number;
  sourceRunId?: string | null;
  sourceArtifactIds?: string[];
}

export interface StructuralCandidate {
  content: string;
  type?: "STRUCTURAL_LEARNING" | "BENCHMARK_RESULT" | "MUTATION_OUTCOME";
  problemClass: string;
  importance: number;
  confidence?: number;
  genomeVersionId?: string | null;
  sourceRunId?: string | null;
}

export type ConsolidationOutcome =
  | { action: "inserted"; memory: MemoryRow }
  | { action: "merged"; into: string; similarity: number }
  | { action: "contradiction"; memory: MemoryRow; contradicts: string; similarity: number }
  | { action: "dropped"; reason: string };

export interface ConsolidationDeps {
  sql: Sql;
  embedder: EmbeddingProvider;
  ids: IdGenerator;
  ecosystemId: string;
  policy: MemoryPolicy;
  /** Overrides the default heuristic. Supply an LLM-backed detector in prod. */
  detectContradiction?: ContradictionDetector;
}

export type ContradictionDetector = (
  candidate: string,
  existing: string,
  similarity: number,
) => boolean;

const NEGATIONS = [
  "not", "no", "never", "cannot", "can't", "doesn't", "does not", "didn't",
  "isn't", "wasn't", "won't", "fails to", "failed to", "unable", "without",
  "refutes", "contradicts", "disproves", "false",
];

/**
 * Default contradiction heuristic: strong lexical overlap with asymmetric
 * negation.
 *
 * This is a cheap first pass and it is honest about being one — it catches
 * "X causes Y" against "X does not cause Y" and misses contradictions phrased
 * without negation markers. It runs on every write, where an LLM call would
 * not be affordable; supply {@link ConsolidationDeps.detectContradiction} to
 * escalate to a model where the cost is justified.
 */
export const heuristicContradiction: ContradictionDetector = (candidate, existing, similarity) => {
  if (similarity < 0.6) return false;
  const has = (text: string) => {
    const lower = ` ${text.toLowerCase()} `;
    return NEGATIONS.some((n) => lower.includes(` ${n} `));
  };
  return has(candidate) !== has(existing);
};

export async function consolidateKnowledge(
  deps: ConsolidationDeps,
  candidates: readonly KnowledgeCandidate[],
): Promise<ConsolidationOutcome[]> {
  if (candidates.length === 0) return [];
  if (!deps.policy.writeScopes.includes("knowledge")) {
    return candidates.map(() => ({
      action: "dropped" as const,
      reason: "knowledge writes are disabled by memoryPolicy.writeScopes",
    }));
  }

  const detect = deps.detectContradiction ?? heuristicContradiction;
  const outcomes: ConsolidationOutcome[] = [];

  // Embed in one batch: hosted providers price per request, and batching keeps
  // consolidation cost flat in the number of candidates.
  const embeddings = await deps.embedder.embed(candidates.map((c) => c.content));

  for (const [i, candidate] of candidates.entries()) {
    const embedding = embeddings[i];
    if (!embedding) {
      outcomes.push({ action: "dropped", reason: "embedding missing" });
      continue;
    }

    if (candidate.importance < deps.policy.importanceFloor) {
      outcomes.push({
        action: "dropped",
        reason: `importance ${candidate.importance.toFixed(2)} below floor ${deps.policy.importanceFloor}`,
      });
      continue;
    }

    const nearest = await knowledgeMemory.findNearestKnowledge(
      deps.sql,
      deps.ecosystemId,
      embedding,
    );

    if (nearest && nearest.similarity >= deps.policy.noveltyThreshold) {
      // Already known. Reinforce rather than duplicate: recall slots are
      // scarce, and two copies of one fact crowd out a second fact.
      await knowledgeMemory.markKnowledgeAccessed(deps.sql, [nearest.id]);
      outcomes.push({ action: "merged", into: nearest.id, similarity: nearest.similarity });
      continue;
    }

    const contradicts =
      nearest && detect(candidate.content, nearest.content, nearest.similarity)
        ? nearest
        : undefined;

    const memory = await knowledgeMemory.insertKnowledgeMemory(deps.sql, {
      id: deps.ids.next("memory"),
      ecosystemId: deps.ecosystemId,
      type: candidate.type,
      content: candidate.content,
      embedding,
      importance: candidate.importance,
      confidence: candidate.confidence ?? 0.5,
      sourceRunId: candidate.sourceRunId ?? null,
      sourceArtifactIds: candidate.sourceArtifactIds ?? [],
      ...(contradicts ? { contradictsIds: [contradicts.id] } : {}),
      ...(deps.policy.retention === "ephemeral"
        ? { expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) }
        : {}),
    });

    if (contradicts) {
      // Link both ways, so recalling either side surfaces the conflict.
      await knowledgeMemory.recordContradiction(deps.sql, contradicts.id, memory.id);
      outcomes.push({
        action: "contradiction",
        memory,
        contradicts: contradicts.id,
        similarity: contradicts.similarity,
      });
      continue;
    }

    outcomes.push({ action: "inserted", memory });
  }

  return outcomes;
}

/**
 * Consolidate what the ecosystem learned about itself.
 *
 * Structural lessons are the highest-value records in the system — they are
 * what lets a later run pick an architecture rather than rediscover one — so
 * they are held to the same novelty check but keyed by problem class, since
 * "three proposers beat five" is a claim about a class of task, not about the
 * world.
 */
export async function consolidateStructural(
  deps: ConsolidationDeps,
  candidates: readonly StructuralCandidate[],
): Promise<ConsolidationOutcome[]> {
  if (candidates.length === 0) return [];
  if (!deps.policy.writeScopes.includes("evolutionary")) {
    return candidates.map(() => ({
      action: "dropped" as const,
      reason: "evolutionary writes are disabled by memoryPolicy.writeScopes",
    }));
  }

  const outcomes: ConsolidationOutcome[] = [];
  const embeddings = await deps.embedder.embed(candidates.map((c) => c.content));

  for (const [i, candidate] of candidates.entries()) {
    const embedding = embeddings[i];
    if (!embedding) {
      outcomes.push({ action: "dropped", reason: "embedding missing" });
      continue;
    }
    if (candidate.importance < deps.policy.importanceFloor) {
      outcomes.push({ action: "dropped", reason: "below importance floor" });
      continue;
    }

    const [nearest] = await evolutionaryMemory.recallStructuralLessons(deps.sql, {
      ecosystemId: deps.ecosystemId,
      embedding,
      problemClass: candidate.problemClass,
      limit: 1,
    });

    if (nearest && nearest.similarity >= deps.policy.noveltyThreshold) {
      outcomes.push({ action: "merged", into: nearest.id, similarity: nearest.similarity });
      continue;
    }

    const memory = await evolutionaryMemory.insertEvolutionaryMemory(deps.sql, {
      id: deps.ids.next("memory"),
      ecosystemId: deps.ecosystemId,
      type: candidate.type ?? "STRUCTURAL_LEARNING",
      content: candidate.content,
      embedding,
      problemClass: candidate.problemClass,
      importance: candidate.importance,
      confidence: candidate.confidence ?? 0.5,
      genomeVersionId: candidate.genomeVersionId ?? null,
      sourceRunId: candidate.sourceRunId ?? null,
    });
    outcomes.push({ action: "inserted", memory });
  }

  return outcomes;
}
