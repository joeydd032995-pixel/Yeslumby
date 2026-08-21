/**
 * Validation experiments.
 *
 *   pnpm validate watcher:run   [--n 8] [--dry-run]
 *   pnpm validate watcher:score
 *   pnpm validate evolution:run [--generations 4] [--dry-run]
 *   pnpm validate evolution:score
 *   pnpm validate baseline:run  [--dry-run]
 *   pnpm validate baseline:score
 *
 * Each experiment runs in two phases because the measurement in the middle is
 * a human. `:run` executes and writes a blinded sheet; you grade it; `:score`
 * joins the grades back and reports an interval.
 *
 * Nothing here is meaningful without `AI_GATEWAY_API_KEY`. Against the
 * deterministic provider these experiments exercise the harness and produce
 * numbers about a random number generator, which is useful for checking the
 * plumbing and useless for deciding anything about the product. Every command
 * says which provider it used.
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createSql, genomes, runs, type Sql } from "@meta/db";
import { Gateway, SimulatorProvider, AiGatewayProvider, hasGatewayCredentials } from "@meta/gateway";
import { loadTemplate, type ArchitectureGenome } from "@meta/genome";
import { DeterministicEmbedder, GatewayEmbedder } from "@meta/memory";
import { runEcosystem, type RunContext } from "@meta/runtime";
import { evolveEcosystem } from "@meta/evolution";
import { scoreRound, weightedScore, DEFAULT_DIMENSIONS } from "@meta/bench";
import { randomIds, systemClock } from "@meta/shared";
import {
  blind, join as joinGrades, renderSheet, renderGradesTemplate,
  bootstrapCorrelation, wilson, describe as describeInterval,
  renderSynthesis, TRAINING, HELD_OUT, type ValidationTask, type BlindSet,
} from "@meta/validation";

const ROOT = "artifacts/validation";
const DB_URL = process.env.DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5433/meta_ecosystem";
const REAL = hasGatewayCredentials();

function provider() {
  return REAL
    ? new Gateway({ providers: [new AiGatewayProvider(), new SimulatorProvider()], clock: systemClock })
    : new Gateway({ providers: [new SimulatorProvider()], clock: systemClock, sleep: async () => {} });
}

function banner(experiment: string) {
  console.log(`\n${experiment}`);
  console.log(
    REAL
      ? "provider: AI Gateway (real models) — results are evidence"
      : "provider: deterministic simulator — results describe a random number\n" +
        "generator, not the product. Set AI_GATEWAY_API_KEY for a real answer.",
  );
}

interface RunOutcome {
  task: ValidationTask;
  watcherScore: number | null;
  compositeScore: number;
  costUsd: number;
  text: string;
}

async function executeTask(
  sql: Sql,
  genome: ArchitectureGenome,
  versionId: string,
  ecosystemId: string,
  task: ValidationTask,
  tag: string,
): Promise<RunOutcome> {
  const runId = `run_val_${tag}_${task.id}`;
  await sql`DELETE FROM run_steps WHERE run_id = ${runId}`.catch(() => {});
  const existing = await runs.getRun(sql, runId);
  if (!existing) {
    await runs.createRun(sql, {
      id: runId, ecosystemId, genomeVersionId: versionId,
      objective: task.objective, seed: `val-${tag}-${task.id}`,
    });
  }

  const ctx: RunContext = {
    sql, gateway: provider(), clock: systemClock, ids: randomIds, genome,
    run: { id: runId, ecosystemId, genomeVersionId: versionId, objective: task.objective, seed: `val-${tag}-${task.id}` },
    iteration: 0,
    attribution: { ecosystemId, runId },
    emit: () => {},
  };

  const result = await runEcosystem(ctx);
  const dims = scoreRound(result.final, { id: task.id, objective: task.objective });
  return {
    task,
    watcherScore: result.trajectory.at(-1)?.score ?? null,
    compositeScore: weightedScore(dims, DEFAULT_DIMENSIONS),
    costUsd: result.totalCostUsd,
    text: renderSynthesis(result.final),
  };
}

async function ensureEcosystem(sql: Sql, genome: ArchitectureGenome) {
  const orgId = "org_val";
  await sql`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, 'Validation', 'validation')
            ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO workspaces (id, org_id, name, slug) VALUES ('ws_val', ${orgId}, 'Validation', 'validation')
            ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO ecosystems (id, workspace_id, name, slug)
            VALUES ('eco_val', 'ws_val', 'Validation', 'validation') ON CONFLICT (id) DO NOTHING`;
  const { version } = await genomes.createGenomeVersion(sql, {
    id: randomIds.next("genomeVersion"), ecosystemId: "eco_val", genome, origin: "SEED",
  });
  return { orgId, ecosystemId: "eco_val", versionId: version.id };
}

async function save<M>(dir: string, set: BlindSet<M>, meta: unknown, instructions: string) {
  const out = join(ROOT, dir);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "sheet.md"), renderSheet(set, instructions), "utf8");
  await writeFile(join(out, "grades.json"), renderGradesTemplate(set), "utf8");
  await writeFile(join(out, "key.json"), JSON.stringify(set, null, 2), "utf8");
  await writeFile(join(out, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  console.log(`\ngrade ${join(out, "sheet.md")}`);
  console.log(`then fill ${join(out, "grades.json")} and run the matching :score command`);
}

async function load<M>(dir: string) {
  const out = join(ROOT, dir);
  const set = JSON.parse(await readFile(join(out, "key.json"), "utf8")) as BlindSet<M>;
  const grades = JSON.parse(await readFile(join(out, "grades.json"), "utf8")) as Record<string, number | null>;
  const meta = JSON.parse(await readFile(join(out, "meta.json"), "utf8")) as Record<string, unknown>;
  return { set, grades, meta };
}

function reportMissing(missing: string[], unknown: string[], total: number) {
  if (unknown.length) console.log(`\n${unknown.length} unrecognised id(s) in grades.json — ignored`);
  if (missing.length) {
    console.log(`\n${missing.length} of ${total} items ungraded.`);
    if (missing.length > total / 2) {
      console.log("More than half are missing; the interval below is not worth reading.");
    }
  }
}

// --- experiment 1: is the Watcher's score meaningful? -----------------------

async function watcherRun(n: number, dryRun: boolean) {
  banner("Experiment 1 — does the Watcher's score track human judgment?");
  const sql = createSql({ url: DB_URL });
  try {
    const genome = loadTemplate("adversarial-research");
    const { ecosystemId, versionId } = await ensureEcosystem(sql, genome);
    const tasks = [...TRAINING, ...HELD_OUT].slice(0, n);

    if (dryRun) {
      const one = await executeTask(sql, genome, versionId, ecosystemId, tasks[0]!, "dry");
      console.log(`\none run cost ${one.costUsd.toFixed(4)} at the requested models' prices`);
      console.log(`projected for ${tasks.length} runs: $${(one.costUsd * tasks.length).toFixed(2)}`);
      console.log("(the simulator prices against the model each agent asks for, so this");
      console.log(" estimate holds when real inference is switched on)");
      return;
    }

    const outcomes: RunOutcome[] = [];
    for (const task of tasks) {
      process.stdout.write(`  ${task.id} ... `);
      const outcome = await executeTask(sql, genome, versionId, ecosystemId, task, "w");
      outcomes.push(outcome);
      console.log(`watcher ${outcome.watcherScore?.toFixed(3) ?? "n/a"}  $${outcome.costUsd.toFixed(4)}`);
    }

    const set = blind(
      outcomes.map((o) => ({
        provenance: { taskId: o.task.id, watcherScore: o.watcherScore, composite: o.compositeScore },
        content: `**Question**\n\n${o.task.objective}\n\n**Answer**\n\n${o.text}`,
      })),
      `watcher-${Date.now()}`,
    );
    await save("watcher", set, { provider: REAL ? "gateway" : "simulator", n: outcomes.length },
      "Score each answer 0–10 for how much you would trust it as a piece of reasoning:\n" +
      "does it engage the real difficulty, distinguish what is established from what is\n" +
      "asserted, and admit what it does not know? Ignore length and polish.");
  } finally {
    await sql.end();
  }
}

async function watcherScore() {
  const { set, grades, meta } = await load<{ taskId: string; watcherScore: number | null; composite: number }>("watcher");
  const { graded, missing, unknown } = joinGrades(set, grades);
  reportMissing(missing, unknown, set.entries.length);

  const usable = graded.filter((g) => g.provenance.watcherScore !== null);
  const human = usable.map((g) => g.grade);
  const watcher = usable.map((g) => g.provenance.watcherScore!);
  const composite = usable.map((g) => g.provenance.composite);

  console.log(`\nprovider: ${String(meta.provider)}   graded: ${usable.length}\n`);
  console.log(describeInterval(bootstrapCorrelation(watcher, human, { seed: 1 }), "Watcher score vs human"));
  console.log(describeInterval(bootstrapCorrelation(composite, human, { seed: 2 }), "Benchmark composite vs human"));
  console.log(
    "\nEvolution promotes on the Watcher's score. If the first line is indistinguishable\n" +
    "from no effect, the generational loop is optimising something unrelated to quality,\n" +
    "and experiments 2 and 3 will not rescue it.",
  );
}

// --- experiment 2: does evolution improve held-out quality? -----------------

async function evolutionRun(generations: number, dryRun: boolean) {
  banner("Experiment 2 — does evolution improve answers on objectives it never saw?");
  const sql = createSql({ url: DB_URL });
  try {
    const base = loadTemplate("adversarial-research");
    const genome: ArchitectureGenome = {
      ...base,
      mutationPolicy: { ...base.mutationPolicy, humanApprovalRequired: false },
    };
    const { orgId, ecosystemId, versionId } = await ensureEcosystem(sql, genome);

    if (dryRun) {
      const one = await executeTask(sql, genome, versionId, ecosystemId, TRAINING[0]!, "dry");
      const runsNeeded = generations + HELD_OUT.length * 2;
      console.log(`\none run cost ${one.costUsd.toFixed(4)}`);
      console.log(`projected: ${generations} generations + ${HELD_OUT.length * 2} held-out runs`);
      console.log(`         ≈ $${(one.costUsd * runsNeeded).toFixed(2)}`);
      return;
    }

    console.log(`\nevolving ${generations} generations on the TRAINING set...`);
    const evolution = await evolveEcosystem(
      { sql, gateway: provider(), clock: systemClock, ids: randomIds,
        embedder: REAL ? new GatewayEmbedder() : new DeterministicEmbedder() },
      { ecosystemId, fromVersionId: versionId, genome,
        objective: TRAINING[0]!.objective, seed: "val-evolution",
        maxGenerations: generations, attribution: { orgId, workspaceId: "ws_val" } },
    );
    console.log(`  ${evolution.generations.length} generations, ${evolution.stoppedBecause}`);

    const first = evolution.generations[0]!;
    const last = evolution.generations.at(-1)!;
    if (first.genomeVersionId === last.genomeVersionId) {
      console.log("\nEvolution promoted nothing, so there is no difference to measure.");
      console.log("That is itself a result: on this objective the loop found no improvement.");
      return;
    }

    const items: Array<{ provenance: { taskId: string; arm: "first" | "evolved" }; content: string }> = [];
    for (const arm of [
      { name: "first" as const, versionId: first.genomeVersionId },
      { name: "evolved" as const, versionId: last.genomeVersionId },
    ]) {
      const row = await genomes.getGenomeVersion(sql, arm.versionId);
      const g = row!.genome as ArchitectureGenome;
      for (const task of HELD_OUT) {
        process.stdout.write(`  ${arm.name} / ${task.id} ... `);
        const o = await executeTask(sql, g, arm.versionId, ecosystemId, task, `e_${arm.name}`);
        items.push({
          provenance: { taskId: task.id, arm: arm.name },
          content: `**Question**\n\n${task.objective}\n\n**Answer**\n\n${o.text}`,
        });
        console.log(`$${o.costUsd.toFixed(4)}`);
      }
    }

    const set = blind(items, `evolution-${Date.now()}`);
    await save("evolution", set,
      { provider: REAL ? "gateway" : "simulator", generations: evolution.generations.length },
      "Each question appears twice, answered by two different architectures, in random\n" +
      "order. Score each answer 0–10 on how much you would trust its reasoning. You are\n" +
      "not told which is which — that is the point.");
  } finally {
    await sql.end();
  }
}

async function evolutionScore() {
  const { set, grades, meta } = await load<{ taskId: string; arm: "first" | "evolved" }>("evolution");
  const { graded, missing, unknown } = joinGrades(set, grades);
  reportMissing(missing, unknown, set.entries.length);

  const byTask = new Map<string, { first?: number; evolved?: number }>();
  for (const g of graded) {
    const entry = byTask.get(g.provenance.taskId) ?? {};
    entry[g.provenance.arm] = g.grade;
    byTask.set(g.provenance.taskId, entry);
  }

  let wins = 0;
  let pairs = 0;
  for (const [, pair] of byTask) {
    if (pair.first === undefined || pair.evolved === undefined) continue;
    if (pair.first === pair.evolved) continue; // ties excluded, reported below
    pairs++;
    if (pair.evolved > pair.first) wins++;
  }

  console.log(`\nprovider: ${String(meta.provider)}   paired comparisons: ${pairs}\n`);
  console.log(describeInterval(wilson(wins, pairs), "Evolved beats first generation"));
  console.log(
    "\nMeasured only on HELD_OUT objectives, which evolution never saw. A win rate whose\n" +
    "interval spans 0.5 means the evolved architecture is not distinguishable from where\n" +
    "it started, however much the lineage graph grew.",
  );
}

// --- experiment 3: does the organization beat one model? --------------------

async function baselineRun(dryRun: boolean) {
  banner("Experiment 3 — does the organization beat a single model, and at what multiple?");
  const sql = createSql({ url: DB_URL });
  try {
    const genome = loadTemplate("adversarial-research");
    const { ecosystemId, versionId } = await ensureEcosystem(sql, genome);
    const gateway = provider();

    if (dryRun) {
      const one = await executeTask(sql, genome, versionId, ecosystemId, HELD_OUT[0]!, "dry");
      console.log(`\none organization run cost ${one.costUsd.toFixed(4)}`);
      console.log(`projected for ${HELD_OUT.length} objectives: $${(one.costUsd * HELD_OUT.length).toFixed(2)}`);
      console.log("plus one direct model call per objective, which is negligible beside it");
      return;
    }

    const items: Array<{ provenance: { taskId: string; arm: "org" | "single" }; content: string }> = [];
    let orgCost = 0;
    let singleCost = 0;

    for (const task of HELD_OUT) {
      process.stdout.write(`  org / ${task.id} ... `);
      const o = await executeTask(sql, genome, versionId, ecosystemId, task, "b");
      orgCost += o.costUsd;
      items.push({
        provenance: { taskId: task.id, arm: "org" },
        content: `**Question**\n\n${task.objective}\n\n**Answer**\n\n${o.text}`,
      });
      console.log(`$${o.costUsd.toFixed(4)}`);

      process.stdout.write(`  single / ${task.id} ... `);
      // The same model one of the agents uses, so the comparison is between
      // architectures rather than between model tiers.
      const model = genome.agents[0]!.model;
      const direct = await gateway.generate({
        modelId: model.primary,
        fallbacks: model.fallbacks,
        system:
          "Answer the question as well as you can. Distinguish what is established " +
          "from what is contested, and say what you do not know.",
        prompt: task.objective,
        temperature: model.temperature,
        maxOutputTokens: model.maxOutputTokens,
        seed: `val-single-${task.id}`,
        attribution: { ecosystemId },
      });
      singleCost += direct.costUsd;
      items.push({
        provenance: { taskId: task.id, arm: "single" },
        content: `**Question**\n\n${task.objective}\n\n**Answer**\n\n${direct.text.trim()}`,
      });
      console.log(`$${direct.costUsd.toFixed(4)}`);
    }

    const set = blind(items, `baseline-${Date.now()}`);
    await save("baseline", set,
      { provider: REAL ? "gateway" : "simulator", orgCost, singleCost,
        multiple: singleCost > 0 ? orgCost / singleCost : null },
      "Each question appears twice, answered two different ways, in random order. Score\n" +
      "each 0–10 on how much you would trust its reasoning. Ignore formatting: one of\n" +
      "these pipelines is more elaborate than the other and it should not get credit for\n" +
      "that alone.");
    console.log(`\norganization $${orgCost.toFixed(4)} vs single model $${singleCost.toFixed(4)}`);
  } finally {
    await sql.end();
  }
}

async function baselineScore() {
  const { set, grades, meta } = await load<{ taskId: string; arm: "org" | "single" }>("baseline");
  const { graded, missing, unknown } = joinGrades(set, grades);
  reportMissing(missing, unknown, set.entries.length);

  const byTask = new Map<string, { org?: number; single?: number }>();
  for (const g of graded) {
    const entry = byTask.get(g.provenance.taskId) ?? {};
    entry[g.provenance.arm] = g.grade;
    byTask.set(g.provenance.taskId, entry);
  }

  let wins = 0;
  let pairs = 0;
  let ties = 0;
  for (const [, pair] of byTask) {
    if (pair.org === undefined || pair.single === undefined) continue;
    if (pair.org === pair.single) { ties++; continue; }
    pairs++;
    if (pair.org > pair.single) wins++;
  }

  const multiple = meta.multiple as number | null;
  console.log(`\nprovider: ${String(meta.provider)}   paired: ${pairs}   ties: ${ties}\n`);
  console.log(describeInterval(wilson(wins, pairs), "Organization beats one model"));
  if (multiple) console.log(`\nCost multiple: the organization cost ${multiple.toFixed(1)}× the single call.`);
  console.log(
    "\nThe question is not whether it wins but whether it wins often enough to justify\n" +
    "that multiple. A win rate whose interval spans 0.5 at several times the price is a\n" +
    "clear negative result.",
  );
}

// --- entry ------------------------------------------------------------------

const [command] = process.argv.slice(2);
const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const dryRun = process.argv.includes("--dry-run");

const commands: Record<string, () => Promise<void>> = {
  "watcher:run": () => watcherRun(arg("n", 8), dryRun),
  "watcher:score": watcherScore,
  "evolution:run": () => evolutionRun(arg("generations", 4), dryRun),
  "evolution:score": evolutionScore,
  "baseline:run": () => baselineRun(dryRun),
  "baseline:score": baselineScore,
};

const run = commands[command ?? ""];
if (!run) {
  console.error(`usage: pnpm validate <${Object.keys(commands).join(" | ")}> [--dry-run]`);
  process.exitCode = 1;
} else {
  run().catch((error) => {
    console.error("\nfailed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
