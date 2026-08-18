import { genomes, runs, telemetry, type Sql } from "@meta/db";
import { hashGenome, type ArchitectureGenome } from "@meta/genome";
import { executeRound, type RunContext, type RoundResult } from "@meta/runtime";
import type { ModelGateway } from "@meta/gateway";
import { contentHash, type Clock, type IdGenerator } from "@meta/shared";
import {
  DEFAULT_DIMENSIONS,
  summarizeTask,
  type BenchmarkTask,
  type ScoringDimension,
  type TaskOutcome,
} from "./scoring.js";

/**
 * The benchmark laboratory.
 *
 * Every genome under comparison runs the same tasks with the same seed
 * derivation, so differences in outcome are attributable to architecture rather
 * than to sampling. That is only meaningful because the model layer can be made
 * deterministic — under a hosted model, two genomes scoring differently on one
 * task tells you very little.
 */

export interface BenchmarkSuite {
  id: string;
  name: string;
  tasks: BenchmarkTask[];
  dimensions?: ScoringDimension[];
}

export interface BenchmarkDeps {
  sql: Sql;
  gateway: ModelGateway;
  clock: Clock;
  ids: IdGenerator;
  /**
   * Billing attribution for benchmark spend.
   *
   * Without this, benchmark runs record usage with a null org and fall out of
   * every billing rollup — and a full suite across several genomes is often the
   * most expensive thing an account does.
   */
  attribution?: { orgId?: string | null; workspaceId?: string | null };
}

export interface BenchmarkTarget {
  ecosystemId: string;
  genomeVersionId: string;
  genome: ArchitectureGenome;
  label?: string;
}

export interface BenchmarkReport {
  label: string;
  genomeVersionId: string;
  genomeHash: string;
  tasks: TaskOutcome[];
  averageScore: number;
  totalCostUsd: number;
  totalTokens: number;
  /** Average score per dollar. Null when the run was free. */
  efficiency: number | null;
  failures: Array<{ taskId: string; error: string }>;
}

/**
 * Seeds are derived from suite, task, and genome hash — not from the run id.
 *
 * This is what makes a comparison fair. Two genomes evaluated on the same task
 * get seeds that differ only by their own content, so neither benefits from a
 * luckier sample, and re-running the suite reproduces the same numbers.
 */
export function benchmarkSeed(suiteId: string, taskId: string, genomeHash: string): string {
  return contentHash({ suiteId, taskId, genomeHash }).slice(0, 32);
}

export async function runBenchmark(
  deps: BenchmarkDeps,
  suite: BenchmarkSuite,
  target: BenchmarkTarget,
  options: { persist?: { benchmarkId: string } } = {},
): Promise<BenchmarkReport> {
  const genomeHash = hashGenome(target.genome);
  const outcomes: TaskOutcome[] = [];
  const failures: BenchmarkReport["failures"] = [];

  for (const task of suite.tasks) {
    try {
      const result = await runTask(deps, suite, target, task, genomeHash);
      const outcome = summarizeTask(task, result.round, suite.dimensions ?? DEFAULT_DIMENSIONS);
      outcomes.push(outcome);

      if (options.persist) {
        await telemetry.insertBenchmarkResult(deps.sql, {
          id: deps.ids.next("benchmarkResult"),
          benchmarkId: options.persist.benchmarkId,
          ecosystemId: target.ecosystemId,
          genomeVersionId: target.genomeVersionId,
          runId: result.runId,
          taskId: task.id,
          scores: outcome.scores,
          overallScore: outcome.overallScore,
          costUsd: outcome.costUsd,
          efficiency: outcome.efficiency,
          totalTokens: outcome.totalTokens,
        });
      }
    } catch (error) {
      // One failing task must not void the whole suite: a genome that fails
      // two of six tasks is a real, reportable result.
      failures.push({
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const totalCostUsd = outcomes.reduce((s, o) => s + o.costUsd, 0);
  const totalTokens = outcomes.reduce((s, o) => s + o.totalTokens, 0);
  const averageScore =
    outcomes.length === 0
      ? 0
      : Math.round((outcomes.reduce((s, o) => s + o.overallScore, 0) / outcomes.length) * 1000) /
        1000;

  return {
    label: target.label ?? target.genome.name,
    genomeVersionId: target.genomeVersionId,
    genomeHash,
    tasks: outcomes,
    averageScore,
    totalCostUsd: Math.round(totalCostUsd * 1e10) / 1e10,
    totalTokens,
    efficiency:
      totalCostUsd > 0 ? Math.round((averageScore / totalCostUsd) * 1000) / 1000 : null,
    failures,
  };
}

async function runTask(
  deps: BenchmarkDeps,
  suite: BenchmarkSuite,
  target: BenchmarkTarget,
  task: BenchmarkTask,
  genomeHash: string,
): Promise<{ round: RoundResult; runId: string }> {
  const seed = benchmarkSeed(suite.id, task.id, genomeHash);

  const run = await runs.createRun(deps.sql, {
    id: deps.ids.next("run"),
    ecosystemId: target.ecosystemId,
    genomeVersionId: target.genomeVersionId,
    objective: task.objective,
    seed,
  });

  const ctx: RunContext = {
    sql: deps.sql,
    gateway: deps.gateway,
    clock: deps.clock,
    ids: deps.ids,
    genome: target.genome,
    run: {
      id: run.id,
      ecosystemId: target.ecosystemId,
      genomeVersionId: target.genomeVersionId,
      objective: task.objective,
      seed,
    },
    iteration: 0,
    attribution: {
      orgId: deps.attribution?.orgId ?? null,
      workspaceId: deps.attribution?.workspaceId ?? null,
      ecosystemId: target.ecosystemId,
      runId: run.id,
      stage: "benchmark",
    },
    emit: () => {},
  };

  const round = await executeRound(ctx);
  await runs.finishRun(deps.sql, run.id, {
    status: "COMPLETED",
    result: { synthesis: round.synthesis },
  });
  return { round, runId: run.id };
}

export interface Comparison {
  reports: BenchmarkReport[];
  winner: BenchmarkReport | undefined;
  /** Ranked by efficiency where costs are non-zero, otherwise by score. */
  byEfficiency: BenchmarkReport[];
}

export async function compareGenomes(
  deps: BenchmarkDeps,
  suite: BenchmarkSuite,
  targets: readonly BenchmarkTarget[],
  options: { persist?: { benchmarkId: string } } = {},
): Promise<Comparison> {
  const reports: BenchmarkReport[] = [];
  for (const target of targets) {
    reports.push(await runBenchmark(deps, suite, target, options));
  }

  const ranked = [...reports].sort((a, b) => b.averageScore - a.averageScore);
  const byEfficiency = [...reports].sort(
    (a, b) => (b.efficiency ?? b.averageScore) - (a.efficiency ?? a.averageScore),
  );

  return { reports, winner: ranked[0], byEfficiency };
}

/**
 * Per-agent marginal contribution by ablation.
 *
 * Removing an agent and re-running is the only measurement here that answers
 * "was this agent worth its cost" directly. Citation counts and challenge
 * survival are cheaper proxies, but both can be gamed by an agent that talks a
 * lot; ablation cannot.
 *
 * The synthesizer is never ablated — without it the organization produces no
 * result, so the comparison would be meaningless rather than informative.
 */
export async function measureMarginalContribution(
  deps: BenchmarkDeps,
  suite: BenchmarkSuite,
  target: BenchmarkTarget,
): Promise<Array<{ agentId: string; scoreDelta: number; costDelta: number; verdict: string }>> {
  const { repair } = await import("@meta/evolution");
  const { createRng } = await import("@meta/shared");

  const baseline = await runBenchmark(deps, suite, target);
  const results: Array<{
    agentId: string;
    scoreDelta: number;
    costDelta: number;
    verdict: string;
  }> = [];

  for (const agent of target.genome.agents) {
    if (agent.id === target.genome.synthesizerId) continue;

    const reduced = {
      ...target.genome,
      agents: target.genome.agents.filter((a) => a.id !== agent.id),
      edges: target.genome.edges.filter((e) => e.from !== agent.id && e.to !== agent.id),
    };

    let ablated;
    try {
      ablated = repair(reduced, createRng(`ablate:${agent.id}`));
    } catch {
      // Removing this agent leaves an organization that cannot be repaired into
      // a valid one, which is itself the strongest evidence it is load-bearing.
      results.push({
        agentId: agent.id,
        scoreDelta: Number.NaN,
        costDelta: Number.NaN,
        verdict: "structurally required",
      });
      continue;
    }

    // Ablations are measured against a throwaway version so the real lineage is
    // not polluted with organizations nobody chose to run.
    const { version } = await genomes.createGenomeVersion(deps.sql, {
      id: deps.ids.next("genomeVersion"),
      ecosystemId: target.ecosystemId,
      genomeHash: hashGenome(ablated),
      genome: ablated,
      parentIds: [target.genomeVersionId],
      origin: "MANUAL",
    });

    const report = await runBenchmark(deps, suite, {
      ecosystemId: target.ecosystemId,
      genomeVersionId: version.id,
      genome: ablated,
      label: `without ${agent.id}`,
    });

    const scoreDelta = Math.round((baseline.averageScore - report.averageScore) * 1000) / 1000;
    const costDelta = Math.round((baseline.totalCostUsd - report.totalCostUsd) * 1e10) / 1e10;

    results.push({
      agentId: agent.id,
      scoreDelta,
      costDelta,
      verdict:
        scoreDelta > 0.02
          ? "contributes"
          : scoreDelta < -0.02
            ? "harms — removal improved the result"
            : "no measurable effect",
    });
  }

  return results.sort((a, b) => (b.scoreDelta || 0) - (a.scoreDelta || 0));
}
