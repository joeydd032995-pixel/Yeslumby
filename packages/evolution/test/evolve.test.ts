import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSql, migrate, genomes, type Sql } from "@meta/db";
import { Gateway, SimulatorProvider } from "@meta/gateway";
import { hashGenome, parseGenome, BALANCED_ANALYSIS } from "@meta/genome";
import { DeterministicEmbedder } from "@meta/memory";
import { DeterministicIds, FixedClock } from "@meta/shared";
import { evolveEcosystem } from "../src/evolve.js";

let sql: Sql;
const embedder = new DeterministicEmbedder();

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

/** A genome that permits unattended mutation, so the loop can actually run. */
function evolvable() {
  const g = structuredClone(BALANCED_ANALYSIS);
  g.mutationPolicy = {
    humanApprovalRequired: false,
    allowed: ["UPDATE_PROMPT", "ADD_EDGE", "REMOVE_EDGE"],
    maxMutationsPerRun: 3,
  };
  g.protocols = { maxRounds: 1 };
  g.stopCriteria = { maxIterations: 1, targetScore: 0.99 };
  return parseGenome(g);
}

async function seed(genome = evolvable()) {
  const ns = `ev${++counter}_${process.pid}`;
  const ids = new DeterministicIds(ns);
  const orgId = ids.next("org");
  const workspaceId = ids.next("workspace");
  const ecosystemId = ids.next("ecosystem");

  await sql`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, ${ns}, ${`o-${ns}`})`;
  await sql`INSERT INTO workspaces (id, org_id, name, slug) VALUES (${workspaceId}, ${orgId}, ${ns}, ${`w-${ns}`})`;
  await genomes.createEcosystem(sql, { id: ecosystemId, workspaceId, name: ns, slug: `e-${ns}` });

  const { version } = await genomes.createGenomeVersion(sql, {
    id: ids.next("genomeVersion"),
    ecosystemId,
    genome,
    origin: "SEED",
  });
  await genomes.setCurrentGenomeVersion(sql, ecosystemId, version.id);

  return { ns, ids, orgId, workspaceId, ecosystemId, genome, version };
}

/**
 * Script the Watcher so the generational loop is driven by the test rather than
 * by the simulator's random enum choice. `scores` is consumed one per call, so a
 * test can dictate the exact score trajectory across generations.
 */
function scriptedWatcher(simulator: SimulatorProvider, scores: number[]): SimulatorProvider {
  for (const overall of scores) {
    simulator.script(
      { systemContains: "Evaluate this organization" },
      {
        json: {
          scores: { overall },
          failureModes: [{ mode: "m", evidence: "e", severity: "low" }],
          suggestedMutations: [
            {
              type: "UPDATE_PROMPT",
              agentId: "skeptic",
              systemPrompt: `revision for score ${overall}`,
            },
          ],
          memoryRetention: { knowledge: [], structural: [] },
          recommendation: "mutate",
          rationale: "structural change proposed",
        },
      },
      1,
    );
  }
  return simulator;
}

function deps(ids: DeterministicIds, simulator: SimulatorProvider) {
  return {
    sql,
    gateway: new Gateway({
      providers: [simulator],
      sleep: async () => {},
      clock: new FixedClock(),
    }),
    clock: new FixedClock(),
    ids,
    embedder,
  };
}

describe("evolveEcosystem", () => {
  it("produces a new immutable version per generation", async () => {
    const t = await seed();
    const simulator = scriptedWatcher(new SimulatorProvider(), [0.5, 0.6, 0.7]);

    const result = await evolveEcosystem(deps(t.ids, simulator), {
      ecosystemId: t.ecosystemId,
      fromVersionId: t.version.id,
      genome: t.genome,
      objective: "Does the effect replicate?",
      seed: "evolve-seed",
      maxGenerations: 3,
    });

    expect(result.generations.length).toBeGreaterThan(1);

    const versions = await genomes.listGenomeVersions(sql, t.ecosystemId);
    expect(versions.length).toBeGreaterThan(1);

    // Every version has a distinct content hash, and v1 is untouched.
    const hashes = versions.map((v) => v.genome_hash);
    expect(new Set(hashes).size).toBe(hashes.length);
    const v1 = versions.find((v) => v.version === 1)!;
    expect(v1.genome_hash).toBe(hashGenome(t.genome));
  });

  it("records lineage linking each generation to its parent", async () => {
    const t = await seed();
    const simulator = scriptedWatcher(new SimulatorProvider(), [0.4, 0.6]);

    await evolveEcosystem(deps(t.ids, simulator), {
      ecosystemId: t.ecosystemId,
      fromVersionId: t.version.id,
      genome: t.genome,
      objective: "obj",
      seed: "lineage-seed",
      maxGenerations: 2,
    });

    const versions = await genomes.listGenomeVersions(sql, t.ecosystemId);
    const v2 = versions.find((v) => v.version === 2);
    expect(v2?.parent_ids).toEqual([t.version.id]);
    expect(v2?.origin).toBe("MUTATION");
  });

  it("does not promote a generation that scores worse", async () => {
    const t = await seed();
    // Generation 1 scores 0.8; generation 2 scores 0.3 — a clear regression.
    const simulator = scriptedWatcher(new SimulatorProvider(), [0.8, 0.3, 0.3]);

    const result = await evolveEcosystem(deps(t.ids, simulator), {
      ecosystemId: t.ecosystemId,
      fromVersionId: t.version.id,
      genome: t.genome,
      objective: "obj",
      seed: "regress-seed",
      maxGenerations: 3,
      patience: 1,
    });

    const regressed = result.generations.find((g) => g.generation === 1);
    expect(regressed?.outcome).toBe("rejected-regression");

    // The champion is the seed version, and the ecosystem points back at it.
    expect(result.championVersionId).toBe(t.version.id);
    expect(result.championScore).toBeCloseTo(0.8, 5);

    const ecosystem = await genomes.getEcosystem(sql, t.ecosystemId);
    expect(ecosystem?.current_genome_version_id).toBe(t.version.id);
  });

  it("keeps the losing version in the lineage rather than deleting it", async () => {
    const t = await seed();
    const simulator = scriptedWatcher(new SimulatorProvider(), [0.9, 0.2, 0.2]);

    await evolveEcosystem(deps(t.ids, simulator), {
      ecosystemId: t.ecosystemId,
      fromVersionId: t.version.id,
      genome: t.genome,
      objective: "obj",
      seed: "keep-loser",
      maxGenerations: 2,
      patience: 1,
    });

    // "We tried this and it was worse" is knowledge; the version stays.
    const versions = await genomes.listGenomeVersions(sql, t.ecosystemId);
    expect(versions.length).toBeGreaterThan(1);
  });

  it("promotes a generation that genuinely improves", async () => {
    const t = await seed();
    const simulator = scriptedWatcher(new SimulatorProvider(), [0.3, 0.8, 0.8]);

    const result = await evolveEcosystem(deps(t.ids, simulator), {
      ecosystemId: t.ecosystemId,
      fromVersionId: t.version.id,
      genome: t.genome,
      objective: "obj",
      seed: "improve-seed",
      maxGenerations: 2,
    });

    const second = result.generations.find((g) => g.generation === 1);
    expect(second?.outcome).toBe("promoted");
    expect(result.championVersionId).not.toBe(t.version.id);
    expect(result.championScore).toBeCloseTo(0.8, 5);

    const ecosystem = await genomes.getEcosystem(sql, t.ecosystemId);
    expect(ecosystem?.current_genome_version_id).toBe(result.championVersionId);
  });

  it("treats a marginal gain as no improvement", async () => {
    const t = await seed();
    // +0.002 against a 0.01 threshold: noise, not progress.
    const simulator = scriptedWatcher(new SimulatorProvider(), [0.5, 0.502, 0.502]);

    const result = await evolveEcosystem(deps(t.ids, simulator), {
      ecosystemId: t.ecosystemId,
      fromVersionId: t.version.id,
      genome: t.genome,
      objective: "obj",
      seed: "marginal",
      maxGenerations: 2,
      patience: 1,
      minImprovement: 0.01,
    });

    expect(result.generations[1]?.outcome).toBe("rejected-regression");
    expect(result.championVersionId).toBe(t.version.id);
  });

  it("stops after the configured patience", async () => {
    const t = await seed();
    const simulator = scriptedWatcher(new SimulatorProvider(), [0.7, 0.1, 0.1, 0.1, 0.1]);

    const result = await evolveEcosystem(deps(t.ids, simulator), {
      ecosystemId: t.ecosystemId,
      fromVersionId: t.version.id,
      genome: t.genome,
      objective: "obj",
      seed: "patience",
      maxGenerations: 5,
      patience: 2,
    });

    expect(result.stoppedBecause).toContain("no improvement");
    expect(result.generations.length).toBeLessThan(5);
  });

  it("halts at the approval gate instead of bypassing it", async () => {
    // Default policy requires human approval for watcher mutations.
    const gated = parseGenome({
      ...structuredClone(BALANCED_ANALYSIS),
      protocols: { maxRounds: 1 },
      stopCriteria: { maxIterations: 1 },
    });
    const t = await seed(gated);
    const simulator = scriptedWatcher(new SimulatorProvider(), [0.5, 0.9]);

    const result = await evolveEcosystem(deps(t.ids, simulator), {
      ecosystemId: t.ecosystemId,
      fromVersionId: t.version.id,
      genome: t.genome,
      objective: "obj",
      seed: "gated",
      maxGenerations: 3,
    });

    expect(result.stoppedBecause).toContain("human approval");
    // No new version was materialized without a human.
    const versions = await genomes.listGenomeVersions(sql, t.ecosystemId);
    expect(versions).toHaveLength(1);
  });

  it("stops when the watcher proposes no structural change", async () => {
    const t = await seed();
    const simulator = new SimulatorProvider();
    simulator.script(
      { systemContains: "Evaluate this organization" },
      {
        json: {
          scores: { overall: 0.6 },
          failureModes: [],
          suggestedMutations: [],
          memoryRetention: { knowledge: [], structural: [] },
          recommendation: "continue",
          rationale: "nothing to change",
        },
      },
    );

    const result = await evolveEcosystem(deps(t.ids, simulator), {
      ecosystemId: t.ecosystemId,
      fromVersionId: t.version.id,
      genome: t.genome,
      objective: "obj",
      seed: "nochange",
      maxGenerations: 3,
    });

    expect(result.stoppedBecause).toContain("no structural change");
    expect(result.generations).toHaveLength(1);
  });

  it("respects the evolution budget", async () => {
    const t = await seed();
    const simulator = scriptedWatcher(new SimulatorProvider(), [0.3, 0.4, 0.5, 0.6]);

    const result = await evolveEcosystem(deps(t.ids, simulator), {
      ecosystemId: t.ecosystemId,
      fromVersionId: t.version.id,
      genome: t.genome,
      objective: "obj",
      seed: "budget",
      maxGenerations: 4,
      maxCostUsd: 0.0000001,
    });

    expect(result.stoppedBecause).toContain("budget");
    expect(result.generations).toHaveLength(1);
  });

  it("writes a structural lesson for each generation after the first", async () => {
    const t = await seed();
    const simulator = scriptedWatcher(new SimulatorProvider(), [0.4, 0.7]);

    await evolveEcosystem(deps(t.ids, simulator), {
      ecosystemId: t.ecosystemId,
      fromVersionId: t.version.id,
      genome: t.genome,
      objective: "obj",
      seed: "lesson",
      maxGenerations: 2,
    });

    const rows = await sql<{ content: string }[]>`
      SELECT content FROM memories
      WHERE ecosystem_id = ${t.ecosystemId}
        AND scope = 'evolutionary' AND type = 'STRUCTURAL_LEARNING'
    `;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.content.includes("Generation 2"))).toBe(true);
  });

  it("is reproducible for the same seed", async () => {
    const a = await seed();
    const b = await seed();

    const run = async (t: Awaited<ReturnType<typeof seed>>) =>
      evolveEcosystem(deps(t.ids, scriptedWatcher(new SimulatorProvider(), [0.4, 0.7])), {
        ecosystemId: t.ecosystemId,
        fromVersionId: t.version.id,
        genome: t.genome,
        objective: "Does the effect replicate?",
        seed: "identical-seed",
        maxGenerations: 2,
      });

    const ra = await run(a);
    const rb = await run(b);

    expect(ra.generations.map((g) => g.genomeHash)).toEqual(
      rb.generations.map((g) => g.genomeHash),
    );
    expect(ra.stoppedBecause).toBe(rb.stoppedBecause);
  });
});
