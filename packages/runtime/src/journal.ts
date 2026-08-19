import { randomUUID } from "node:crypto";
import { contentHash, systemClock, type Clock } from "@meta/shared";
import { runs, type Sql } from "@meta/db";

/**
 * The durability primitive.
 *
 * Every unit of work in a run passes through here. A completed step whose
 * inputs are unchanged replays from the journal instead of executing, so
 * re-entering a run after a crash, a deploy, or a human-approval pause costs
 * nothing and — the property that actually matters — repeats no model calls.
 *
 * This is the whole of the durable-workflow requirement. A hosted workflow
 * engine would give the same guarantee, but not one that can be verified here,
 * and not one that survives moving off that vendor.
 */

export interface JournalContext {
  sql: Sql;
  runId: string;
  iteration: number;
  clock?: Clock;
  /**
   * Identifies this worker for step leases. Defaults to a per-process token;
   * supply one explicitly when several workers share a process.
   */
  ownerToken?: string;
  /** How long a claim is held before another worker may take it over. */
  leaseSeconds?: number;
  /** Longest a caller waits for another worker's in-flight step. */
  maxWaitMs?: number;
  /** Injected so tests do not spend real time waiting. */
  sleep?: (ms: number) => Promise<void>;
}

/** One token per process, so a crashed process's leases are visibly foreign. */
const PROCESS_TOKEN = `w_${randomUUID()}`;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface StepSpec {
  stage: string;
  /** Distinguishes parallel units within a stage; agent id for fan-out. */
  unitId?: string;
  /**
   * Everything the step's result depends on. Hashed, and a mismatch against a
   * recorded step means the result is stale and must be recomputed.
   */
  input: unknown;
}

export interface StepResult<T> {
  value: T;
  /** True when the result came from the journal rather than fresh execution. */
  replayed: boolean;
  latencyMs: number;
}

export function stepKey(
  runId: string,
  iteration: number,
  stage: string,
  unitId = "stage",
): string {
  return `${runId}:${iteration}:${stage}:${unitId}`;
}

export async function durableStep<T>(
  ctx: JournalContext,
  spec: StepSpec,
  execute: () => Promise<T>,
): Promise<StepResult<T>> {
  const clock = ctx.clock ?? systemClock;
  const sleep = ctx.sleep ?? defaultSleep;
  const ownerToken = ctx.ownerToken ?? PROCESS_TOKEN;
  const unitId = spec.unitId ?? "stage";
  const key = stepKey(ctx.runId, ctx.iteration, spec.stage, unitId);
  const inputHash = contentHash(spec.input);
  const maxWaitMs = ctx.maxWaitMs ?? 120_000;

  const claimArgs = {
    runId: ctx.runId,
    stepKey: key,
    iteration: ctx.iteration,
    stage: spec.stage,
    unitId,
    inputHash,
    ownerToken,
    ...(ctx.leaseSeconds !== undefined ? { leaseSeconds: ctx.leaseSeconds } : {}),
  };

  const deadline = Date.now() + maxWaitMs;
  let claim = await runs.claimStep(ctx.sql, claimArgs);

  // Another live worker holds this step. Waiting for its result is the whole
  // point: executing it here too would make the model call twice, which is
  // exactly what the journal exists to prevent.
  while (claim.kind === "in_progress" && Date.now() < deadline) {
    await sleep(200);
    claim = await runs.claimStep(ctx.sql, claimArgs);
  }

  if (claim.kind === "in_progress") {
    throw new Error(
      `step ${key} is held by another worker (${claim.step.owner_token ?? "unknown"}) ` +
        `and did not complete within ${maxWaitMs}ms`,
    );
  }

  if (claim.kind === "replay") {
    return {
      value: claim.step.output as T,
      replayed: true,
      latencyMs: claim.step.latency_ms ?? 0,
    };
  }

  const startedAt = clock.monotonicMs();
  try {
    const value = await execute();
    const latencyMs = Math.max(0, Math.round(clock.monotonicMs() - startedAt));

    const stored = await runs.completeStep(ctx.sql, ctx.runId, key, value, latencyMs, ownerToken);
    if (!stored) {
      // Our lease expired and another worker took over. Theirs is the result of
      // record; ours is discarded rather than overwriting it.
      const current = await runs.getStep(ctx.sql, ctx.runId, key);
      if (current?.status === "COMPLETED") {
        return {
          value: current.output as T,
          replayed: true,
          latencyMs: current.latency_ms ?? latencyMs,
        };
      }
    }
    return { value, replayed: false, latencyMs };
  } catch (error) {
    // Record the failure so a resumed run can see what happened, then re-throw.
    // A failed step is not replayed: the next claim retries it.
    await runs.failStep(ctx.sql, ctx.runId, key, serializeError(error), ownerToken);
    throw error;
  }
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error && typeof error === "object" && "toJSON" in error) {
    const asJson = (error as { toJSON: () => unknown }).toJSON();
    if (asJson && typeof asJson === "object") return asJson as Record<string, unknown>;
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { message: String(error) };
}
