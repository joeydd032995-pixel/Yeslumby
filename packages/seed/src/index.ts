/**
 * Seed a development tenant with real, non-trivial state.
 *
 * The UI is only worth looking at against data that exercises it: an ecosystem
 * with several genome versions of different origins, a completed multi-round
 * run with real artifacts and provenance, both memory stores populated, and
 * benchmark results to compare. This produces all of that deterministically.
 *
 * This lives in a package rather than in the CLI script because it has two
 * callers that cannot share a process: `pnpm seed` against a local cluster,
 * and the admin route against a hosted database that only the deployment can
 * reach. Duplicating it would let the two drift, and the whole point of the
 * seeded tenant is that what you see deployed is what you see locally.
 */
import { migrate, genomes, num, runs, tenancy, telemetry, type Sql } from "@meta/db";
import { Gateway, SimulatorProvider } from "@meta/gateway";
import { loadTemplate } from "@meta/genome";
import { DeterministicEmbedder, consolidateKnowledge } from "@meta/memory";
import { runEcosystem, type RunContext } from "@meta/runtime";
import { evolveEcosystem, promoteVersion } from "@meta/evolution";
import { STANDARD_SUITE, compareGenomes } from "@meta/bench";
import { DeterministicIds, systemClock, randomIds } from "@meta/shared";

export const OBJECTIVE =
  "A widely cited study reports a large effect that three replication attempts failed to " +
  "reproduce, while the original authors point to methodological differences. What should " +
  "we conclude, and what would settle it?";

export interface SeedOptions {
  /** Where progress goes. The CLI prints; the route collects for its response. */
  log?: (line: string) => void;
}

export interface SeedSummary {
  ecosystemId: string;
  runId: string;
  versions: number;
  generations: number;
  modelCalls: number;
  costUsd: number;
  log: string[];
}

export async function seedDevTenant(sql: Sql, options: SeedOptions = {}): Promise<SeedSummary> {
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    options.log?.(line);
  };

  await migrate(sql, { silent: true });

  const ids = new DeterministicIds("seed");
  const embedder = new DeterministicEmbedder();
  const gateway = new Gateway({
    providers: [new SimulatorProvider()],
    clock: systemClock,
    sleep: async () => {},
    usageSink: {
      record: (event) =>
        telemetry.recordUsage(sql, {
          id: randomIds.next("usageEvent"),
          modelId: event.modelId,
          provider: event.provider,
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          costUsd: event.costUsd,
          unpriced: event.unpriced,
          latencyMs: event.latencyMs,
          ...event.attribution,
        }),
    },
  });

  // Idempotent: a re-seed starts from a clean tenant rather than stacking.
  // Genome versions are append-only, so erasure goes through the explicit
  // purge path rather than a bare DELETE.
  const orgId = "org_dev";
  await tenancy.purgeOrganization(sql, orgId);
  // Users are not org-scoped — a person can belong to several organizations —
  // so purging the org leaves them behind.
  await sql`DELETE FROM users WHERE id LIKE 'usr\_%'`;

  await tenancy.createOrganization(sql, { id: orgId, name: "Dev Org", slug: "dev-org" });
  const workspaceId = "ws_dev";
  await tenancy.createWorkspace(sql, {
    id: workspaceId,
    orgId,
    name: "Dev Workspace",
    slug: "dev",
  });

  const people: Array<{
    id: string;
    email: string;
    name: string;
    role: "OWNER" | "ARCHITECT" | "OPERATOR" | "VIEWER";
  }> = [
    { id: "usr_owner", email: "owner@example.test", name: "Ada (owner)", role: "OWNER" },
    {
      id: "usr_architect",
      email: "architect@example.test",
      name: "Blaise (architect)",
      role: "ARCHITECT",
    },
    { id: "usr_operator", email: "operator@example.test", name: "Cass (operator)", role: "OPERATOR" },
    { id: "usr_viewer", email: "viewer@example.test", name: "Dev (viewer)", role: "VIEWER" },
  ];
  for (const p of people) {
    await tenancy.createUser(sql, { id: p.id, email: p.email, name: p.name });
    await tenancy.addMembership(sql, {
      id: ids.next("evaluation"),
      orgId,
      userId: p.id,
      role: p.role,
    });
  }

  const genome = loadTemplate("adversarial-research");
  const ecosystemId = "eco_dev";
  await genomes.createEcosystem(sql, {
    id: ecosystemId,
    workspaceId,
    name: "Replication Review",
    slug: "replication-review",
    description: "Adversarial research organization for contested empirical questions.",
    createdBy: "usr_architect",
  });

  const { version: v1 } = await genomes.createGenomeVersion(sql, {
    id: ids.next("genomeVersion"),
    ecosystemId,
    genome,
    origin: "SEED",
    createdBy: "usr_architect",
  });
  await promoteVersion(sql, ecosystemId, v1.id);
  log(`ecosystem ${ecosystemId} @ v${v1.version}`);

  await consolidateKnowledge(
    { sql, embedder, ids, ecosystemId, policy: genome.memoryPolicy },
    [
      {
        content: "Replication rates in this subfield average roughly 40 percent.",
        type: "FACT",
        importance: 0.85,
      },
      {
        content: "Effect sizes typically shrink substantially under preregistration.",
        type: "FACT",
        importance: 0.8,
      },
      {
        content:
          "Reanalysis without the original exclusion criteria did not reproduce the effect.",
        type: "HYPOTHESIS",
        importance: 0.7,
      },
      {
        content: "Asking agents to rank sources by recency did not improve evidence quality.",
        type: "FAILED_APPROACH",
        importance: 0.6,
      },
    ],
  );

  // A completed multi-round run, so the run view has artifacts and provenance.
  const run = await runs.createRun(sql, {
    id: "run_dev_1",
    ecosystemId,
    genomeVersionId: v1.id,
    objective: OBJECTIVE,
    seed: "seed-dev-run-1",
    createdBy: "usr_operator",
  });

  const ctx: RunContext = {
    sql,
    gateway,
    clock: systemClock,
    ids,
    genome,
    run: {
      id: run.id,
      ecosystemId,
      genomeVersionId: v1.id,
      objective: OBJECTIVE,
      seed: "seed-dev-run-1",
    },
    iteration: 0,
    attribution: { orgId, workspaceId, ecosystemId, runId: run.id },
    emit: () => {},
  };
  const runResult = await runEcosystem(ctx);
  log(`run ${run.id}: ${runResult.trajectory.length} round(s), ${runResult.stoppedBecause}`);

  // Evolution, so the version graph has real lineage and diffs.
  const evolvableGenome = loadTemplate("adversarial-research");
  const evolution = await evolveEcosystem(
    { sql, gateway, clock: systemClock, ids, embedder },
    {
      ecosystemId,
      fromVersionId: v1.id,
      genome: {
        ...evolvableGenome,
        mutationPolicy: {
          ...evolvableGenome.mutationPolicy,
          humanApprovalRequired: false,
        },
      },
      objective: OBJECTIVE,
      seed: "seed-dev-evolution",
      maxGenerations: 3,
      attribution: { orgId, workspaceId },
      createdBy: "usr_architect",
    },
  );
  log(`evolution: ${evolution.generations.length} generations, ${evolution.stoppedBecause}`);

  // Benchmark every version so the comparison table is populated.
  const benchmarkId = "bm_dev";
  await telemetry.createBenchmark(sql, {
    id: benchmarkId,
    workspaceId,
    name: STANDARD_SUITE.name,
    slug: STANDARD_SUITE.id,
    tasks: STANDARD_SUITE.tasks,
    scoring: { dimensions: [] },
  });

  const allVersions = await genomes.listGenomeVersions(sql, ecosystemId);
  await compareGenomes(
    { sql, gateway, clock: systemClock, ids, attribution: { orgId, workspaceId } },
    { ...STANDARD_SUITE, tasks: STANDARD_SUITE.tasks.slice(0, 3) },
    allVersions.slice(0, 3).map((v) => ({
      ecosystemId,
      genomeVersionId: v.id,
      genome: loadTemplate("adversarial-research"),
      label: `v${v.version}`,
    })),
    { persist: { benchmarkId } },
  );

  const usage = await telemetry.getOrgUsage(sql, orgId, new Date(0));
  // COUNT comes back as a string — the driver refuses to narrow numerics on
  // the caller's behalf — so it is converted at the point it becomes a number.
  const modelCalls = num(usage.calls);
  const costUsd = Number(usage.costUsd);
  log(
    `seeded: ${allVersions.length} versions, ${modelCalls} model calls, $${costUsd.toFixed(6)}`,
  );

  return {
    ecosystemId,
    runId: run.id,
    versions: allVersions.length,
    generations: evolution.generations.length,
    modelCalls,
    costUsd,
    log: lines,
  };
}
