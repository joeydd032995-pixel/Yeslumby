import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { contentHash, systemClock, JournalReplayError, type Clock } from "@meta/shared";
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
 *
 * A stored result is read back against the schema that describes it, never
 * asserted into shape. The difference is not pedantry: a run parked awaiting
 * approval can resume days later, against a build whose stage contracts have
 * moved underneath it. Parsing is also what lets a schema *repair* such a row,
 * because the parsed value is what gets returned — a field added with a default
 * since the row was written arrives filled in rather than missing.
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
  /**
   * Called when a stored result was refused and will be recomputed.
   *
   * A port rather than an event emit, so the journal reports a journal fact in
   * journal terms and stays unaware that a run event stream exists. Whoever
   * supplies the context decides what that means to them.
   */
  onReplayRejected?: (rejection: ReplayRejection) => void;
}

/** One token per process, so a crashed process's leases are visibly foreign. */
const PROCESS_TOKEN = `w_${randomUUID()}`;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface StepSpec<S extends z.ZodType = z.ZodType> {
  stage: string;
  /** Distinguishes parallel units within a stage; agent id for fan-out. */
  unitId?: string;
  /**
   * Everything the step's result depends on. Hashed, and a mismatch against a
   * recorded step means the result is stale and must be recomputed.
   */
  input: unknown;
  /**
   * The contract the step's result must satisfy, both to be stored and to be
   * replayed.
   *
   * Required, not optional, and that is the enforcement mechanism: a seventh
   * journaled step cannot be written without its author stating what the stored
   * shape is, because `tsc` will not compile it otherwise. An optional field
   * would re-open the hole the moment someone was in a hurry.
   */
  output: S;
}

export interface StepResult<T> {
  value: T;
  /** True when the result came from the journal rather than fresh execution. */
  replayed: boolean;
  latencyMs: number;
  /**
   * Set when a stored result was refused during this call.
   *
   * No stage reads this yet — the refusal reaches a run through
   * `onReplayRejected`, which cannot be forgotten at a call site. It is here so
   * a caller that wants to react to its own refusal can, and so tests can
   * assert on one without reaching into an event array.
   */
  revalidation?: ReplayRejection;
}

/** Why a stored result could not be read under the current contract. */
export interface ReplayRejection {
  stage: string;
  unitId: string;
  stepKey: string;
  /** A short human-readable summary, suitable for an event or a log line. */
  reason: string;
  issues: Array<{ path: string; message: string; code: string }>;
}

export function stepKey(
  runId: string,
  iteration: number,
  stage: string,
  unitId = "stage",
): string {
  return `${runId}:${iteration}:${stage}:${unitId}`;
}

function describe(error: z.ZodError): ReplayRejection["issues"] {
  return error.issues.slice(0, 5).map((issue) => ({
    path: issue.path.join(".") || "<root>",
    message: issue.message,
    code: issue.code,
  }));
}

export async function durableStep<S extends z.ZodType>(
  ctx: JournalContext,
  spec: StepSpec<S>,
  execute: () => Promise<z.output<S>>,
): Promise<StepResult<z.output<S>>> {
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

  const reject = (error: z.ZodError): ReplayRejection => {
    const issues = describe(error);
    return {
      stage: spec.stage,
      unitId,
      stepKey: key,
      reason: issues.map((i) => `${i.path}: ${i.message}`).join("; "),
      issues,
    };
  };

  const deadline = Date.now() + maxWaitMs;
  let claim = await runs.claimStep(ctx.sql, claimArgs);

  /**
   * At most one refusal per call. Without this bound, a schema that no possible
   * stage output satisfies becomes an unbounded recompute loop that spends real
   * money on every pass.
   */
  let refused: ReplayRejection | undefined;

  for (;;) {
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

    if (claim.kind !== "replay") break;

    const parsed = spec.output.safeParse(claim.step.output);
    if (parsed.success) {
      return {
        value: parsed.data,
        replayed: true,
        latencyMs: claim.step.latency_ms ?? 0,
        ...(refused ? { revalidation: refused } : {}),
      };
    }

    if (refused) {
      // We refused this row, lost the race to invalidate it, and the result
      // whoever won recorded in its place is unreadable too. Reachable only
      // under concurrency — a single worker breaks out to execute after its
      // one refusal and never returns here. Refusing again would be an
      // unbounded recompute loop spending real money on every pass, so the
      // bound is one refusal per call and this is where it bites.
      throw new JournalReplayError(`step ${key} was replaced by a result that is also unreadable`, {
        stage: spec.stage,
        unitId,
        phase: "post-refusal",
        issues: describe(parsed.error),
      });
    }

    refused = reject(parsed.error);
    ctx.onReplayRejected?.(refused);

    const taken = await runs.invalidateStep(ctx.sql, {
      runId: ctx.runId,
      stepKey: key,
      inputHash,
      ownerToken,
      reason: { code: "JOURNAL_REPLAY_INVALID", reason: refused.reason, issues: refused.issues },
      ...(ctx.leaseSeconds !== undefined ? { leaseSeconds: ctx.leaseSeconds } : {}),
    });

    // Took it: we own the step and execute below. Did not: the row moved under
    // us, so go back and decide again on whatever state it is in now.
    if (taken) break;
    claim = await runs.claimStep(ctx.sql, claimArgs);
  }

  const startedAt = clock.monotonicMs();
  try {
    const produced = await execute();
    const latencyMs = Math.max(0, Math.round(clock.monotonicMs() - startedAt));

    // Parse before storing, so "what the journal stores, it can give back" is
    // true at write time rather than hoped for at read time. A stage that has
    // drifted from its schema fails on the first run that exercises it instead
    // of on someone's resume weeks later.
    const checked = spec.output.safeParse(produced);
    if (!checked.success) {
      throw new JournalReplayError(`step ${key} produced output violating its stored contract`, {
        stage: spec.stage,
        unitId,
        phase: "pre-store",
        issues: describe(checked.error),
      });
    }
    const value = checked.data;

    const stored = await runs.completeStep(ctx.sql, ctx.runId, key, value, latencyMs, ownerToken);
    if (!stored) {
      // Our lease expired and another worker took over. Theirs is the result of
      // record; ours is discarded rather than overwriting it.
      const current = await runs.getStep(ctx.sql, ctx.runId, key);
      if (current?.status === "COMPLETED") {
        const adopted = spec.output.safeParse(current.output);
        if (adopted.success) {
          return {
            value: adopted.data,
            replayed: true,
            latencyMs: current.latency_ms ?? latencyMs,
            ...(refused ? { revalidation: refused } : {}),
          };
        }
        // The one place the policy is deliberately not "recompute", and the
        // reason is cost, not shape: the other worker has already paid for this
        // step. Returning our own value instead would be cheap but would leave
        // this worker's view of the run diverged from the journal every other
        // worker reads.
        throw new JournalReplayError(
          `step ${key} completed by another worker cannot be read under the current contract`,
          {
            stage: spec.stage,
            unitId,
            phase: "lost-lease",
            issues: describe(adopted.error),
          },
        );
      }
    }
    return {
      value,
      replayed: false,
      latencyMs,
      ...(refused ? { revalidation: refused } : {}),
    };
  } catch (error) {
    // Record the failure so a resumed run can see what happened, then re-throw.
    // A failed step is not replayed: the next claim retries it. The owner-token
    // guard matters on the lost-lease path above — it is what stops this write
    // from overwriting the result the other worker legitimately recorded.
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
