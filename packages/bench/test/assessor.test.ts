import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSql, migrate, genomes, type Sql } from "@meta/db";
import { Gateway, SimulatorProvider } from "@meta/gateway";
import { parseGenome, BALANCED_ANALYSIS } from "@meta/genome";
import { DeterministicIds, FixedClock } from "@meta/shared";
import type { GenerationAssessment } from "@meta/evolution";
import { createBenchmarkAssessor } from "../src/assessor.js";
import { SMOKE_SUITE, STANDARD_SUITE } from "../src/suites.js";

let sql: Sql;

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

async function seedEcosystem() {
  const ns = `as${++counter}_${process.pid}`;
  const ids = new DeterministicIds(ns);
  const orgId = ids.next("org");
  const workspaceId = ids.next("workspace");
  const ecosystemId = ids.next("ecosystem");

  await sql`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, ${ns}, ${`o-${ns}`})`;
  await sql`INSERT INTO workspaces (id, org_id, name, slug) VALUES (${workspaceId}, ${orgId}, ${ns}, ${`w-${ns}`})`;
  await genomes.createEcosystem(sql, { id: ecosystemId, workspaceId, name: ns, slug: `e-${ns}` });

  const genome = parseGenome(BALANCED_ANALYSIS);
  const { version } = await genomes.createGenomeVersion(sql, {
    id: ids.next("genomeVersion"),
    ecosystemId,
    genome,
    origin: "SEED",
  });

  return { ids, ecosystemId, genome, version };
}

function benchDeps(ids: DeterministicIds) {
  return {
    sql,
    gateway: new Gateway({
      providers: [new SimulatorProvider()],
      sleep: async () => {},
      clock: new FixedClock(),
    }),
    clock: new FixedClock(),
    ids,
  };
}

/** Build an assessment without running anything, for the pure `compare` path. */
function assessment(label: string, scores: Record<string, number>): GenerationAssessment {
  const perTask = Object.entries(scores).map(([taskId, score]) => ({ taskId, score }));
  return {
    label,
    perTask,
    score: perTask.reduce((s, t) => s + t.score, 0) / (perTask.length || 1),
    costUsd: 0,
  };
}

describe("createBenchmarkAssessor.assess", () => {
  it("returns a score per suite task and reports its own spend", async () => {
    const t = await seedEcosystem();
    const assessor = createBenchmarkAssessor({
      deps: benchDeps(t.ids),
      suite: SMOKE_SUITE,
    });

    const result = await assessor.assess({
      ecosystemId: t.ecosystemId,
      genomeVersionId: t.version.id,
      genome: t.genome,
      label: "generation 1",
    });

    expect(result.perTask).toHaveLength(SMOKE_SUITE.tasks.length);
    expect(result.perTask?.[0]?.taskId).toBe(SMOKE_SUITE.tasks[0]!.id);
    expect(result.score).not.toBeNull();
    expect(result.costUsd).toBeGreaterThanOrEqual(0);
    // The hash identifies what was measured; two generations can share a label.
    expect(result.label).toContain("generation 1");
  });
});

describe("createBenchmarkAssessor.compare", () => {
  const assessor = () =>
    createBenchmarkAssessor({
      // `compare` touches neither, but the factory requires them.
      deps: benchDeps(new DeterministicIds("cmp")),
      suite: STANDARD_SUITE,
      seed: "fixed",
    });

  it("promotes a candidate that wins consistently across tasks", () => {
    const champion = assessment("champ", {
      a: 0.50, b: 0.52, c: 0.48, d: 0.51, e: 0.49, f: 0.50, g: 0.53, h: 0.47,
    });
    const candidate = assessment("cand", {
      a: 0.70, b: 0.72, c: 0.68, d: 0.71, e: 0.69, f: 0.70, g: 0.73, h: 0.67,
    });

    const verdict = assessor().compare(champion, candidate);

    expect(verdict.promote).toBe(true);
    expect(verdict.reason).toContain("candidate better");
  });

  it("declines to promote when the difference is inside the noise", () => {
    const champion = assessment("champ", {
      a: 0.50, b: 0.80, c: 0.30, d: 0.65, e: 0.45, f: 0.70, g: 0.35, h: 0.60,
    });
    const candidate = assessment("cand", {
      a: 0.72, b: 0.55, c: 0.58, d: 0.40, e: 0.68, f: 0.44, g: 0.61, h: 0.51,
    });

    const verdict = assessor().compare(champion, candidate);

    expect(verdict.promote).toBe(false);
    expect(verdict.reason).toContain("indistinguishable");
  });

  it("never promotes a candidate that is worse", () => {
    const champion = assessment("champ", {
      a: 0.80, b: 0.82, c: 0.78, d: 0.81, e: 0.79, f: 0.80,
    });
    const candidate = assessment("cand", {
      a: 0.30, b: 0.32, c: 0.28, d: 0.31, e: 0.29, f: 0.30,
    });

    const verdict = assessor().compare(champion, candidate);

    expect(verdict.promote).toBe(false);
    expect(verdict.reason).toContain("candidate worse");
  });

  it("pairs by task id rather than by position", () => {
    // Same scores, opposite insertion order. Pairing positionally would compare
    // the candidate's best task against the champion's worst and invent an effect.
    const champion = assessment("champ", { a: 0.2, b: 0.4, c: 0.6, d: 0.8, e: 0.5, f: 0.3 });
    const candidate: GenerationAssessment = {
      ...champion,
      label: "cand",
      perTask: [...(champion.perTask ?? [])].reverse(),
    };

    const verdict = assessor().compare(champion, candidate);

    expect(verdict.promote).toBe(false);
    expect(verdict.reason).toContain("0.000");
  });

  it("retains the champion when no task completed on both sides", () => {
    const champion = assessment("champ", { a: 0.5, b: 0.6, c: 0.7 });
    const candidate = assessment("cand", { x: 0.9, y: 0.9, z: 0.9 });

    const verdict = assessor().compare(champion, candidate);

    expect(verdict.promote).toBe(false);
    expect(verdict.reason).toContain("nothing to compare");
  });

  it("compares only the tasks both genomes completed", () => {
    // The candidate failed task `h`, which runBenchmark records in `failures`
    // and omits from `tasks`. The comparison must shrink to the paired subset
    // rather than treating the missing task as a loss.
    const champion = assessment("champ", {
      a: 0.50, b: 0.52, c: 0.48, d: 0.51, e: 0.49, f: 0.50, g: 0.53, h: 0.47,
    });
    const candidate = assessment("cand", {
      a: 0.70, b: 0.72, c: 0.68, d: 0.71, e: 0.69, f: 0.70, g: 0.73,
    });

    const verdict = assessor().compare(champion, candidate);

    expect(verdict.promote).toBe(true);
    expect(verdict.reason).toContain("n=7");
  });

  it("is reproducible: the same comparison replays identically", () => {
    const champion = assessment("champ", { a: 0.5, b: 0.55, c: 0.45, d: 0.6, e: 0.5, f: 0.52 });
    const candidate = assessment("cand", { a: 0.6, b: 0.5, c: 0.7, d: 0.55, e: 0.62, f: 0.48 });

    const first = assessor().compare(champion, candidate);
    const second = assessor().compare(champion, candidate);

    expect(first).toEqual(second);
  });
});
