import { EMBEDDING_DIMENSIONS } from "@meta/db";
import { ModelCallError } from "@meta/shared";

/**
 * Embedding generation as a port.
 *
 * Same reasoning as the model gateway: a run that stores and recalls memories
 * is only reproducible if the embedding step is too. The deterministic
 * implementation is what makes memory behaviour testable; the hosted one is
 * used when credentials exist.
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

/**
 * A deterministic bag-of-tokens embedding.
 *
 * Not semantically strong — it captures lexical overlap, not meaning — but it
 * is stable, cheap, and has the one property the persistence and consolidation
 * logic actually needs: texts sharing vocabulary land near each other, so
 * novelty, recall ranking, and duplicate detection can be tested for
 * correctness. Swap in a real provider and the same code paths hold.
 */
export class DeterministicEmbedder implements EmbeddingProvider {
  readonly name = "deterministic";
  readonly dimensions = EMBEDDING_DIMENSIONS;

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((t) => embedOne(t, this.dimensions));
  }
}

function embedOne(text: string, dims: number): number[] {
  const vec = new Array<number>(dims).fill(0);
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  for (const token of tokens) {
    // Two independent hashes per token spread mass over the space and reduce
    // the collision rate a single bucket would produce.
    const h1 = fnv1a(token) % dims;
    const h2 = fnv1a(`#${token}`) % dims;
    vec[h1] = (vec[h1] ?? 0) + 1;
    vec[h2] = (vec[h2] ?? 0) + 0.5;
  }

  // Bigrams give word order a little weight, so "A causes B" and "B causes A"
  // are not identical vectors.
  for (let i = 0; i + 1 < tokens.length; i++) {
    const h = fnv1a(`${tokens[i]}_${tokens[i + 1]}`) % dims;
    vec[h] = (vec[h] ?? 0) + 0.75;
  }

  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => v / norm);
}

function fnv1a(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export interface GatewayEmbedderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Hosted embeddings through the AI Gateway.
 *
 * The vector column is a fixed 1536 dimensions, so a model returning a
 * different width is rejected rather than truncated — a silently reshaped
 * vector would corrupt every similarity comparison in the store.
 */
export class GatewayEmbedder implements EmbeddingProvider {
  readonly name = "ai-gateway";
  readonly dimensions = EMBEDDING_DIMENSIONS;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #fetch: typeof fetch;

  constructor(options: GatewayEmbedderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.AI_GATEWAY_API_KEY;
    if (!apiKey) throw new Error("AI_GATEWAY_API_KEY is not set");
    this.#apiKey = apiKey;
    this.#baseUrl = (
      options.baseUrl ??
      process.env.AI_GATEWAY_BASE_URL ??
      "https://ai-gateway.vercel.sh/v1"
    ).replace(/\/$/, "");
    this.#model = options.model ?? "openai/text-embedding-3-small";
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const response = await this.#fetch(`${this.#baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify({ model: this.#model, input: texts }),
    });

    if (!response.ok) {
      throw new ModelCallError(
        `embedding request failed with ${response.status}`,
        response.status === 429 || response.status >= 500,
        { model: this.#model },
      );
    }

    const body = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
    const vectors = body.data?.map((d) => d.embedding ?? []) ?? [];

    if (vectors.length !== texts.length) {
      throw new ModelCallError("embedding provider returned the wrong count", true, {
        expected: texts.length,
        received: vectors.length,
      });
    }
    for (const v of vectors) {
      if (v.length !== this.dimensions) {
        throw new ModelCallError(
          `embedding width ${v.length} does not match the store's ${this.dimensions}`,
          false,
          { model: this.#model },
        );
      }
    }
    return vectors;
  }
}

/** Pick the embedder appropriate to the environment. */
export function resolveEmbedder(forceDeterministic = false): EmbeddingProvider {
  if (!forceDeterministic && process.env.AI_GATEWAY_API_KEY) {
    return new GatewayEmbedder();
  }
  return new DeterministicEmbedder();
}

/** Cosine similarity for two unit-normalized vectors. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
