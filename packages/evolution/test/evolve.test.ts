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

  it("names the structural change that produced the generation", async () => {
    // The lesson exists so the mutation engine can learn which structures work
    // for which problems. A lesson that records only the verdict, and says "no
    // structural change" about a generation a mutation demonstrably produced,
    // cannot serve that purpose — it is an outcome with no subject.
    const t = await seed();
    const simulator = scriptedWatcher(new SimulatorProvider(), [0.4, 0.7, 0.7]);

    const result = await evolveEcosystem(deps(t.ids, simulator), {
      ecosystemId: t.ecosystemId,
      fromVersionId: t.version.id,
      genome: t.genome,
      objective: "obj",
      seed: "lesson-names-change",
      maxGenerations: 2,
    });

    // Generation 1 really was produced by a mutation, recorded on generation 0.
    const producedByMutation = result.generations[0]?.mutation;
    expect(producedByMutation).toBeDefined();
    expect(producedByMutation!.summary).toContain("changed");

    const [lesson] = await sql<{ content: string }[]>`
      SELECT content FROM memories
      WHERE ecosystem_id = ${t.ecosystemId}
        AND scope = 'evolutionary' AND type = 'STRUCTURAL_LEARNING'
        AND content LIKE 'Generation 2%'
    `;
    expect(lesson).toBeDefined();
    expect(lesson!.content).not.toContain("no structural change");
    expect(lesson!.content).toContain(producedByMutation!.summary);
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

/**
 * The assessor seam.
 *
 * These exercise the wiring, not the statistics — a fake assessor keeps the
 * evolution package's tests free of any dependency on `@meta/bench`, and the
 * bootstrap that a real assessor uses is tested where it lives, in
 * `packages/bench/test/significance.test.ts`.
 */
function fakeAssessor(script: {
  /** Per-task scores handed out one array per `assess` call. */
  perCall: number[][];
  promote?: boolean;
  costUsd?: number;
}) {
  const calls: string[] = [];
  let index = 0;

  return {
    calls,
    assessor: {
      async assess(input: { label: string; genomeVersionId: string }) {
        calls.push(input.genomeVersionId);
        const scores = script.perCall[Math.min(index++, script.perCall.length - 1)] ?? [];
        return {
          score: scores.length === 0 ? null : scores.reduce((a, b) => a + b, 0) / scores.length,
          perTask: scores.map((score, i) => ({ taskId: `t${i}`, score })),
          costUsd: script.costUsd ?? 0,
          label: input.label,
        };
      },
      compare() {
        return {
          promote: script.promote ?? false,
          reason: script.promote ? "candidate better" : "indistinguishable from no difference",
        };
      },
    },
  };
}

describe("evolveEcosystem with a generation assessor", () => {
  it("promotes on the assessor's verdict", async () => {
    const t = await seed();
    const fake = fakeAssessor({ perCall: [[0.4, 0.4], [0.9, 0.9]], promote: true });

    const result = await evolveEcosystem(
      { ...deps(t.ids, scriptedWatcher(new SimulatorProvider(), [0.5, 0.5])), assessor: fake.assessor },
      {
        ecosystemId: t.ecosystemId,
        fromVersionId: t.version.id,
        genome: t.genome,
        objective: "obj",
        seed: "assessor-promote",
        maxGenerations: 2,
      },
    );

    expect(result.generations[1]?.outcome).toBe("promoted");
    expect(result.championVersionId).not.toBe(t.version.id);
    expect(result.generations[1]?.assessment?.verdict).toBe("candidate better");
  });

  it("rejects what the epsilon rule would have promoted", async () => {
    const t = await seed();
    // The Watcher score jumps 0.5 -> 0.9, which the default rule promotes on.
    // The assessor sees the per-task evidence and declines. This is the whole
    // point of the seam: one objective improving is not evidence.
    const fake = fakeAssessor({ perCall: [[0.5, 0.5], [0.55, 0.45]], promote: false });

    const result = await evolveEcosystem(
      { ...deps(t.ids, scriptedWatcher(new SimulatorProvider(), [0.5, 0.9, 0.9])), assessor: fake.assessor },
      {
        ecosystemId: t.ecosystemId,
        fromVersionId: t.version.id,
        genome: t.genome,
        objective: "obj",
        seed: "assessor-reject",
        maxGenerations: 2,
        patience: 1,
      },
    );

    expect(result.generations[1]?.outcome).toBe("rejected-regression");
    expect(result.championVersionId).toBe(t.version.id);
    expect(result.generations[1]?.note).toContain("indistinguishable");

    // The rejected version is still in the lineage — it was really tried.
    const versions = await genomes.listGenomeVersions(sql, t.ecosystemId);
    expect(versions.length).toBeGreaterThan(1);
  });

  it("assesses each version once and never re-measures the champion", async () => {
    const t = await seed();
    const fake = fakeAssessor({ perCall: [[0.4], [0.5], [0.6]], promote: false });

    await evolveEcosystem(
      { ...deps(t.ids, scriptedWatcher(new SimulatorProvider(), [0.4, 0.4, 0.4])), assessor: fake.assessor },
      {
        ecosystemId: t.ecosystemId,
        fromVersionId: t.version.id,
        genome: t.genome,
        objective: "obj",
        seed: "assessor-once",
        maxGenerations: 2,
        patience: 5,
      },
    );

    // Two generations, two assessments: the baseline and the one candidate. A
    // champion carried forward must not be paid for twice.
    expect(fake.calls.length).toBe(2);
    expect(new Set(fake.calls).size).toBe(2);
  });

  it("charges assessment spend against the evolution budget", async () => {
    const t = await seed();
    const fake = fakeAssessor({ perCall: [[0.4]], promote: false, costUsd: 5 });

    const result = await evolveEcosystem(
      { ...deps(t.ids, scriptedWatcher(new SimulatorProvider(), [0.4, 0.4])), assessor: fake.assessor },
      {
        ecosystemId: t.ecosystemId,
        fromVersionId: t.version.id,
        genome: t.genome,
        objective: "obj",
        seed: "assessor-budget",
        maxGenerations: 3,
        maxCostUsd: 4,
      },
    );

    // The baseline assessment alone exceeds the budget, so the loop stops after
    // generation 1 rather than treating assessment as free.
    expect(result.totalCostUsd).toBeGreaterThanOrEqual(5);
    expect(result.stoppedBecause).toBe("reached evolution budget");
    expect(result.generations.length).toBe(1);
  });
});
