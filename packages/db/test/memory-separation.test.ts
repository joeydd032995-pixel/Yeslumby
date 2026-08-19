import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { knowledgeMemory, evolutionaryMemory, type Sql } from "../src/index.js";
import { ensureSchema, fakeEmbedding, seedTenant, testSql } from "./helpers.js";

let sql: Sql;

beforeAll(async () => {
  sql = testSql();
  await ensureSchema(sql);
});

afterAll(async () => {
  await sql.end();
});

describe("memory scope separation", () => {
  it("rejects an evolutionary type filed under knowledge scope", async () => {
    const t = await seedTenant(sql, "sep");
    // Bypassing the repositories entirely — this is the guarantee that holds
    // even if application code is wrong.
    await expect(
      sql`
        INSERT INTO memories (id, ecosystem_id, scope, type, content)
        VALUES (${t.ids.next("memory")}, ${t.ecosystemId}, 'knowledge', 'STRUCTURAL_LEARNING', 'x')
      `,
    ).rejects.toThrow(/memories_scope_type_valid/);
  });

  it("rejects a knowledge type filed under evolutionary scope", async () => {
    const t = await seedTenant(sql, "sep2");
    await expect(
      sql`
        INSERT INTO memories (id, ecosystem_id, scope, type, content)
        VALUES (${t.ids.next("memory")}, ${t.ecosystemId}, 'evolutionary', 'FACT', 'x')
      `,
    ).rejects.toThrow(/memories_scope_type_valid/);
  });

  it("never returns evolutionary records from knowledge recall", async () => {
    const t = await seedTenant(sql, "sep3");
    const text = "retrieval augmented generation improves factual grounding";

    await knowledgeMemory.insertKnowledgeMemory(sql, {
      id: t.ids.next("memory"),
      ecosystemId: t.ecosystemId,
      type: "FACT",
      content: text,
      embedding: fakeEmbedding(text),
    });

    // Deliberately near-identical content in the other scope. If the two stores
    // shared a query path, this would surface in the recall below.
    await evolutionaryMemory.insertEvolutionaryMemory(sql, {
      id: t.ids.next("memory"),
      ecosystemId: t.ecosystemId,
      type: "STRUCTURAL_LEARNING",
      content: text,
      embedding: fakeEmbedding(text),
      problemClass: "retrieval",
    });

    const recalled = await knowledgeMemory.recallKnowledge(sql, {
      ecosystemId: t.ecosystemId,
      embedding: fakeEmbedding(text),
      limit: 10,
    });

    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.scope).toBe("knowledge");
    expect(recalled.every((m) => m.scope === "knowledge")).toBe(true);
  });

  it("never returns knowledge records from structural recall", async () => {
    const t = await seedTenant(sql, "sep4");
    const text = "three independent proposers outperformed five on ambiguous briefs";

    await knowledgeMemory.insertKnowledgeMemory(sql, {
      id: t.ids.next("memory"),
      ecosystemId: t.ecosystemId,
      type: "FACT",
      content: text,
      embedding: fakeEmbedding(text),
    });
    await evolutionaryMemory.insertEvolutionaryMemory(sql, {
      id: t.ids.next("memory"),
      ecosystemId: t.ecosystemId,
      type: "STRUCTURAL_LEARNING",
      content: text,
      embedding: fakeEmbedding(text),
      problemClass: "ambiguous-brief",
    });

    const lessons = await evolutionaryMemory.recallStructuralLessons(sql, {
      ecosystemId: t.ecosystemId,
      embedding: fakeEmbedding(text),
    });

    expect(lessons).toHaveLength(1);
    expect(lessons[0]?.scope).toBe("evolutionary");
  });
});

describe("semantic recall", () => {
  it("ranks semantically closer memories first", async () => {
    const t = await seedTenant(sql, "rank");
    const entries = [
      "postgres vacuum reclaims dead tuples from heap pages",
      "kubernetes schedules pods onto nodes by resource requests",
      "postgres autovacuum thresholds depend on table churn",
    ];
    for (const content of entries) {
      await knowledgeMemory.insertKnowledgeMemory(sql, {
        id: t.ids.next("memory"),
        ecosystemId: t.ecosystemId,
        type: "FACT",
        content,
        embedding: fakeEmbedding(content),
      });
    }

    const hits = await knowledgeMemory.recallKnowledge(sql, {
      ecosystemId: t.ecosystemId,
      embedding: fakeEmbedding("postgres vacuum dead tuples"),
      limit: 3,
    });

    expect(hits[0]?.content).toContain("vacuum reclaims dead tuples");
    // Similarity must be monotonically non-increasing.
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]!.similarity).toBeLessThanOrEqual(hits[i - 1]!.similarity);
    }
    // The unrelated entry must rank last.
    expect(hits.at(-1)?.content).toContain("kubernetes");
  });

  it("honours a similarity floor", async () => {
    const t = await seedTenant(sql, "floor");
    const content = "sqlite writes are serialized by a single writer lock";
    await knowledgeMemory.insertKnowledgeMemory(sql, {
      id: t.ids.next("memory"),
      ecosystemId: t.ecosystemId,
      type: "FACT",
      content,
      embedding: fakeEmbedding(content),
    });

    const unrelated = await knowledgeMemory.recallKnowledge(sql, {
      ecosystemId: t.ecosystemId,
      embedding: fakeEmbedding("marine biology of coral reefs"),
      minSimilarity: 0.5,
    });
    expect(unrelated).toHaveLength(0);
  });

  it("scopes recall to one ecosystem", async () => {
    const a = await seedTenant(sql, "iso-a");
    const b = await seedTenant(sql, "iso-b");
    const content = "shared phrasing across two tenants";

    await knowledgeMemory.insertKnowledgeMemory(sql, {
      id: a.ids.next("memory"),
      ecosystemId: a.ecosystemId,
      type: "FACT",
      content,
      embedding: fakeEmbedding(content),
    });

    const fromB = await knowledgeMemory.recallKnowledge(sql, {
      ecosystemId: b.ecosystemId,
      embedding: fakeEmbedding(content),
    });
    expect(fromB).toHaveLength(0);
  });

  it("filters structural lessons by problem class", async () => {
    const t = await seedTenant(sql, "pc");
    await evolutionaryMemory.insertEvolutionaryMemory(sql, {
      id: t.ids.next("memory"),
      ecosystemId: t.ecosystemId,
      type: "STRUCTURAL_LEARNING",
      content: "adding a falsifier agent raised evidence quality",
      embedding: fakeEmbedding("falsifier agent evidence quality"),
      problemClass: "forecasting",
    });
    await evolutionaryMemory.insertEvolutionaryMemory(sql, {
      id: t.ids.next("memory"),
      ecosystemId: t.ecosystemId,
      type: "STRUCTURAL_LEARNING",
      content: "a second synthesizer added cost without accuracy",
      embedding: fakeEmbedding("second synthesizer cost accuracy"),
      problemClass: "code-review",
    });

    const forecasting = await evolutionaryMemory.recallStructuralLessons(sql, {
      ecosystemId: t.ecosystemId,
      embedding: fakeEmbedding("agent evidence quality"),
      problemClass: "forecasting",
    });
    expect(forecasting).toHaveLength(1);
    expect(forecasting[0]?.problem_class).toBe("forecasting");
  });
});
