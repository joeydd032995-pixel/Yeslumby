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
  /** Identifies this worker. Only the holder may complete the step. */
  ownerToken: string;
  /** How long this claim is valid before another worker may take it over. */
  leaseSeconds?: number;
}

export type ClaimResult =
  /** A completed step with a matching input hash: replay its recorded output. */
  | { kind: "replay"; step: RunStepRow }
  /** This caller now owns the step and must execute it. */
  | { kind: "claimed"; step: RunStepRow }
  /** Another live worker owns it. Wait for their result rather than duplicating. */
  | { kind: "in_progress"; step: RunStepRow };

const DEFAULT_LEASE_SECONDS = 300;

/**
 * Claim a unit of work, or return the recorded result of a prior attempt.
 *
 * This is the whole of the durability guarantee. Re-entering a run replays
 * every completed step from the journal instead of re-executing it, so a resume
 * after a crash or a human-approval pause costs nothing and — critically —
 * repeats no model calls.
 *
 * Ownership is leased. An earlier version returned "claimed" to every concurrent
 * caller, which meant two workers entering the same fresh step both executed it
 * and raced to write the journal — the at-most-once property held only within a
 * single process. Now the row carries an owner token and an expiry: a live
 * owner makes other callers wait, and an expired lease can be taken over so a
 * dead worker cannot strand the run.
 *
 * A completed row whose `input_hash` differs is stale: its inputs changed, so
 * the recorded output no longer describes this step and it is re-run.
 */
export async function claimStep(sql: Sql, input: ClaimStepInput): Promise<ClaimResult> {
  const lease = input.leaseSeconds ?? DEFAULT_LEASE_SECONDS;

  // A fresh step: whoever wins the insert owns it.
  const [inserted] = await sql<RunStepRow[]>`
    INSERT INTO run_steps
      (run_id, step_key, iteration, stage, unit_id, input_hash, status,
       owner_token, lease_expires_at)
    VALUES (${input.runId}, ${input.stepKey}, ${input.iteration}, ${input.stage},
            ${input.unitId}, ${input.inputHash}, 'RUNNING',
            ${input.ownerToken}, now() + make_interval(secs => ${lease}))
    ON CONFLICT (run_id, step_key) DO NOTHING
    RETURNING *
  `;
  if (inserted) return { kind: "claimed", step: inserted };

  const [prior] = await sql<RunStepRow[]>`
    SELECT * FROM run_steps WHERE run_id = ${input.runId} AND step_key = ${input.stepKey}
  `;
  if (!prior) throw new Error(`step ${input.stepKey} vanished after conflict`);

  if (prior.status === "COMPLETED" && prior.input_hash === input.inputHash) {
    return { kind: "replay", step: prior };
  }

  // Someone else is working on it and their lease is still good.
  if (
    prior.status === "RUNNING" &&
    prior.owner_token !== null &&
    prior.owner_token !== input.ownerToken &&
    prior.lease_expires_at !== null &&
    prior.lease_expires_at.getTime() > Date.now()
  ) {
    return { kind: "in_progress", step: prior };
  }

  // Free to take: completed-but-stale, failed, our own re-entry, or an expired
  // lease. The WHERE clause re-checks the state we decided on, so two workers
  // racing to steal the same expired lease cannot both win.
  const [taken] = await sql<RunStepRow[]>`
    UPDATE run_steps
    SET status = 'RUNNING',
        attempt = attempt + 1,
        input_hash = ${input.inputHash},
        owner_token = ${input.ownerToken},
        lease_expires_at = now() + make_interval(secs => ${lease}),
        error = NULL,
        updated_at = now()
    WHERE run_id = ${input.runId}
      AND step_key = ${input.stepKey}
      AND (
        owner_token IS NOT DISTINCT FROM ${prior.owner_token}
        OR lease_expires_at IS NULL
        OR lease_expires_at <= now()
      )
    RETURNING *
  `;

  if (taken) return { kind: "claimed", step: taken };

  // Lost the race to another worker; re-read and defer to them.
  const [current] = await sql<RunStepRow[]>`
    SELECT * FROM run_steps WHERE run_id = ${input.runId} AND step_key = ${input.stepKey}
  `;
  if (!current) throw new Error(`step ${input.stepKey} vanished during takeover`);
  return current.status === "COMPLETED" && current.input_hash === input.inputHash
    ? { kind: "replay", step: current }
    : { kind: "in_progress", step: current };
}

/** Re-read a step, for a waiter polling an owner it is deferring to. */
export async function getStep(
  sql: Sql,
  runId: string,
  stepKey: string,
): Promise<RunStepRow | undefined> {
  const [row] = await sql<RunStepRow[]>`
    SELECT * FROM run_steps WHERE run_id = ${runId} AND step_key = ${stepKey}
  `;
  return row;
}

/**
 * Record a step's result.
 *
 * Guarded by owner token: a worker whose lease expired and was taken over must
 * not overwrite the result produced by whoever took it. Returns false when the
 * write was refused for that reason.
 */
export async function completeStep(
  sql: Sql,
  runId: string,
  stepKey: string,
  output: unknown,
  latencyMs: number,
  ownerToken?: string,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE run_steps
    SET status = 'COMPLETED',
        output = ${sql.json(output as never)},
        latency_ms = ${latencyMs},
        error = NULL,
        lease_expires_at = NULL,
        updated_at = now()
    WHERE run_id = ${runId} AND step_key = ${stepKey}
      ${ownerToken ? sql`AND owner_token = ${ownerToken}` : sql``}
    RETURNING id
  `;
  return rows.length > 0;
}

export async function failStep(
  sql: Sql,
  runId: string,
  stepKey: string,
  error: unknown,
  ownerToken?: string,
): Promise<void> {
  await sql`
    UPDATE run_steps
    SET status = 'FAILED',
        error = ${sql.json(error as never)},
        lease_expires_at = NULL,
        updated_at = now()
    WHERE run_id = ${runId} AND step_key = ${stepKey}
      ${ownerToken ? sql`AND owner_token = ${ownerToken}` : sql``}
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
  // DISTINCT ON collapses an artifact reachable by several paths to its
  // shortest one. In a normal round a proposal is both a direct parent of the
  // synthesis and a parent of the challenges against it, so without this the
  // same proposal appears at depth 1 and depth 2 — inflating provenance counts
  // and drawing duplicate nodes in the graph. `depth` participates in the
  // recursive UNION's row identity, so the CTE cannot dedupe on its own.
  return sql<Array<AgentArtifactRow & { depth: number }>>`
    WITH RECURSIVE trace AS (
      SELECT a.*, 0 AS depth FROM agent_artifacts a WHERE a.id = ${artifactId}
      UNION
      SELECT parent.*, t.depth + 1
      FROM trace t
      JOIN agent_artifacts parent ON parent.id = ANY(t.parent_artifact_ids)
      WHERE t.depth < 50
    ),
    shallowest AS (
      SELECT DISTINCT ON (id) * FROM trace ORDER BY id, depth ASC
    )
    SELECT * FROM shallowest ORDER BY depth ASC, created_at ASC
  `;
}
