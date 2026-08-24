import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSql, migrate, genomes, mutations, type Sql } from "@meta/db";
import {
  BALANCED_ANALYSIS,
  ADVERSARIAL_RESEARCH,
  RAPID_TRIAGE,
  checkInvariants,
  hashGenome,
  loadTemplate,
  parseGenome,
  type MutationPatchInput,
} from "@meta/genome";
import { DeterministicIds, createRng } from "@meta/shared";
import { DeterministicEmbedder, consolidateStructural } from "@meta/memory";
import {
  classifyObjective,
  UNCLASSIFIED_CONFIDENCE,
  crossover,
  forkEcosystem,
  proposeAndApplyMutation,
  recommendGenome,
  repair,
} from "../src/index.js";

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

async function seed(genomeInput = BALANCED_ANALYSIS) {
  const ns = `ev${++counter}_${process.pid}`;
  const ids = new DeterministicIds(ns);
  const orgId = ids.next("org");
  const workspaceId = ids.next("workspace");
  const ecosystemId = ids.next("ecosystem");

  await sql`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, ${ns}, ${`o-${ns}`})`;
  await sql`INSERT INTO workspaces (id, org_id, name, slug) VALUES (${workspaceId}, ${orgId}, ${ns}, ${`w-${ns}`})`;
  await genomes.createEcosystem(sql, {
    id: ecosystemId,
    workspaceId,
    name: ns,
    slug: `e-${ns}`,
  });

  const genome = parseGenome(genomeInput);
  const { version } = await genomes.createGenomeVersion(sql, {
    id: ids.next("genomeVersion"),
    ecosystemId,
    genome,
    origin: "SEED",
  });
  await genomes.setCurrentGenomeVersion(sql, ecosystemId, version.id);

  return { ns, ids, orgId, workspaceId, ecosystemId, genome, version };
}

describe("mutation engine", () => {
  const patch: MutationPatchInput = {
    type: "UPDATE_PROMPT",
    agentId: "skeptic",
    systemPrompt: "Attack the load-bearing assumption first.",
  };

  it("holds a watcher mutation for approval without touching the lineage", async () => {
    const t = await seed();
    const result = await proposeAndApplyMutation(
      { sql, ids: t.ids },
      {
        ecosystemId: t.ecosystemId,
        fromVersionId: t.version.id,
        genome: t.genome,
        patches: [patch],
        actor: "WATCHER",
        rationale: "skeptic was conceding too readily",
      },
    );

    expect(result.status).toBe("awaiting_approval");
    // The proposal exists and is inspectable, but no new version was created.
    const versions = await genomes.listGenomeVersions(sql, t.ecosystemId);
    expect(versions).toHaveLength(1);
  });

  it("creates a new immutable version once approved", async () => {
    const t = await seed();
    const result = await proposeAndApplyMutation(
      { sql, ids: t.ids },
      {
        ecosystemId: t.ecosystemId,
        fromVersionId: t.version.id,
        genome: t.genome,
        patches: [patch],
        actor: "WATCHER",
        humanApproved: true,
      },
    );

    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;

    expect(result.version).toBe(2);
    expect(result.diff.agentsChanged).toEqual([{ id: "skeptic", fields: ["systemPrompt"] }]);

    // v1 is untouched: rollback is selecting it again, not undoing anything.
    const v1 = await genomes.getGenomeVersionByNumber(sql, t.ecosystemId, 1);
    expect(hashGenome(parseGenome(v1!.genome))).toBe(hashGenome(t.genome));

    const v2 = await genomes.getGenomeVersion(sql, result.versionId);
    expect(v2?.parent_ids).toEqual([t.version.id]);
  });

  it("rejects a watcher patch that would widen permissions", async () => {
    const g = structuredClone(BALANCED_ANALYSIS);
    g.mutationPolicy = { humanApprovalRequired: true, allowed: ["UPDATE_CAPABILITIES"] };
    const t = await seed(g);

    const result = await proposeAndApplyMutation(
      { sql, ids: t.ids },
      {
        ecosystemId: t.ecosystemId,
        fromVersionId: t.version.id,
        genome: t.genome,
        patches: [
          { type: "UPDATE_CAPABILITIES", agentId: "skeptic", capabilities: ["code_execution"] },
        ],
        actor: "WATCHER",
        // Approved as a mutation generally, but privilege widening needs an
        // explicit human decision regardless.
        humanApproved: false,
      },
    );

    expect(result.status).toBe("awaiting_approval");
  });

  it("records a rejected mutation rather than swallowing it", async () => {
    const t = await seed();
    const result = await proposeAndApplyMutation(
      { sql, ids: t.ids },
      {
        ecosystemId: t.ecosystemId,
        fromVersionId: t.version.id,
        genome: t.genome,
        // Not in the default allowed list.
        patches: [{ type: "REMOVE_AGENT", agentId: "skeptic" }],
        actor: "HUMAN",
      },
    );

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;

    // A component repeatedly proposing forbidden patches is itself a signal.
    const record = await mutations.getMutation(sql, result.mutationId);
    expect(record?.status).toBe("REJECTED");
    expect(record?.rejection_reason).toContain("not in mutationPolicy.allowed");
  });

  it("reports a no-op rather than forking the lineage", async () => {
    const t = await seed();
    const result = await proposeAndApplyMutation(
      { sql, ids: t.ids },
      {
        ecosystemId: t.ecosystemId,
        fromVersionId: t.version.id,
        genome: t.genome,
        // Adding an edge that already exists changes nothing.
        patches: [
          {
            type: "ADD_EDGE",
            edge: { from: "skeptic", to: "empiricist", interaction: "challenge" },
          },
        ],
        actor: "HUMAN",
      },
    );
    expect(result.status).toBe("no_op");
    expect(await genomes.listGenomeVersions(sql, t.ecosystemId)).toHaveLength(1);
  });

  it("writes a structural lesson when memory is wired in", async () => {
    const t = await seed();
    const result = await proposeAndApplyMutation(
      {
        sql,
        ids: t.ids,
        memory: { sql, embedder, ecosystemId: t.ecosystemId, policy: t.genome.memoryPolicy },
      },
      {
        ecosystemId: t.ecosystemId,
        fromVersionId: t.version.id,
        genome: t.genome,
        patches: [patch],
        actor: "HUMAN",
        rationale: "sharpen the skeptic",
      },
    );
    expect(result.status).toBe("applied");

    const [row] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM memories
      WHERE ecosystem_id = ${t.ecosystemId} AND type = 'MUTATION_OUTCOME'
    `;
    expect(Number(row?.count)).toBe(1);
  });
});

describe("breeding", () => {
  it("produces valid children from two valid parents", async () => {
    const a = parseGenome(BALANCED_ANALYSIS);
    const b = parseGenome(ADVERSARIAL_RESEARCH);

    const candidates = crossover(a, b, { seed: "breed-1" });
    expect(candidates.length).toBeGreaterThan(0);

    for (const candidate of candidates) {
      // The interesting property: naive composition is almost always invalid,
      // so this is really testing repair().
      expect(checkInvariants(candidate.genome).ok, candidate.strategy).toBe(true);
    }
  });

  it("is deterministic for the same seed", () => {
    const a = parseGenome(BALANCED_ANALYSIS);
    const b = parseGenome(RAPID_TRIAGE);
    const first = crossover(a, b, { seed: "stable" }).map((c) => c.hash);
    const second = crossover(a, b, { seed: "stable" }).map((c) => c.hash);
    expect(first).toEqual(second);
  });

  it("never emits a child identical to a parent", () => {
    const a = parseGenome(BALANCED_ANALYSIS);
    const b = parseGenome(ADVERSARIAL_RESEARCH);
    const parents = new Set([hashGenome(a), hashGenome(b)]);
    for (const candidate of crossover(a, b, { seed: "distinct" })) {
      // Re-measuring a genome already ranked teaches the benchmark nothing.
      expect(parents.has(candidate.hash)).toBe(false);
    }
  });

  it("carries cognitive modes from both parents under role-union", () => {
    const a = parseGenome(BALANCED_ANALYSIS);
    const b = parseGenome(ADVERSARIAL_RESEARCH);
    const union = crossover(a, b, { seed: "u", strategies: ["role-union"] })[0];
    expect(union).toBeDefined();

    const childModes = new Set(union!.genome.agents.map((x) => x.cognitiveMode));
    const parentModes = new Set([
      ...a.agents.map((x) => x.cognitiveMode),
      ...b.agents.map((x) => x.cognitiveMode),
    ]);
    for (const mode of childModes) expect(parentModes.has(mode)).toBe(true);
    expect(childModes.size).toBeGreaterThan(1);
  });

  it("repairs an organization left without a synthesizer", () => {
    const broken = {
      ...parseGenome(BALANCED_ANALYSIS),
      synthesizerId: "nobody",
    };
    const fixed = repair(broken, createRng("repair"));
    expect(fixed.agents.some((x) => x.id === fixed.synthesizerId)).toBe(true);
    expect(checkInvariants(fixed).ok).toBe(true);
  });

  it("repairs dangling edges left by composition", () => {
    const base = parseGenome(BALANCED_ANALYSIS);
    const broken = {
      ...base,
      edges: [...base.edges, { from: "ghost", to: "skeptic", interaction: "challenge" as const, weight: 1 }],
    };
    const fixed = repair(broken, createRng("dangle"));
    expect(fixed.edges.some((e) => e.from === "ghost")).toBe(false);
    expect(checkInvariants(fixed).ok).toBe(true);
  });

  it("enforces the agent cap while keeping the synthesizer", () => {
    const base = parseGenome(BALANCED_ANALYSIS);
    const oversized = {
      ...base,
      mutationPolicy: { ...base.mutationPolicy, maxAgents: 2 },
    };
    const fixed = repair(oversized, createRng("cap"));
    expect(fixed.agents.length).toBeLessThanOrEqual(2);
    expect(fixed.agents.some((a) => a.id === fixed.synthesizerId)).toBe(true);
  });
});

describe("forking", () => {
  it("copies the genome and records lineage in both directions", async () => {
    const source = await seed();
    const target = await seed();

    const fork = await forkEcosystem(
      { sql, ids: target.ids },
      {
        sourceEcosystemId: source.ecosystemId,
        sourceVersionId: source.version.id,
        targetWorkspaceId: target.workspaceId,
        name: "Forked",
        slug: `fork-${target.ns}`,
      },
    );

    const ecosystem = await genomes.getEcosystem(sql, fork.ecosystemId);
    expect(ecosystem?.forked_from_ecosystem_id).toBe(source.ecosystemId);
    expect(ecosystem?.forked_from_version_id).toBe(source.version.id);

    // The source version is a real parent, so the evolution graph spans the
    // fork rather than the copy appearing from nowhere.
    const version = await genomes.getGenomeVersion(sql, fork.versionId);
    expect(version?.parent_ids).toEqual([source.version.id]);
    expect(version?.origin).toBe("FORK");

    expect(hashGenome(fork.genome)).toBe(hashGenome(source.genome));
  });

  it("inherits the architecture but not the run history", async () => {
    const source = await seed();
    const target = await seed();

    await sql`
      INSERT INTO memories (id, ecosystem_id, scope, type, content)
      VALUES (${source.ids.next("memory")}, ${source.ecosystemId}, 'knowledge', 'FACT', 'private finding')
    `;

    const fork = await forkEcosystem(
      { sql, ids: target.ids },
      {
        sourceEcosystemId: source.ecosystemId,
        sourceVersionId: source.version.id,
        targetWorkspaceId: target.workspaceId,
        name: "Forked",
        slug: `fork2-${target.ns}`,
      },
    );

    const [row] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM memories WHERE ecosystem_id = ${fork.ecosystemId}
    `;
    // A fork inherits an architecture, not someone else's evidence.
    expect(row?.count).toBe("0");
  });

  it("refuses a version that belongs to a different ecosystem", async () => {
    const a = await seed();
    const b = await seed();
    await expect(
      forkEcosystem(
        { sql, ids: b.ids },
        {
          sourceEcosystemId: a.ecosystemId,
          sourceVersionId: b.version.id,
          targetWorkspaceId: b.workspaceId,
          name: "Bad",
          slug: `bad-${b.ns}`,
        },
      ),
    ).rejects.toThrow(/does not belong/);
  });
});

describe("genome recommendation", () => {
  it("classifies an empirical question toward the research architecture", () => {
    const c = classifyObjective(
      "Does the evidence from these replication studies support the original causal claim?",
    );
    expect(c.problemClass).toBe("empirical-research");
    expect(c.templateKey).toBe("adversarial-research");
  });

  it("classifies a high-volume task toward the cheap architecture", () => {
    const c = classifyObjective("Quickly classify and route this bulk support ticket");
    expect(c.templateKey).toBe("rapid-triage");
  });

  it("keeps confidence honest for an unclassifiable objective", () => {
    const c = classifyObjective("hello");
    expect(c.confidence).toBeLessThan(0.5);
  });

  it("reports the unclassified floor exactly, so a caller can recognise a guess", () => {
    // The landing page branches on this to present a default as a default
    // rather than as a recommendation. A caller cannot do that against a
    // literal buried in the classifier, which is why the value is exported.
    expect(classifyObjective("hello").confidence).toBe(UNCLASSIFIED_CONFIDENCE);
    expect(classifyObjective("Does the effect replicate?").confidence).toBeGreaterThan(
      UNCLASSIFIED_CONFIDENCE,
    );
  });

  it("returns a runnable genome and named alternatives", async () => {
    const rec = await recommendGenome(
      { sql, embedder },
      { objective: "Assess whether we should migrate to microservices" },
    );
    expect(checkInvariants(rec.genome).ok).toBe(true);
    expect(rec.alternatives.length).toBeGreaterThan(0);
    expect(rec.alternatives.every((a) => a.templateKey !== rec.templateKey)).toBe(true);
  });

  it("lets a prior structural lesson override the keyword guess", async () => {
    const t = await seed();
    // A real run learned that triage suits this class better than the keywords
    // suggest. Evolutionary memory is the whole point: the recommendation
    // should improve as the ecosystem learns.
    await consolidateStructural(
      { sql, embedder, ids: t.ids, ecosystemId: t.ecosystemId, policy: t.genome.memoryPolicy },
      [
        {
          content:
            "For these analysis tasks the rapid-triage architecture matched deeper " +
            "organizations at a fraction of the cost.",
          problemClass: "general-analysis",
          importance: 0.9,
        },
      ],
    );

    const baseline = classifyObjective("Assess and compare these deployment strategies");
    expect(baseline.templateKey).toBe("balanced-analysis");

    const rec = await recommendGenome(
      { sql, embedder },
      {
        objective: "Assess and compare these deployment strategies",
        visibleEcosystemIds: [t.ecosystemId],
      },
    );

    expect(rec.templateKey).toBe("rapid-triage");
    expect(rec.rationale).toContain("Prior runs");
    expect(rec.lessons.length).toBeGreaterThan(0);
  });

  it("ignores lessons from ecosystems the caller cannot see", async () => {
    const t = await seed();
    await consolidateStructural(
      { sql, embedder, ids: t.ids, ecosystemId: t.ecosystemId, policy: t.genome.memoryPolicy },
      [
        {
          content: "the rapid-triage architecture wins here",
          problemClass: "general-analysis",
          importance: 0.95,
        },
      ],
    );

    // No visible ecosystems supplied: authorization is the caller's decision,
    // and this module must not infer it.
    const rec = await recommendGenome(
      { sql, embedder },
      { objective: "Assess and compare these deployment strategies" },
    );
    expect(rec.templateKey).toBe("balanced-analysis");
    expect(rec.lessons).toHaveLength(0);
  });
});

describe("template loading", () => {
  it("loads every shipped template by key", () => {
    for (const key of ["balanced-analysis", "adversarial-research", "rapid-triage"]) {
      expect(checkInvariants(loadTemplate(key)).ok).toBe(true);
    }
  });
});
