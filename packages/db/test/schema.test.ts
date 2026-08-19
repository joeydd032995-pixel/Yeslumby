import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { genomes, tenancy, type Sql } from "../src/index.js";
import { contentHash } from "@meta/shared";
import { ensureSchema, seedTenant, testSql } from "./helpers.js";

let sql: Sql;

beforeAll(async () => {
  sql = testSql();
  await ensureSchema(sql);
});

afterAll(async () => {
  await sql.end();
});

describe("genome_versions immutability", () => {
  it("rejects UPDATE at the database level", async () => {
    const t = await seedTenant(sql, "imm");
    const { version } = await genomes.createGenomeVersion(sql, {
      id: t.ids.next("genomeVersion"),
      ecosystemId: t.ecosystemId,
      genomeHash: contentHash({ a: 1 }),
      genome: { a: 1 },
      origin: "SEED",
    });

    // The point of the trigger is that this fails even for a caller going
    // straight to SQL, not just for callers who use the repository.
    await expect(
      sql`UPDATE genome_versions SET genome = ${sql.json({ a: 2 } as never)} WHERE id = ${version.id}`,
    ).rejects.toThrow(/cannot change/);
  });

  it("rejects DELETE at the database level", async () => {
    const t = await seedTenant(sql, "immd");
    const { version } = await genomes.createGenomeVersion(sql, {
      id: t.ids.next("genomeVersion"),
      ecosystemId: t.ecosystemId,
      genomeHash: contentHash({ b: 1 }),
      genome: { b: 1 },
      origin: "SEED",
    });

    await expect(
      sql`DELETE FROM genome_versions WHERE id = ${version.id}`,
    ).rejects.toThrow(/append-only/);
  });
});

describe("createGenomeVersion", () => {
  it("allocates monotonic version numbers per ecosystem", async () => {
    const t = await seedTenant(sql, "ver");
    const made = [];
    for (let i = 1; i <= 3; i++) {
      const { version } = await genomes.createGenomeVersion(sql, {
        id: t.ids.next("genomeVersion"),
        ecosystemId: t.ecosystemId,
        genomeHash: contentHash({ i }),
        genome: { i },
        origin: i === 1 ? "SEED" : "MUTATION",
      });
      made.push(version.version);
    }
    expect(made).toEqual([1, 2, 3]);
  });

  it("returns the existing version when content is identical, rather than forking lineage", async () => {
    const t = await seedTenant(sql, "dedupe");
    const genome = { agents: ["a", "b"], protocols: { maxRounds: 2 } };
    const hash = contentHash(genome);

    const first = await genomes.createGenomeVersion(sql, {
      id: t.ids.next("genomeVersion"),
      ecosystemId: t.ecosystemId,
      genomeHash: hash,
      genome,
      origin: "SEED",
    });
    const second = await genomes.createGenomeVersion(sql, {
      id: t.ids.next("genomeVersion"),
      ecosystemId: t.ecosystemId,
      genomeHash: hash,
      genome,
      origin: "MUTATION",
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.version.id).toBe(first.version.id);
    expect(second.version.version).toBe(1);
  });

  it("allocates versions safely under concurrency", async () => {
    const t = await seedTenant(sql, "race");
    // Without the advisory lock these would all read MAX(version)=0 and collide.
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        genomes.createGenomeVersion(sql, {
          id: t.ids.next("genomeVersion"),
          ecosystemId: t.ecosystemId,
          genomeHash: contentHash({ concurrent: i }),
          genome: { concurrent: i },
          origin: "MUTATION",
        }),
      ),
    );
    const versions = results.map((r) => r.version.version).sort((a, b) => a - b);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("lineage", () => {
  it("walks a breeding DAG with two parents without revisiting shared ancestors", async () => {
    const t = await seedTenant(sql, "lin");

    const root = (
      await genomes.createGenomeVersion(sql, {
        id: t.ids.next("genomeVersion"),
        ecosystemId: t.ecosystemId,
        genomeHash: contentHash({ n: "root" }),
        genome: { n: "root" },
        origin: "SEED",
      })
    ).version;

    const left = (
      await genomes.createGenomeVersion(sql, {
        id: t.ids.next("genomeVersion"),
        ecosystemId: t.ecosystemId,
        genomeHash: contentHash({ n: "left" }),
        genome: { n: "left" },
        parentIds: [root.id],
        origin: "MUTATION",
      })
    ).version;

    const right = (
      await genomes.createGenomeVersion(sql, {
        id: t.ids.next("genomeVersion"),
        ecosystemId: t.ecosystemId,
        genomeHash: contentHash({ n: "right" }),
        genome: { n: "right" },
        parentIds: [root.id],
        origin: "MUTATION",
      })
    ).version;

    // Both parents descend from `root`, so a naive walk would emit it twice.
    const child = (
      await genomes.createGenomeVersion(sql, {
        id: t.ids.next("genomeVersion"),
        ecosystemId: t.ecosystemId,
        genomeHash: contentHash({ n: "child" }),
        genome: { n: "child" },
        parentIds: [left.id, right.id],
        origin: "BREEDING",
      })
    ).version;

    const lineage = await genomes.getLineage(sql, child.id);
    const ids = lineage.map((r) => r.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(root.id);
    expect(ids).toContain(left.id);
    expect(ids).toContain(right.id);
    expect(lineage.find((r) => r.id === child.id)?.depth).toBe(0);
    expect(lineage.find((r) => r.id === root.id)?.depth).toBe(2);
  });

  it("lists direct descendants", async () => {
    const t = await seedTenant(sql, "desc");
    const parent = (
      await genomes.createGenomeVersion(sql, {
        id: t.ids.next("genomeVersion"),
        ecosystemId: t.ecosystemId,
        genomeHash: contentHash({ p: 1 }),
        genome: { p: 1 },
        origin: "SEED",
      })
    ).version;

    await genomes.createGenomeVersion(sql, {
      id: t.ids.next("genomeVersion"),
      ecosystemId: t.ecosystemId,
      genomeHash: contentHash({ c: 1 }),
      genome: { c: 1 },
      parentIds: [parent.id],
      origin: "MUTATION",
    });

    const kids = await genomes.getDescendants(sql, parent.id);
    expect(kids).toHaveLength(1);
  });
});

describe("immutability is about identity, not attribution", () => {
  it("still rejects a change to genome content", async () => {
    const t = await seedTenant(sql, "immc");
    const { version } = await genomes.createGenomeVersion(sql, {
      id: t.ids.next("genomeVersion"),
      ecosystemId: t.ecosystemId,
      genome: { c: 1 },
      origin: "SEED",
    });
    await expect(
      sql`UPDATE genome_versions SET genome = ${sql.json({ c: 2 } as never)} WHERE id = ${version.id}`,
    ).rejects.toThrow(/content and lineage cannot change/);
  });

  it("still rejects a change to lineage", async () => {
    const t = await seedTenant(sql, "imml");
    const { version } = await genomes.createGenomeVersion(sql, {
      id: t.ids.next("genomeVersion"),
      ecosystemId: t.ecosystemId,
      genome: { l: 1 },
      origin: "SEED",
    });
    await expect(
      sql`UPDATE genome_versions SET parent_ids = ARRAY['forged'] WHERE id = ${version.id}`,
    ).rejects.toThrow(/content and lineage cannot change/);
  });

  it("permits nulling attribution, so a user can actually be erased", async () => {
    const t = await seedTenant(sql, "immattr");
    const { version } = await genomes.createGenomeVersion(sql, {
      id: t.ids.next("genomeVersion"),
      ecosystemId: t.ecosystemId,
      genome: { a: 1 },
      origin: "SEED",
      createdBy: t.userId,
    });
    expect(version.created_by).toBe(t.userId);

    // ON DELETE SET NULL is an UPDATE. Before this was allowed, the referential
    // action could never fire and deleting the author was impossible.
    await expect(sql`DELETE FROM users WHERE id = ${t.userId}`).resolves.toBeDefined();

    const after = await genomes.getGenomeVersion(sql, version.id);
    expect(after?.created_by).toBeNull();
    // Content and hash are untouched.
    expect(after?.genome_hash).toBe(version.genome_hash);
  });

  it("still refuses a bare DELETE", async () => {
    const t = await seedTenant(sql, "immdel2");
    const { version } = await genomes.createGenomeVersion(sql, {
      id: t.ids.next("genomeVersion"),
      ecosystemId: t.ecosystemId,
      genome: { d: 1 },
      origin: "SEED",
    });
    await expect(
      sql`DELETE FROM genome_versions WHERE id = ${version.id}`,
    ).rejects.toThrow(/DELETE is forbidden/);
  });

  it("permits erasure through the explicit purge path", async () => {
    const t = await seedTenant(sql, "purge");
    await genomes.createGenomeVersion(sql, {
      id: t.ids.next("genomeVersion"),
      ecosystemId: t.ecosystemId,
      genome: { p: 1 },
      origin: "SEED",
    });

    await tenancy.purgeEcosystem(sql, t.ecosystemId);

    expect(await genomes.getEcosystem(sql, t.ecosystemId)).toBeUndefined();
    const remaining = await genomes.listGenomeVersions(sql, t.ecosystemId);
    expect(remaining).toHaveLength(0);
  });

  it("scopes the purge permission to its own transaction", async () => {
    const t = await seedTenant(sql, "purgescope");
    const { version } = await genomes.createGenomeVersion(sql, {
      id: t.ids.next("genomeVersion"),
      ecosystemId: t.ecosystemId,
      genome: { s: 1 },
      origin: "SEED",
    });

    await tenancy.purgeEcosystem(sql, t.ecosystemId);

    // SET LOCAL reverts on commit, so the next statement is guarded again.
    const other = await seedTenant(sql, "purgescope2");
    const { version: v2 } = await genomes.createGenomeVersion(sql, {
      id: other.ids.next("genomeVersion"),
      ecosystemId: other.ecosystemId,
      genome: { s: 2 },
      origin: "SEED",
    });
    await expect(
      sql`DELETE FROM genome_versions WHERE id = ${v2.id}`,
    ).rejects.toThrow(/DELETE is forbidden/);
    expect(version.id).toBeTruthy();
  });
});
