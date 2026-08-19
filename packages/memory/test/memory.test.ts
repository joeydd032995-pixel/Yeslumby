import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSql, migrate, genomes, knowledgeMemory, type Sql } from "@meta/db";
import { parseGenome, BALANCED_ANALYSIS, type MemoryPolicy } from "@meta/genome";
import { DeterministicIds } from "@meta/shared";
import {
  DeterministicEmbedder,
  consolidateKnowledge,
  consolidateStructural,
  cosineSimilarity,
  createKnowledgeRecall,
  heuristicContradiction,
  recallStructural,
} from "../src/index.js";

let sql: Sql;
const embedder = new DeterministicEmbedder();
const policy: MemoryPolicy = parseGenome(BALANCED_ANALYSIS).memoryPolicy;

beforeAll(async () => {
  sql = createSql({
    url: process.env.TEST_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5433/meta_ecosystem_test",
    max: 4,
  });
  await migrate(sql, { silent: true });
});

afterAll(async () => {
  await sql.end();
});

let counter = 0;

async function seed() {
  const ns = `m${++counter}_${process.pid}`;
  const ids = new DeterministicIds(ns);
  const orgId = ids.next("org");
  const wsId = ids.next("workspace");
  const ecosystemId = ids.next("ecosystem");

  await sql`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, ${ns}, ${`o-${ns}`})`;
  await sql`INSERT INTO workspaces (id, org_id, name, slug) VALUES (${wsId}, ${orgId}, ${ns}, ${`w-${ns}`})`;
  await genomes.createEcosystem(sql, { id: ecosystemId, workspaceId: wsId, name: ns, slug: `e-${ns}` });

  return { ids, ecosystemId, deps: { sql, embedder, ids, ecosystemId, policy } };
}

describe("deterministic embedder", () => {
  it("is stable across calls", async () => {
    const [a] = await embedder.embed(["postgres vacuum reclaims dead tuples"]);
    const [b] = await embedder.embed(["postgres vacuum reclaims dead tuples"]);
    expect(a).toEqual(b);
  });

  it("produces unit vectors of the store's width", async () => {
    const [v] = await embedder.embed(["anything at all"]);
    expect(v).toHaveLength(1536);
    const norm = Math.sqrt(v!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("places related text closer than unrelated text", async () => {
    const [a, b, c] = await embedder.embed([
      "postgres vacuum reclaims dead tuples from heap pages",
      "postgres autovacuum thresholds depend on table churn",
      "the migratory patterns of arctic terns",
    ]);
    expect(cosineSimilarity(a!, b!)).toBeGreaterThan(cosineSimilarity(a!, c!));
  });

  it("distinguishes word order via bigrams", async () => {
    const [ab, ba] = await embedder.embed(["alpha causes beta", "beta causes alpha"]);
    // Same unigrams, different bigrams — the vectors must not be identical, or
    // causal direction would be invisible to recall.
    expect(cosineSimilarity(ab!, ba!)).toBeLessThan(0.999);
  });
});

describe("knowledge consolidation", () => {
  it("inserts a novel memory", async () => {
    const { deps } = await seed();
    const [outcome] = await consolidateKnowledge(deps, [
      { content: "Replication rates in this subfield average 40 percent.", type: "FACT", importance: 0.8 },
    ]);
    expect(outcome?.action).toBe("inserted");
  });

  it("merges a near-duplicate instead of storing it twice", async () => {
    const { deps, ecosystemId } = await seed();
    const content = "The effect size shrinks substantially under preregistration.";

    await consolidateKnowledge(deps, [{ content, type: "FACT", importance: 0.8 }]);
    const [second] = await consolidateKnowledge(deps, [{ content, type: "FACT", importance: 0.8 }]);

    expect(second?.action).toBe("merged");
    // Recall slots are scarce; two copies of one fact crowd out a second fact.
    expect(await knowledgeMemory.countKnowledge(sql, ecosystemId)).toBe(1);
  });

  it("drops candidates below the importance floor", async () => {
    const { deps, ecosystemId } = await seed();
    const [outcome] = await consolidateKnowledge(deps, [
      { content: "An incidental detail of no consequence.", type: "FACT", importance: 0.05 },
    ]);
    expect(outcome?.action).toBe("dropped");
    expect(await knowledgeMemory.countKnowledge(sql, ecosystemId)).toBe(0);
  });

  it("records a contradiction link rather than storing both sides silently", async () => {
    const { deps } = await seed();
    await consolidateKnowledge(deps, [
      { content: "The intervention improves retention in cohort studies.", type: "FACT", importance: 0.8 },
    ]);
    const [second] = await consolidateKnowledge(deps, [
      {
        content: "The intervention does not improve retention in cohort studies.",
        type: "FACT",
        importance: 0.8,
      },
    ]);

    expect(second?.action).toBe("contradiction");
    if (second?.action === "contradiction") {
      // Linked both ways, so recalling either side surfaces the conflict.
      const [rowA] = await sql<{ contradicts_ids: string[] }[]>`
        SELECT contradicts_ids FROM memories WHERE id = ${second.contradicts}
      `;
      expect(rowA?.contradicts_ids).toContain(second.memory.id);
      expect(second.memory.contradicts_ids).toContain(second.contradicts);
    }
  });

  it("honours writeScopes by refusing knowledge writes when disabled", async () => {
    const { deps } = await seed();
    const [outcome] = await consolidateKnowledge(
      { ...deps, policy: { ...policy, writeScopes: ["evolutionary"] } },
      [{ content: "should not be stored", type: "FACT", importance: 1 }],
    );
    expect(outcome).toEqual({
      action: "dropped",
      reason: "knowledge writes are disabled by memoryPolicy.writeScopes",
    });
  });

  it("expires ephemeral memories", async () => {
    const { deps } = await seed();
    const [outcome] = await consolidateKnowledge(
      { ...deps, policy: { ...policy, retention: "ephemeral" } },
      [{ content: "A short-lived observation about today's run.", type: "FACT", importance: 0.9 }],
    );
    expect(outcome?.action).toBe("inserted");
    if (outcome?.action === "inserted") {
      expect(outcome.memory.expires_at).toBeInstanceOf(Date);
    }
  });
});

describe("contradiction heuristic", () => {
  it("flags asymmetric negation on similar content", () => {
    expect(heuristicContradiction("X causes Y", "X does not cause Y", 0.9)).toBe(true);
  });

  it("does not flag agreement", () => {
    expect(heuristicContradiction("X causes Y", "X causes Y reliably", 0.9)).toBe(false);
  });

  it("does not flag unrelated content even with asymmetric negation", () => {
    expect(heuristicContradiction("X causes Y", "birds do not migrate", 0.2)).toBe(false);
  });
});

describe("structural consolidation", () => {
  it("keys lessons by problem class", async () => {
    const { deps, ecosystemId } = await seed();
    await consolidateStructural(deps, [
      {
        content: "Adding a dedicated falsifier raised evidence quality on this class.",
        problemClass: "forecasting",
        importance: 0.9,
      },
      {
        content: "A second synthesizer added cost without improving accuracy.",
        problemClass: "code-review",
        importance: 0.9,
      },
    ]);

    const forecasting = await recallStructural(sql, embedder, {
      ecosystemId,
      query: "falsifier evidence quality",
      problemClass: "forecasting",
    });
    expect(forecasting).toHaveLength(1);
    expect(forecasting[0]?.problemClass).toBe("forecasting");
  });

  it("merges a near-duplicate lesson", async () => {
    const { deps } = await seed();
    const content = "Three independent proposers outperformed five on ambiguous briefs.";
    await consolidateStructural(deps, [{ content, problemClass: "ambiguous", importance: 0.9 }]);
    const [second] = await consolidateStructural(deps, [
      { content, problemClass: "ambiguous", importance: 0.9 },
    ]);
    expect(second?.action).toBe("merged");
  });
});

describe("separation of the two stores", () => {
  it("keeps structural lessons out of the reader a run is given", async () => {
    const { deps, ecosystemId } = await seed();
    const shared = "independent proposers outperform a single analyst on ambiguous briefs";

    await consolidateStructural(deps, [
      { content: shared, problemClass: "ambiguous", importance: 0.95 },
    ]);
    await consolidateKnowledge(deps, [
      { content: "Ambiguous briefs are common in this domain.", type: "FACT", importance: 0.8 },
    ]);

    const recall = createKnowledgeRecall(sql, embedder, ecosystemId);
    const hits = await recall.recall(shared, { limit: 10, minSimilarity: 0 });

    // The run-facing reader must never surface self-knowledge, even when it is
    // the closest match to the query.
    expect(hits.every((h) => h.content !== shared)).toBe(true);
    expect(hits.every((h) => ["FACT", "HYPOTHESIS", "FAILED_APPROACH", "USER_PREFERENCE"].includes(h.type))).toBe(true);
  });

  it("makes structural lessons reachable only through the evolutionary reader", async () => {
    const { deps, ecosystemId } = await seed();
    const lesson = "removing the skeptic collapsed measured disagreement to zero";
    await consolidateStructural(deps, [
      { content: lesson, problemClass: "general-analysis", importance: 0.95 },
    ]);

    const structural = await recallStructural(sql, embedder, {
      ecosystemId,
      query: "skeptic disagreement",
    });
    expect(structural.some((l) => l.content === lesson)).toBe(true);
  });
});

describe("knowledge recall", () => {
  it("respects the similarity floor", async () => {
    const { deps, ecosystemId } = await seed();
    await consolidateKnowledge(deps, [
      { content: "SQLite serializes writes behind a single writer lock.", type: "FACT", importance: 0.9 },
    ]);

    const recall = createKnowledgeRecall(sql, embedder, ecosystemId);
    expect(await recall.recall("coral reef biology", { limit: 5, minSimilarity: 0.5 })).toHaveLength(0);
    expect((await recall.recall("sqlite writer lock", { limit: 5, minSimilarity: 0.1 })).length).toBeGreaterThan(0);
  });

  it("returns nothing when the policy sets a zero recall limit", async () => {
    const { deps, ecosystemId } = await seed();
    await consolidateKnowledge(deps, [
      { content: "Something worth remembering.", type: "FACT", importance: 0.9 },
    ]);
    const recall = createKnowledgeRecall(sql, embedder, ecosystemId);
    expect(await recall.recall("something", { limit: 0, minSimilarity: 0 })).toHaveLength(0);
  });

  it("bumps access counts, so unused memories become identifiable", async () => {
    const { deps, ecosystemId } = await seed();
    await consolidateKnowledge(deps, [
      { content: "A fact that will be recalled twice in this test.", type: "FACT", importance: 0.9 },
    ]);

    const recall = createKnowledgeRecall(sql, embedder, ecosystemId);
    await recall.recall("fact recalled twice", { limit: 5, minSimilarity: 0 });
    await recall.recall("fact recalled twice", { limit: 5, minSimilarity: 0 });

    const [row] = await sql<{ access_count: number }[]>`
      SELECT access_count FROM memories WHERE ecosystem_id = ${ecosystemId}
    `;
    expect(row?.access_count).toBe(2);
  });
});
