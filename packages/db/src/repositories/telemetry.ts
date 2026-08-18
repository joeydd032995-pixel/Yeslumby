import type { Sql } from "../client.js";
import type { BenchmarkResultRow, EvaluationRow } from "../types.js";

export interface UsageEventInput {
  id: string;
  orgId?: string | null;
  workspaceId?: string | null;
  ecosystemId?: string | null;
  runId?: string | null;
  artifactId?: string | null;
  agentId?: string | null;
  stage?: string | null;
  modelId: string;
  provider?: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costUsd: number;
  unpriced?: boolean;
  latencyMs?: number | null;
}

export async function recordUsage(sql: Sql, input: UsageEventInput): Promise<void> {
  await sql`
    INSERT INTO usage_events
      (id, org_id, workspace_id, ecosystem_id, run_id, artifact_id, agent_id, stage,
       model_id, provider, input_tokens, output_tokens, cached_input_tokens,
       cost_usd, unpriced, latency_ms)
    VALUES (
      ${input.id}, ${input.orgId ?? null}, ${input.workspaceId ?? null},
      ${input.ecosystemId ?? null}, ${input.runId ?? null}, ${input.artifactId ?? null},
      ${input.agentId ?? null}, ${input.stage ?? null}, ${input.modelId},
      ${input.provider ?? null}, ${input.inputTokens}, ${input.outputTokens},
      ${input.cachedInputTokens ?? 0}, ${input.costUsd}, ${input.unpriced ?? false},
      ${input.latencyMs ?? null}
    )
  `;
}

/** Per-agent spend and latency for a run, for the cost-attribution view. */
export async function getRunCostByAgent(
  sql: Sql,
  runId: string,
): Promise<Array<{ agentId: string | null; costUsd: string; calls: string; avgLatencyMs: number | null }>> {
  return sql<
    Array<{ agentId: string | null; costUsd: string; calls: string; avgLatencyMs: number | null }>
  >`
    SELECT agent_id AS "agentId",
           sum(cost_usd)::text AS "costUsd",
           count(*)::text AS calls,
           avg(latency_ms)::int AS "avgLatencyMs"
    FROM usage_events
    WHERE run_id = ${runId}
    GROUP BY agent_id
    ORDER BY sum(cost_usd) DESC
  `;
}

/** Billing rollup for a period. NUMERIC sum keeps the arithmetic exact. */
export async function getOrgUsage(
  sql: Sql,
  orgId: string,
  since: Date,
): Promise<{ costUsd: string; inputTokens: string; outputTokens: string; calls: string }> {
  const [row] = await sql<
    Array<{ costUsd: string; inputTokens: string; outputTokens: string; calls: string }>
  >`
    SELECT COALESCE(sum(cost_usd), 0)::text AS "costUsd",
           COALESCE(sum(input_tokens), 0)::text AS "inputTokens",
           COALESCE(sum(output_tokens), 0)::text AS "outputTokens",
           count(*)::text AS calls
    FROM usage_events
    WHERE org_id = ${orgId} AND created_at >= ${since}
  `;
  return row ?? { costUsd: "0", inputTokens: "0", outputTokens: "0", calls: "0" };
}

export interface InsertEvaluationInput {
  id: string;
  runId: string;
  genomeVersionId: string;
  iteration: number;
  scores: unknown;
  failureModes: unknown;
  suggestedMutations: unknown;
  recommendation: "continue" | "mutate" | "human_review" | "stop";
  modelId?: string | null;
  costUsd?: number;
}

/**
 * Record a Watcher evaluation.
 *
 * Upserts on (run_id, iteration): a round is evaluated once, and a replay or a
 * crash-and-resume must not append a second evaluation for the same round. The
 * logical key is enforced by a unique constraint, so this cannot drift.
 */
export async function insertEvaluation(
  sql: Sql,
  input: InsertEvaluationInput,
): Promise<EvaluationRow> {
  const [row] = await sql<EvaluationRow[]>`
    INSERT INTO evaluations
      (id, run_id, genome_version_id, iteration, scores, failure_modes,
       suggested_mutations, recommendation, model_id, cost_usd)
    VALUES (
      ${input.id}, ${input.runId}, ${input.genomeVersionId}, ${input.iteration},
      ${sql.json(input.scores as never)}, ${sql.json(input.failureModes as never)},
      ${sql.json(input.suggestedMutations as never)}, ${input.recommendation},
      ${input.modelId ?? null}, ${input.costUsd ?? 0}
    )
    ON CONFLICT (run_id, iteration) DO UPDATE SET
      scores = EXCLUDED.scores,
      failure_modes = EXCLUDED.failure_modes,
      suggested_mutations = EXCLUDED.suggested_mutations,
      recommendation = EXCLUDED.recommendation,
      model_id = EXCLUDED.model_id,
      cost_usd = EXCLUDED.cost_usd
    RETURNING *
  `;
  if (!row) throw new Error("evaluation insert returned no row");
  return row;
}

export async function listEvaluations(
  sql: Sql,
  genomeVersionId: string,
): Promise<EvaluationRow[]> {
  return sql<EvaluationRow[]>`
    SELECT * FROM evaluations WHERE genome_version_id = ${genomeVersionId}
    ORDER BY created_at ASC
  `;
}

export async function createBenchmark(
  sql: Sql,
  input: {
    id: string;
    workspaceId: string | null;
    name: string;
    slug: string;
    description?: string | null;
    tasks: unknown;
    scoring: unknown;
    visibility?: "private" | "public";
  },
): Promise<{ id: string }> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO benchmarks (id, workspace_id, name, slug, description, tasks, scoring, visibility)
    VALUES (${input.id}, ${input.workspaceId}, ${input.name}, ${input.slug},
            ${input.description ?? null}, ${sql.json(input.tasks as never)},
            ${sql.json(input.scoring as never)}, ${input.visibility ?? "private"})
    RETURNING id
  `;
  if (!row) throw new Error("benchmark insert returned no row");
  return row;
}

export async function insertBenchmarkResult(
  sql: Sql,
  input: {
    id: string;
    benchmarkId: string;
    ecosystemId: string;
    genomeVersionId: string;
    runId?: string | null;
    taskId: string;
    scores: unknown;
    overallScore: number;
    costUsd: number;
    efficiency: number | null;
    totalTokens: number;
  },
): Promise<BenchmarkResultRow> {
  const [row] = await sql<BenchmarkResultRow[]>`
    INSERT INTO benchmark_results
      (id, benchmark_id, ecosystem_id, genome_version_id, run_id, task_id,
       scores, overall_score, cost_usd, efficiency, total_tokens)
    VALUES (
      ${input.id}, ${input.benchmarkId}, ${input.ecosystemId}, ${input.genomeVersionId},
      ${input.runId ?? null}, ${input.taskId}, ${sql.json(input.scores as never)},
      ${input.overallScore}, ${input.costUsd}, ${input.efficiency}, ${input.totalTokens}
    )
    RETURNING *
  `;
  if (!row) throw new Error("benchmark result insert returned no row");
  return row;
}

/**
 * Aggregate a genome version's standing on a benchmark.
 *
 * Deliberately computed rather than stored: `genome_versions` is append-only,
 * so a version cannot carry a mutable score column. Ranking is derived from the
 * results table on read.
 */
export async function getVersionBenchmarkSummary(
  sql: Sql,
  benchmarkId: string,
  genomeVersionId: string,
): Promise<{ tasks: number; avgScore: number; totalCostUsd: number; efficiency: number | null }> {
  const [row] = await sql<
    Array<{ tasks: string; avg_score: string | null; total_cost: string | null }>
  >`
    SELECT count(*)::text AS tasks,
           avg(overall_score)::text AS avg_score,
           sum(cost_usd)::text AS total_cost
    FROM benchmark_results
    WHERE benchmark_id = ${benchmarkId} AND genome_version_id = ${genomeVersionId}
  `;
  const tasks = Number(row?.tasks ?? 0);
  const avgScore = Number(row?.avg_score ?? 0);
  const totalCostUsd = Number(row?.total_cost ?? 0);
  return {
    tasks,
    avgScore,
    totalCostUsd,
    efficiency: totalCostUsd > 0 ? avgScore / totalCostUsd : null,
  };
}

/** Leaderboard across versions of an ecosystem for one benchmark. */
export async function rankVersions(
  sql: Sql,
  benchmarkId: string,
  ecosystemId: string,
): Promise<
  Array<{ genomeVersionId: string; version: number; avgScore: string; totalCost: string }>
> {
  return sql<
    Array<{ genomeVersionId: string; version: number; avgScore: string; totalCost: string }>
  >`
    SELECT br.genome_version_id AS "genomeVersionId",
           gv.version,
           avg(br.overall_score)::text AS "avgScore",
           sum(br.cost_usd)::text AS "totalCost"
    FROM benchmark_results br
    JOIN genome_versions gv ON gv.id = br.genome_version_id
    WHERE br.benchmark_id = ${benchmarkId} AND br.ecosystem_id = ${ecosystemId}
    GROUP BY br.genome_version_id, gv.version
    ORDER BY avg(br.overall_score) DESC
  `;
}
