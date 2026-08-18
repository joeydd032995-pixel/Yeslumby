/**
 * pgvector encoding.
 *
 * The driver would send a JS array as a Postgres array literal (`{1,2,3}`),
 * which does not cast to `vector`. pgvector expects the JSON-ish form
 * `[1,2,3]`, so embeddings are formatted here and cast at the call site.
 */

export const EMBEDDING_DIMENSIONS = 1536;

export function toVector(embedding: readonly number[]): string {
  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `embedding must have ${EMBEDDING_DIMENSIONS} dimensions, received ${embedding.length}`,
    );
  }
  for (const v of embedding) {
    if (!Number.isFinite(v)) throw new Error("embedding contains a non-finite value");
  }
  return `[${embedding.join(",")}]`;
}

/** pgvector's `<=>` returns cosine *distance*; callers usually want similarity. */
export const distanceToSimilarity = (distance: number): number => 1 - distance;
