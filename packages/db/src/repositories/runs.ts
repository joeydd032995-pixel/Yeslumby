import type { Sql } from "../client.js";
import type {
  AgentArtifactRow,
  ApprovalRow,
  ApprovalStatus,
  ArtifactKind,
  RunRow,
  RunStatus,
  RunStepRow,
} from "../types.js";

export interface CreateRunInput {
  id: string;
  ecosystemId: string;
  genomeVersionId: string;
  objective: string;
  seed: string;
  createdBy?: string | null;
}

export async function createRun(sql: Sql, input: CreateRunInput): Promise<RunRow> {
  const [row] = await sql<RunRow[]>`
    INSERT INTO runs (id, ecosystem_id, genome_version_id, objective, seed, created_by)
    VALUES (${input.id}, ${input.ecosystemId}, ${input.genomeVersionId},
            ${input.objective}, ${input.seed}, ${input.createdBy ?? null})
    RETURNING *
  `;
  if (!row) throw new Error("run insert returned no row");
  return row;
}

export async function getRun(sql: Sql, id: string): Promise<RunRow | undefined> {
  const [row] = await sql<RunRow[]>`SELECT * FROM runs WHERE id = ${id}`;
  return row;
}

export async function listRuns(sql: Sql, ecosystemId: string, limit = 50): Promise<RunRow[]> {
  return sql<RunRow[]>`
    SELECT * FROM runs WHERE ecosystem_id = ${ecosystemId}
    ORDER BY created_at DESC LIMIT ${limit}
  `;
}

export async function updateRunProgress(
  sql: Sql,
  id: string,
  patch: { status?: RunStatus; stage?: string; iteration?: number },
): Promise<void> {
  await sql`
    UPDATE runs SET
      status    = COALESCE(${patch.status ?? null}, status),
      stage     = COALESCE(${patch.stage ?? null}, stage),
      iteration = COALESCE(${patch.iteration ?? null}, iteration),
      started_at = CASE
        WHEN started_at IS NULL AND ${patch.status ?? null} = 'RUNNING' THEN now()
        ELSE started_at END
    WHERE id = ${id}
  `;
}

export async function finishRun(
  sql: Sql,
  id: string,
  outcome:
    | { status: "COMPLETED"; result: unknown }
    | { status: "FAILED"; error: unknown }
    | { status: "STOPPED"; result?: unknown },
): Promise<void> {
  const result = "result" in outcome ? outcome.result : null;
  const error = "error" in outcome ? outcome.error : null;
  await sql`
    UPDATE runs SET
      status = ${outcome.status},
      result = ${result === null || result === undefined ? null : sql.json(result as never)},
      error  = ${error === null || error === undefined ? null : sql.json(error as never)},
      finished_at = now()
    WHERE id = ${id}
  `;
}

/** Fold a model call's usage into the run's running totals. */
export async function addRunUsage(
  sql: Sql,
  id: string,
  usage: { inputTokens: number; outputTokens: number; costUsd: number },
): Promise<void> {
  await sql`
    UPDATE runs SET
      input_tokens  = input_tokens + ${usage.inputTokens},
      output_tokens = output_tokens + ${usage.outputTokens},
      cost_usd      = cost_usd + ${usage.costUsd}
    WHERE id = ${id}
  `;
}

// ---------------------------------------------------------------------------
// Durable step journal
// ---------------------------------------------------------------------------

export interface ClaimStepInput {
  runId: string;
  stepKey: string;
  iteration: number;
  stage: string;
  unitId: string;
  inputHash: string;
}

export type ClaimResult =
  /** A completed step with a matching input hash: replay its recorded output. */
  | { kind: "replay"; step: RunStepRow }
  /** This caller now owns the step and must execute it. */
  | { kind: "claimed"; step: RunStepRow };

/**
 * Claim a unit of work, or return the recorded result of a prior attempt.
 *
 * This is the whole of the durability guarantee. Re-entering a run replays
 * every completed step from the journal instead of re-executing it, so a resume
 * after a crash or a human-approval pause costs nothing and — critically —
 * repeats no model calls.
 *
 * A completed row whose `input_hash` differs is stale: its inputs changed, so
 * the recorded output no longer describes this step and it is re-run.
 */
export async function claimStep(sql: Sql, input: ClaimStepInput): Promise<ClaimResult> {
  const existing = await sql<RunStepRow[]>`
    SELECT * FROM run_steps WHERE run_id = ${input.runId} AND step_key = ${input.stepKey}
  `;
  const prior = existing[0];

  if (prior?.status === "COMPLETED" && prior.input_hash === input.inputHash) {
    return { kind: "replay", step: prior };
  }

  if (prior) {
    const [row] = await sql<RunStepRow[]>`
      UPDATE run_steps
      SET status = 'RUNNING',
          attempt = attempt + 1,
          input_hash = ${input.inputHash},
          error = NULL,
          updated_at = now()
      WHERE run_id = ${input.runId} AND step_key = ${input.stepKey}
      RETURNING *
    `;
    if (!row) throw new Error(`failed to re-claim step ${input.stepKey}`);
    return { kind: "claimed", step: row };
  }

  // ON CONFLICT covers a concurrent claimer inserting between the SELECT above
  // and this INSERT; the loser re-reads rather than failing the run.
  const [inserted] = await sql<RunStepRow[]>`
    INSERT INTO run_steps (run_id, step_key, iteration, stage, unit_id, input_hash, status)
    VALUES (${input.runId}, ${input.stepKey}, ${input.iteration}, ${input.stage},
            ${input.unitId}, ${input.inputHash}, 'RUNNING')
    ON CONFLICT (run_id, step_key) DO NOTHING
    RETURNING *
  `;
  if (inserted) return { kind: "claimed", step: inserted };

  const [raced] = await sql<RunStepRow[]>`
    SELECT * FROM run_steps WHERE run_id = ${input.runId} AND step_key = ${input.stepKey}
  `;
  if (!raced) throw new Error(`step ${input.stepKey} vanished after conflict`);
  return raced.status === "COMPLETED" && raced.input_hash === input.inputHash
    ? { kind: "replay", step: raced }
    : { kind: "claimed", step: raced };
}

export async function completeStep(
  sql: Sql,
  runId: string,
  stepKey: string,
  output: unknown,
  latencyMs: number,
): Promise<void> {
  await sql`
    UPDATE run_steps
    SET status = 'COMPLETED',
        output = ${sql.json(output as never)},
        latency_ms = ${latencyMs},
        error = NULL,
        updated_at = now()
    WHERE run_id = ${runId} AND step_key = ${stepKey}
  `;
}

export async function failStep(
  sql: Sql,
  runId: string,
  stepKey: string,
  error: unknown,
): Promise<void> {
  await sql`
    UPDATE run_steps
    SET status = 'FAILED', error = ${sql.json(error as never)}, updated_at = now()
    WHERE run_id = ${runId} AND step_key = ${stepKey}
  `;
}

export async function listSteps(sql: Sql, runId: string): Promise<RunStepRow[]> {
  return sql<RunStepRow[]>`
    SELECT * FROM run_steps WHERE run_id = ${runId}
    ORDER BY iteration ASC, id ASC
  `;
}

// ---------------------------------------------------------------------------
// Human approval
// ---------------------------------------------------------------------------

export async function upsertApproval(
  sql: Sql,
  input: { id: string; runId: string; iteration: number; stage: string; payload: unknown },
): Promise<ApprovalRow> {
  const [row] = await sql<ApprovalRow[]>`
    INSERT INTO approvals (id, run_id, iteration, stage, payload)
    VALUES (${input.id}, ${input.runId}, ${input.iteration}, ${input.stage},
            ${sql.json(input.payload as never)})
    ON CONFLICT (run_id, iteration, stage) DO UPDATE SET payload = EXCLUDED.payload
    RETURNING *
  `;
  if (!row) throw new Error("approval upsert returned no row");
  return row;
}

export async function getApproval(
  sql: Sql,
  runId: string,
  iteration: number,
  stage: string,
): Promise<ApprovalRow | undefined> {
  const [row] = await sql<ApprovalRow[]>`
    SELECT * FROM approvals
    WHERE run_id = ${runId} AND iteration = ${iteration} AND stage = ${stage}
  `;
  return row;
}

export async function decideApproval(
  sql: Sql,
  id: string,
  decision: Exclude<ApprovalStatus, "PENDING">,
  decidedBy: string | null,
  note?: string,
): Promise<void> {
  await sql`
    UPDATE approvals
    SET status = ${decision}, decided_by = ${decidedBy}, note = ${note ?? null},
        decided_at = now()
    WHERE id = ${id} AND status = 'PENDING'
  `;
}

export async function listPendingApprovals(sql: Sql, ecosystemId: string): Promise<ApprovalRow[]> {
  return sql<ApprovalRow[]>`
    SELECT a.* FROM approvals a
    JOIN runs r ON r.id = a.run_id
    WHERE r.ecosystem_id = ${ecosystemId} AND a.status = 'PENDING'
    ORDER BY a.created_at ASC
  `;
}

// ---------------------------------------------------------------------------
// Artifacts (provenance)
// ---------------------------------------------------------------------------

export interface InsertArtifactInput {
  id: string;
  runId: string;
  iteration: number;
  stage: string;
  agentId?: string | null;
  kind: ArtifactKind;
  content: unknown;
  modelId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs?: number | null;
  parentArtifactIds?: string[];
}

export async function insertArtifact(
  sql: Sql,
  input: InsertArtifactInput,
): Promise<AgentArtifactRow> {
  const [row] = await sql<AgentArtifactRow[]>`
    INSERT INTO agent_artifacts
      (id, run_id, iteration, stage, agent_id, kind, content, model_id,
       input_tokens, output_tokens, cost_usd, latency_ms, parent_artifact_ids)
    VALUES (
      ${input.id}, ${input.runId}, ${input.iteration}, ${input.stage},
      ${input.agentId ?? null}, ${input.kind}, ${sql.json(input.content as never)},
      ${input.modelId ?? null}, ${input.inputTokens ?? 0}, ${input.outputTokens ?? 0},
      ${input.costUsd ?? 0}, ${input.latencyMs ?? null}, ${input.parentArtifactIds ?? []}
    )
    RETURNING *
  `;
  if (!row) throw new Error("artifact insert returned no row");
  return row;
}

export async function listArtifacts(
  sql: Sql,
  runId: string,
  filter: { iteration?: number; stage?: string; kind?: ArtifactKind } = {},
): Promise<AgentArtifactRow[]> {
  return sql<AgentArtifactRow[]>`
    SELECT * FROM agent_artifacts
    WHERE run_id = ${runId}
      ${filter.iteration !== undefined ? sql`AND iteration = ${filter.iteration}` : sql``}
      ${filter.stage ? sql`AND stage = ${filter.stage}` : sql``}
      ${filter.kind ? sql`AND kind = ${filter.kind}` : sql``}
    ORDER BY created_at ASC
  `;
}

export async function getArtifact(
  sql: Sql,
  id: string,
): Promise<AgentArtifactRow | undefined> {
  const [row] = await sql<AgentArtifactRow[]>`SELECT * FROM agent_artifacts WHERE id = ${id}`;
  return row;
}

/**
 * Walk an artifact's provenance back to its roots.
 *
 * Every final claim must be traceable through synthesis to the proposals,
 * evidence, and memory it rests on; this is the query that makes that concrete.
 */
export async function traceProvenance(
  sql: Sql,
  artifactId: string,
): Promise<Array<AgentArtifactRow & { depth: number }>> {
  return sql<Array<AgentArtifactRow & { depth: number }>>`
    WITH RECURSIVE trace AS (
      SELECT a.*, 0 AS depth FROM agent_artifacts a WHERE a.id = ${artifactId}
      UNION
      SELECT parent.*, t.depth + 1
      FROM trace t
      JOIN agent_artifacts parent ON parent.id = ANY(t.parent_artifact_ids)
      WHERE t.depth < 50
    )
    SELECT * FROM trace ORDER BY depth ASC, created_at ASC
  `;
}
