import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { genomes, runs, type Sql } from "../src/index.js";
import { contentHash } from "@meta/shared";
import { ensureSchema, seedTenant, testSql } from "./helpers.js";

let sql: Sql;

beforeAll(async () => {
  sql = testSql();
  await ensureSchema(sql);
});

afterAll(async () => {
  await sql.end();
});

async function seedRun(label: string) {
  const t = await seedTenant(sql, label);
  const { version } = await genomes.createGenomeVersion(sql, {
    id: t.ids.next("genomeVersion"),
    ecosystemId: t.ecosystemId,
    genomeHash: contentHash({ label }),
    genome: { label },
    origin: "SEED",
  });
  const run = await runs.createRun(sql, {
    id: t.ids.next("run"),
    ecosystemId: t.ecosystemId,
    genomeVersionId: version.id,
    objective: "test objective",
    seed: "seed-1",
  });
  return { ...t, version, run };
}


/** claimStep with a default owner token; concurrency tests override it. */
const claim = (
  args: Omit<Parameters<typeof runs.claimStep>[1], "ownerToken"> & { ownerToken?: string },
) => runs.claimStep(sql, { ownerToken: "worker-1", ...args });

describe("step journal", () => {
  it("claims a step once, then replays it", async () => {
    const { run } = await seedRun("j1");
    const key = `${run.id}:0:PROPOSALS:agent-a`;
    const inputHash = contentHash({ objective: "test objective" });

    const first = await claim({
      runId: run.id,
      stepKey: key,
      iteration: 0,
      stage: "PROPOSALS",
      unitId: "agent-a",
      inputHash,
    });
    expect(first.kind).toBe("claimed");

    await runs.completeStep(sql, run.id, key, { answer: 42 }, 120);

    const second = await claim({
      runId: run.id,
      stepKey: key,
      iteration: 0,
      stage: "PROPOSALS",
      unitId: "agent-a",
      inputHash,
    });
    expect(second.kind).toBe("replay");
    expect(second.step.output).toEqual({ answer: 42 });
    expect(second.step.attempt).toBe(1); // replay must not burn an attempt
  });

  it("re-runs a completed step whose inputs changed", async () => {
    const { run } = await seedRun("j2");
    const key = `${run.id}:0:SYNTHESIS:stage`;

    await claim({
      runId: run.id,
      stepKey: key,
      iteration: 0,
      stage: "SYNTHESIS",
      unitId: "stage",
      inputHash: contentHash({ proposals: ["a"] }),
    });
    await runs.completeStep(sql, run.id, key, { synthesis: "v1" }, 50);

    // A new proposal upstream changes this step's inputs; the recorded output
    // no longer describes it, so replaying would be wrong.
    const reclaimed = await claim({
      runId: run.id,
      stepKey: key,
      iteration: 0,
      stage: "SYNTHESIS",
      unitId: "stage",
      inputHash: contentHash({ proposals: ["a", "b"] }),
    });
    expect(reclaimed.kind).toBe("claimed");
    expect(reclaimed.step.attempt).toBe(2);
  });

  it("retries a failed step rather than replaying the failure", async () => {
    const { run } = await seedRun("j3");
    const key = `${run.id}:0:WATCHER:stage`;
    const inputHash = contentHash({ x: 1 });

    await claim({
      runId: run.id,
      stepKey: key,
      iteration: 0,
      stage: "WATCHER",
      unitId: "stage",
      inputHash,
    });
    await runs.failStep(sql, run.id, key, { message: "provider timeout" });

    const retry = await claim({
      runId: run.id,
      stepKey: key,
      iteration: 0,
      stage: "WATCHER",
      unitId: "stage",
      inputHash,
    });
    expect(retry.kind).toBe("claimed");
    expect(retry.step.attempt).toBe(2);
    expect(retry.step.error).toBeNull();
  });

  it("gives exactly one worker the claim when several race for a fresh step", async () => {
    const { run } = await seedRun("j4");
    const key = `${run.id}:0:PROPOSALS:contended`;
    const inputHash = contentHash({ contended: true });

    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        claim({
          runId: run.id,
          stepKey: key,
          iteration: 0,
          stage: "PROPOSALS",
          unitId: "contended",
          inputHash,
          ownerToken: `worker-${i}`,
        }),
      ),
    );

    // The guarantee that matters: exactly one worker executes. Returning
    // "claimed" to all six would have them each make the same model call and
    // race to overwrite the journal.
    expect(claims.filter((c) => c.kind === "claimed")).toHaveLength(1);
    expect(claims.filter((c) => c.kind === "in_progress")).toHaveLength(5);

    const rows = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM run_steps
      WHERE run_id = ${run.id} AND step_key = ${key}
    `;
    expect(rows[0]?.count).toBe("1");
  });

  it("lets a second worker take over once the lease has expired", async () => {
    const { run } = await seedRun("j4b");
    const key = `${run.id}:0:PROPOSALS:stalled`;
    const inputHash = contentHash({ stalled: true });

    const first = await claim({
      runId: run.id,
      stepKey: key,
      iteration: 0,
      stage: "PROPOSALS",
      unitId: "stalled",
      inputHash,
      ownerToken: "worker-dead",
      leaseSeconds: 1,
    });
    expect(first.kind).toBe("claimed");

    // Simulate the holder dying: expire its lease without completing.
    await sql`
      UPDATE run_steps SET lease_expires_at = now() - interval '1 second'
      WHERE run_id = ${run.id} AND step_key = ${key}
    `;

    const takeover = await claim({
      runId: run.id,
      stepKey: key,
      iteration: 0,
      stage: "PROPOSALS",
      unitId: "stalled",
      inputHash,
      ownerToken: "worker-live",
    });

    // A dead worker must not strand the run forever.
    expect(takeover.kind).toBe("claimed");
    expect(takeover.step.owner_token).toBe("worker-live");
  });

  it("refuses a result from a worker whose lease was taken over", async () => {
    const { run } = await seedRun("j4c");
    const key = `${run.id}:0:PROPOSALS:usurped`;
    const inputHash = contentHash({ usurped: true });

    await claim({
      runId: run.id,
      stepKey: key,
      iteration: 0,
      stage: "PROPOSALS",
      unitId: "usurped",
      inputHash,
      ownerToken: "worker-old",
    });
    await sql`
      UPDATE run_steps SET owner_token = 'worker-new'
      WHERE run_id = ${run.id} AND step_key = ${key}
    `;

    const stored = await runs.completeStep(sql, run.id, key, { late: true }, 10, "worker-old");
    expect(stored).toBe(false);

    const step = await runs.getStep(sql, run.id, key);
    expect(step?.output).toBeNull();
  });

  it("keeps steps of different iterations independent", async () => {
    const { run } = await seedRun("j5");
    const inputHash = contentHash({ same: "inputs" });

    for (const iteration of [0, 1]) {
      await claim({
        runId: run.id,
        stepKey: `${run.id}:${iteration}:PROPOSALS:agent-a`,
        iteration,
        stage: "PROPOSALS",
        unitId: "agent-a",
        inputHash,
      });
    }

    const steps = await runs.listSteps(sql, run.id);
    expect(steps).toHaveLength(2);
    expect(steps.map((s) => s.iteration)).toEqual([0, 1]);
  });
});

describe("run accounting", () => {
  it("accumulates usage across calls", async () => {
    const { run } = await seedRun("acct");
    await runs.addRunUsage(sql, run.id, { inputTokens: 100, outputTokens: 50, costUsd: 0.0012 });
    await runs.addRunUsage(sql, run.id, { inputTokens: 20, outputTokens: 10, costUsd: 0.0003 });

    const updated = await runs.getRun(sql, run.id);
    expect(updated?.input_tokens).toBe("120");
    expect(updated?.output_tokens).toBe("60");
    // NUMERIC arithmetic must stay exact — this is billing data.
    expect(Number(updated?.cost_usd)).toBeCloseTo(0.0015, 10);
  });

  it("records a terminal state once finished", async () => {
    const { run } = await seedRun("fin");
    await runs.updateRunProgress(sql, run.id, { status: "RUNNING", stage: "PROPOSALS" });
    await runs.finishRun(sql, run.id, { status: "COMPLETED", result: { ok: true } });

    const done = await runs.getRun(sql, run.id);
    expect(done?.status).toBe("COMPLETED");
    expect(done?.result).toEqual({ ok: true });
    expect(done?.finished_at).toBeInstanceOf(Date);
    expect(done?.started_at).toBeInstanceOf(Date);
  });
});

describe("provenance", () => {
  it("traces a synthesis artifact back through challenges to proposals", async () => {
    const { run, ids } = await seedRun("prov");

    const proposal = await runs.insertArtifact(sql, {
      id: ids.next("artifact"),
      runId: run.id,
      iteration: 0,
      stage: "PROPOSALS",
      agentId: "agent-a",
      kind: "PROPOSAL",
      content: { claim: "X causes Y" },
    });
    const challenge = await runs.insertArtifact(sql, {
      id: ids.next("artifact"),
      runId: run.id,
      iteration: 0,
      stage: "CHALLENGES",
      agentId: "agent-b",
      kind: "CHALLENGE",
      content: { objection: "confounded by Z" },
      parentArtifactIds: [proposal.id],
    });
    const synthesis = await runs.insertArtifact(sql, {
      id: ids.next("artifact"),
      runId: run.id,
      iteration: 0,
      stage: "SYNTHESIS",
      kind: "SYNTHESIS",
      content: { contested: ["X causes Y"] },
      parentArtifactIds: [challenge.id],
    });

    const trace = await runs.traceProvenance(sql, synthesis.id);
    expect(new Set(trace.map((a) => a.id)).size).toBe(trace.length);
    expect(trace.map((a) => a.id)).toEqual([synthesis.id, challenge.id, proposal.id]);
    expect(trace.map((a) => a.depth)).toEqual([0, 1, 2]);
  });
});
