import { createSql, migrate, genomes, runs, type Sql } from "@meta/db";
import { Gateway, SimulatorProvider } from "@meta/gateway";
import { BALANCED_ANALYSIS, hashGenome, parseGenome, type ArchitectureGenome } from "@meta/genome";
import { DeterministicIds, FixedClock, contentHash } from "@meta/shared";
import type { RunContext, RunEvent, KnowledgeRecall } from "../src/context.js";

const DEFAULT_TEST_URL = "postgresql://postgres@127.0.0.1:5433/meta_ecosystem_test";

export function testSql(): Sql {
  return createSql({ url: process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_URL, max: 4 });
}

export async function ensureSchema(sql: Sql): Promise<void> {
  await migrate(sql, { silent: true });
}

let counter = 0;

export interface Harness {
  ctx: RunContext;
  simulator: SimulatorProvider;
  events: RunEvent[];
  genome: ArchitectureGenome;
  ecosystemId: string;
  genomeVersionId: string;
  runId: string;
  /** Re-create the context as a fresh process would, keeping run identity. */
  reenter(overrides?: { simulator?: SimulatorProvider }): RunContext;
}

export interface HarnessOptions {
  genome?: ArchitectureGenome;
  objective?: string;
  seed?: string;
  recall?: KnowledgeRecall;
  simulator?: SimulatorProvider;
}

export async function makeHarness(sql: Sql, options: HarnessOptions = {}): Promise<Harness> {
  const ns = `h${++counter}_${process.pid}`;
  const ids = new DeterministicIds(ns);
  const genome = options.genome ?? parseGenome(BALANCED_ANALYSIS);
  const objective = options.objective ?? "Does the reported effect replicate outside the lab?";
  const seed = options.seed ?? `seed-${ns}`;

  const orgId = ids.next("org");
  const workspaceId = ids.next("workspace");
  const ecosystemId = ids.next("ecosystem");

  await sql`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, ${ns}, ${`org-${ns}`})`;
  await sql`
    INSERT INTO workspaces (id, org_id, name, slug)
    VALUES (${workspaceId}, ${orgId}, ${ns}, ${`ws-${ns}`})
  `;
  await genomes.createEcosystem(sql, {
    id: ecosystemId,
    workspaceId,
    name: ns,
    slug: `eco-${ns}`,
  });

  const { version } = await genomes.createGenomeVersion(sql, {
    id: ids.next("genomeVersion"),
    ecosystemId,
    genomeHash: hashGenome(genome),
    genome,
    origin: "SEED",
  });
  await genomes.setCurrentGenomeVersion(sql, ecosystemId, version.id);

  const run = await runs.createRun(sql, {
    id: ids.next("run"),
    ecosystemId,
    genomeVersionId: version.id,
    objective,
    seed,
  });

  const simulator = options.simulator ?? new SimulatorProvider();
  const events: RunEvent[] = [];

  const build = (sim: SimulatorProvider, idGen: DeterministicIds): RunContext => ({
    sql,
    gateway: new Gateway({
      providers: [sim],
      sleep: async () => {},
      clock: new FixedClock(),
    }),
    clock: new FixedClock(),
    ids: idGen,
    genome,
    run: {
      id: run.id,
      ecosystemId,
      genomeVersionId: version.id,
      objective,
      seed,
    },
    iteration: 0,
    attribution: { orgId, workspaceId, ecosystemId, runId: run.id },
    emit: (e) => void events.push(e),
    ...(options.recall ? { recall: options.recall } : {}),
  });

  return {
    ctx: build(simulator, ids),
    simulator,
    events,
    genome,
    ecosystemId,
    genomeVersionId: version.id,
    runId: run.id,
    // A resumed run gets a fresh id generator, as a new process would. Artifact
    // ids therefore differ across resumes; the journal is what preserves
    // results, not id stability.
    reenter: (overrides) =>
      build(overrides?.simulator ?? simulator, new DeterministicIds(`${ns}r${++counter}`)),
  };
}

/** A recall port returning fixed memories, for testing context assembly. */
export function fixedRecall(items: Array<{ content: string; type?: string }>): KnowledgeRecall {
  return {
    recall: async () =>
      items.map((item, i) => ({
        id: `mem_${contentHash(item.content).slice(0, 8)}_${i}`,
        type: item.type ?? "FACT",
        content: item.content,
        similarity: 0.9 - i * 0.05,
      })),
  };
}
