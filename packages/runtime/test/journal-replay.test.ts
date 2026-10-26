import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runs, type Sql } from "@meta/db";
import { contentHash, JournalReplayError } from "@meta/shared";
import { durableStep, stepKey, type JournalContext } from "../src/journal.js";
import { StoredSynthesisSchema } from "../src/stored.js";
import { executeRound } from "../src/machine.js";
import { ensureSchema, makeHarness, testSql } from "./harness.js";

/**
 * The journal reads stored output back against the schema that describes it.
 *
 * Before this, `durableStep` returned `claim.step.output as T` — an article of
 * faith about a jsonb column written by a possibly-older build of this code.
 * Three separate bugs came through that hole: a `NaN` that silently took a
 * "cannot distinguish" branch in a promotion decision, a documented
 * replay-safety guarantee that was not real, and a per-call contract that a
 * resume bypassed. Each was fixed; the hole stayed open.
 *
 * Two behaviours matter here and they pull in opposite directions, which is why
 * both are pinned. A row that the current schema can *repair* — a field added
 * with a default since it was written — must replay for free, or every schema
 * edit bills every parked run. A row it cannot read at all must be recomputed,
 * or the wrong answer flows on silently, which is the whole complaint.
 */

let sql: Sql;

beforeAll(async () => {
  sql = testSql();
  await ensureSchema(sql);
});

afterAll(async () => {
  await sql.end();
});

/** A stored SYNTHESIS value that satisfies the current contract. */
const storedSynthesis = () => ({
  synthesis: {
    summary: "The effect replicates in two of four settings.",
    highConfidence: [],
    workingHypotheses: [],
    contested: [
      {
        question: "Does the effect replicate?",
        positions: [
          {
            agentIds: ["empiricist"],
            position: "yes",
            reasoning: "two direct replications",
            sources: [],
          },
          {
            agentIds: ["skeptic"],
            position: "no",
            reasoning: "both underpowered",
            sources: [],
          },
        ],
        whyUnresolved: "no adequately powered replication exists",
        resolvingEvidence: "a preregistered replication at n=800",
        severity: "substantive" as const,
      },
    ],
    unknowns: [],
    recommendedExperiments: [],
  },
  artifactId: "art_fixture",
  usage: { inputTokens: 10, outputTokens: 20 },
  costUsd: 0.5,
});

/**
 * Write a COMPLETED journal row directly, so the test owns both the stored
 * blob and the spec that reads it. Mutating `output` afterwards is how a row
 * from an older build is simulated: `input_hash` is left alone, so the journal
 * still considers the row valid and takes the replay path.
 */
async function journalRow(
  runId: string,
  stage: string,
  input: unknown,
  output: unknown,
  ownerToken = "worker-1",
) {
  const key = stepKey(runId, 0, stage, "stage");
  await runs.claimStep(sql, {
    runId,
    stepKey: key,
    iteration: 0,
    stage,
    unitId: "stage",
    inputHash: contentHash(input),
    ownerToken,
  });
  await runs.completeStep(sql, runId, key, output, 42, ownerToken);
  return key;
}

const journalCtxFor = (
  runId: string,
  onReplayRejected?: JournalContext["onReplayRejected"],
): JournalContext => ({
  sql,
  runId,
  iteration: 0,
  ownerToken: "worker-1",
  ...(onReplayRejected ? { onReplayRejected } : {}),
});

describe("replayed output is parsed, not asserted", () => {
  it("returns the parsed value rather than the stored blob", async () => {
    const h = await makeHarness(sql);
    const input = { probe: "strip" };
    // A key no schema declares. Returning the blob would hand it back; returning
    // the parsed value strips it. This is the assertion the whole change rests
    // on, so it is tested on its own rather than inferred from the others.
    await journalRow(h.runId, "SYNTHESIS", input, {
      ...storedSynthesis(),
      leftoverFromAnOlderBuild: true,
    });

    let ran = false;
    const step = await durableStep(
      journalCtxFor(h.runId),
      { stage: "SYNTHESIS", input, output: StoredSynthesisSchema },
      async () => {
        ran = true;
        return storedSynthesis();
      },
    );

    expect(step.replayed).toBe(true);
    expect(ran).toBe(false);
    expect(step.value).not.toHaveProperty("leftoverFromAnOlderBuild");
    expect(step.value.synthesis.summary).toContain("replicates");
  });

  it("brings a row written before a field existed up to current shape, for free", async () => {
    const h = await makeHarness(sql);
    const input = { probe: "default-repair" };
    const key = await journalRow(h.runId, "SYNTHESIS", input, storedSynthesis());

    // Exactly the row an older build wrote: `severity` absent, not null. `#-`
    // removes the key; `jsonb_set(..., 'null')` would not, and a JSON null
    // fails the enum instead of taking the default — a different test, below.
    await sql`
      UPDATE run_steps
      SET output = output #- '{synthesis,contested,0,severity}'
      WHERE run_id = ${h.runId} AND step_key = ${key}
    `;

    let ran = false;
    const step = await durableStep(
      journalCtxFor(h.runId),
      { stage: "SYNTHESIS", input, output: StoredSynthesisSchema },
      async () => {
        ran = true;
        return storedSynthesis();
      },
    );

    // The motivating bug. `scoreDisagreement` received `undefined` here and
    // produced NaN; the default now fires because something finally parses.
    expect(step.value.synthesis.contested[0]?.severity).toBe("substantive");
    expect(step.replayed).toBe(true);
    // Repair, not recompute: a schema edit must not bill every parked run.
    expect(ran).toBe(false);
    expect(step.revalidation).toBeUndefined();
    const row = await runs.getStep(sql, h.runId, key);
    expect(row?.attempt).toBe(1);
  });

  it("recomputes a stored result it cannot read, and says so", async () => {
    const h = await makeHarness(sql);
    const input = { probe: "unreadable" };
    const key = await journalRow(h.runId, "SYNTHESIS", input, storedSynthesis());

    // `summary` has no default, so nothing can repair its absence.
    await sql`
      UPDATE run_steps
      SET output = output #- '{synthesis,summary}'
      WHERE run_id = ${h.runId} AND step_key = ${key}
    `;

    const rejections: string[] = [];
    let ran = 0;
    const step = await durableStep(
      journalCtxFor(h.runId, (r) => void rejections.push(r.reason)),
      { stage: "SYNTHESIS", input, output: StoredSynthesisSchema },
      async () => {
        ran += 1;
        return storedSynthesis();
      },
    );

    expect(ran).toBe(1);
    expect(step.replayed).toBe(false);
    expect(step.value.synthesis.summary).toContain("replicates");
    expect(step.revalidation?.reason).toContain("synthesis.summary");
    expect(rejections).toHaveLength(1);

    const row = await runs.getStep(sql, h.runId, key);
    // The same state a stale input hash produces: one more attempt, recomputed.
    expect(row?.attempt).toBe(2);
    expect(row?.status).toBe("COMPLETED");
  });

  it("treats an explicit null as unreadable, where an absent key is repairable", async () => {
    const h = await makeHarness(sql);
    const input = { probe: "explicit-null" };
    const key = await journalRow(h.runId, "SYNTHESIS", input, storedSynthesis());

    // Defaults fire on `undefined`, never on `null`. Worth pinning, because the
    // two look alike in a jsonb column and behave oppositely here.
    await sql`
      UPDATE run_steps
      SET output = jsonb_set(output, '{synthesis,contested,0,severity}', 'null')
      WHERE run_id = ${h.runId} AND step_key = ${key}
    `;

    let ran = 0;
    const step = await durableStep(
      journalCtxFor(h.runId),
      { stage: "SYNTHESIS", input, output: StoredSynthesisSchema },
      async () => {
        ran += 1;
        return storedSynthesis();
      },
    );

    expect(ran).toBe(1);
    expect(step.revalidation).toBeDefined();
    expect(step.value.synthesis.contested[0]?.severity).toBe("substantive");
  });

  it("checks the runtime's half of the row, not only the model's", async () => {
    const h = await makeHarness(sql);
    const input = { probe: "envelope" };
    const key = await journalRow(h.runId, "SYNTHESIS", input, storedSynthesis());

    // `costUsd` was never covered by any schema before this. A step whose cost
    // vanished would have flowed into the run's budget accounting as undefined.
    await sql`
      UPDATE run_steps SET output = output - 'costUsd'
      WHERE run_id = ${h.runId} AND step_key = ${key}
    `;

    let ran = 0;
    const step = await durableStep(
      journalCtxFor(h.runId),
      { stage: "SYNTHESIS", input, output: StoredSynthesisSchema },
      async () => {
        ran += 1;
        return storedSynthesis();
      },
    );

    expect(ran).toBe(1);
    expect(step.revalidation?.reason).toContain("costUsd");
    expect(step.value.costUsd).toBe(0.5);
  });
});

describe("the refusal is bounded", () => {
  it("executes at most once when neither the stored nor the fresh value parses", async () => {
    const h = await makeHarness(sql);
    const input = { probe: "unsatisfiable" };
    const key = await journalRow(h.runId, "SYNTHESIS", input, storedSynthesis());
    await sql`
      UPDATE run_steps SET output = output #- '{synthesis,summary}'
      WHERE run_id = ${h.runId} AND step_key = ${key}
    `;

    // The stored row is unreadable and so is what the stage now produces — a
    // stage that has drifted from its schema. This is the bound that makes the
    // recompute policy safe to have at all: the refusal spends one execution,
    // not a loop, and the second failure stops the step instead of refusing
    // again.
    let ran = 0;
    await expect(
      durableStep(
        journalCtxFor(h.runId),
        { stage: "SYNTHESIS", input, output: StoredSynthesisSchema },
        async () => {
          ran += 1;
          const broken = storedSynthesis();
          return { ...broken, synthesis: { ...broken.synthesis, summary: "" } };
        },
      ),
    ).rejects.toThrow(JournalReplayError);

    expect(ran).toBe(1);
  });

  it("fails the step when fresh output violates its own stored contract", async () => {
    const h = await makeHarness(sql);
    const input = { probe: "fresh-invalid" };

    // Parsing before the write makes "what the journal stores, it can give
    // back" true at write time instead of hoped for at read time: a stage that
    // has drifted from its schema fails on the first run that exercises it,
    // not on someone's resume weeks later.
    await expect(
      durableStep(
        journalCtxFor(h.runId),
        { stage: "SYNTHESIS", input, output: StoredSynthesisSchema },
        async () => ({ ...storedSynthesis(), costUsd: -1 }),
      ),
    ).rejects.toThrow(JournalReplayError);

    const row = await runs.getStep(sql, h.runId, stepKey(h.runId, 0, "SYNTHESIS", "stage"));
    expect(row?.status).toBe("FAILED");
    expect(row?.error).toMatchObject({ code: "JOURNAL_REPLAY_INVALID" });
  });

  it("will not adopt an unreadable result from the worker that took the lease", async () => {
    const h = await makeHarness(sql);
    const input = { probe: "lost-lease" };
    const key = stepKey(h.runId, 0, "SYNTHESIS", "stage");

    // The lease has to be stolen *while* we execute, which is the only way to
    // reach this branch: claiming a row that is already COMPLETED takes the
    // replay path instead, refuses it there, and recomputes.
    await expect(
      durableStep(
        { ...journalCtxFor(h.runId), ownerToken: "worker-old" },
        { stage: "SYNTHESIS", input, output: StoredSynthesisSchema },
        async () => {
          await sql`
            UPDATE run_steps SET owner_token = 'worker-new'
            WHERE run_id = ${h.runId} AND step_key = ${key}
          `;
          await runs.completeStep(
            sql,
            h.runId,
            key,
            { ...storedSynthesis(), artifactId: "" },
            10,
            "worker-new",
          );
          return storedSynthesis();
        },
      ),
      // The one place the policy is deliberately not "recompute": the other
      // worker already paid for this step. Our own value is valid and right
      // here, but returning it would leave this worker's view of the run
      // diverged from the journal every other worker reads.
    ).rejects.toThrow(/completed by another worker/);

    const row = await runs.getStep(sql, h.runId, key);
    // worker-old's failStep is owner-guarded, so it did not overwrite the row
    // worker-new legitimately recorded.
    expect(row?.status).toBe("COMPLETED");
    expect(row?.owner_token).toBe("worker-new");
  });
});

describe("a real round", () => {
  it("recomputes the step whose stored output it cannot read", async () => {
    const h = await makeHarness(sql);
    await executeRound(h.ctx);
    const afterFirst = h.simulator.callCount;

    // Degrade one journaled proposal, leaving every other step intact.
    const steps = await runs.listSteps(sql, h.runId);
    const victim = steps.find((s) => s.stage === "PROPOSALS");
    expect(victim).toBeDefined();
    await sql`
      UPDATE run_steps SET output = output #- '{proposal,summary}'
      WHERE run_id = ${h.runId} AND step_key = ${victim!.step_key}
    `;

    const resumed = h.reenter();
    await executeRound(resumed);

    const after = await runs.listSteps(sql, h.runId);
    const invalidated = h.events.filter(
      (e): e is Extract<typeof e, { type: "step.invalidated" }> => e.type === "step.invalidated",
    );

    // The degraded proposal recomputes, and its refusal is a shape refusal.
    expect(after.find((s) => s.step_key === victim!.step_key)?.attempt).toBe(2);
    expect(invalidated.find((e) => e.stage === "PROPOSALS")).toMatchObject({
      unitId: victim!.unit_id,
      kind: "shape",
    });

    // Exactly one refusal of that kind: the one this test caused. Other steps
    // may still recompute, and legitimately without an event — a recomputed
    // proposal gets a fresh artifact id, a synthesis citing the old one is
    // refused (the case forced deterministically below), and the watcher then
    // re-runs because it hashes the synthesis, which is the pre-existing
    // stale-input-hash path and emits nothing. Which of those fire depends on
    // what this seed's synthesis cited, so this test asserts only its own
    // refusal; the invariant wiring is pinned in the next one.
    expect(invalidated.filter((e) => e.kind === "shape")).toHaveLength(1);
    expect(h.simulator.callCount).toBeGreaterThan(afterFirst);
  });

  it("recomputes a replayed synthesis whose citations no longer resolve", async () => {
    const h = await makeHarness(sql);
    await executeRound(h.ctx);
    const afterFirst = h.simulator.callCount;

    const steps = await runs.listSteps(sql, h.runId);
    const synthesis = steps.find((s) => s.stage === "SYNTHESIS");
    expect(synthesis).toBeDefined();

    // Force a citation to an artifact this run does not contain, leaving
    // `input_hash` untouched so the step still replays. This stands in for the
    // production case rather than reproducing it: there, an upstream step
    // re-executes and `randomIds` gives it an id the stored synthesis cannot
    // know. Forcing the citation makes the test independent of which artifacts
    // this seed's synthesis happened to cite.
    await sql`
      UPDATE run_steps
      SET output = jsonb_set(output, '{synthesis,highConfidence}', ${sql.json([
        {
          text: "a claim resting on an artifact that is gone",
          confidence: 0.9,
          sources: [{ kind: "proposal", artifactId: "art_not_in_this_run" }],
        },
      ] as never)})
      WHERE run_id = ${h.runId} AND step_key = ${synthesis!.step_key}
    `;

    await executeRound(h.reenter());

    const after = await runs.listSteps(sql, h.runId);
    expect(after.find((s) => s.step_key === synthesis!.step_key)?.attempt).toBe(2);
    expect(h.simulator.callCount).toBeGreaterThan(afterFirst);

    const invalidated = h.events.filter(
      (e): e is Extract<typeof e, { type: "step.invalidated" }> => e.type === "step.invalidated",
    );
    expect(invalidated).toHaveLength(1);
    expect(invalidated[0]).toMatchObject({ stage: "SYNTHESIS", kind: "invariant" });
    // Named as a citation problem, not a shape one — the distinction the `kind`
    // field exists to carry.
    expect(invalidated[0]?.reason).toContain("art_not_in_this_run");

    // And the recomputed synthesis is clean: its citations resolve.
    const row = await runs.getStep(sql, h.runId, synthesis!.step_key);
    const stored = StoredSynthesisSchema.parse(row?.output);
    const allowed = new Set(
      (await runs.listArtifacts(sql, h.runId)).map((a) => a.id),
    );
    for (const claim of stored.synthesis.highConfidence) {
      for (const source of claim.sources) expect(allowed.has(source.artifactId)).toBe(true);
    }
  });
});

describe("concurrent callers in one process", () => {
  it("does not let a second caller steal a live claim", async () => {
    const h = await makeHarness(sql);
    const input = { probe: "same-process-race" };
    const key = await journalRow(h.runId, "SYNTHESIS", input, storedSynthesis());
    await sql`
      UPDATE run_steps SET output = output #- '{synthesis,summary}'
      WHERE run_id = ${h.runId} AND step_key = ${key}
    `;

    // Two resumes of one run in one process — two tabs on the stream route,
    // which only refuses a COMPLETED or FAILED run. Both see the unreadable
    // row, both refuse it, one wins `invalidateStep`. The loser must wait for
    // the winner, not execute alongside it: the journal's whole promise is
    // that a model call happens once.
    let ran = 0;
    const call = () =>
      durableStep(
        // No explicit ownerToken — exactly how every stage calls it.
        { sql, runId: h.runId, iteration: 0 },
        { stage: "SYNTHESIS", input, output: StoredSynthesisSchema },
        async () => {
          ran += 1;
          await new Promise((r) => setTimeout(r, 50));
          return storedSynthesis();
        },
      );

    const [a, b] = await Promise.all([call(), call()]);

    expect(ran).toBe(1);
    expect(a.value.synthesis.summary).toBe(b.value.synthesis.summary);
    const row = await runs.getStep(sql, h.runId, key);
    expect(row?.attempt).toBe(2);
  });

  it("does not let two callers both execute a fresh step", async () => {
    const h = await makeHarness(sql);
    const input = { probe: "fresh-race" };

    // The same hazard without any refusal involved, so it is clear this is the
    // lease's own guarantee and not something the replay path introduced:
    // `journal.test.ts` pins "exactly one worker" using distinct tokens, which
    // never exercised two calls inside one process.
    let ran = 0;
    const call = () =>
      durableStep(
        { sql, runId: h.runId, iteration: 0 },
        { stage: "SYNTHESIS", input, output: StoredSynthesisSchema },
        async () => {
          ran += 1;
          await new Promise((r) => setTimeout(r, 50));
          return storedSynthesis();
        },
      );

    await Promise.all([call(), call()]);
    expect(ran).toBe(1);
  });
});

describe("run-relative invariants, not just shape", () => {
  /** A stored value that parses but will be refused by validateReplay. */
  const refuseAlways = () => "the stored value no longer holds against this run";

  it("recomputes a value that parses but no longer holds", async () => {
    const h = await makeHarness(sql);
    const input = { probe: "invariant-refused" };
    const key = await journalRow(h.runId, "SYNTHESIS", input, storedSynthesis());

    const rejections: Array<{ kind: string; reason: string }> = [];
    let ran = 0;
    const step = await durableStep(
      journalCtxFor(h.runId, (r) => void rejections.push({ kind: r.kind, reason: r.reason })),
      {
        stage: "SYNTHESIS",
        input,
        output: StoredSynthesisSchema,
        // Refuses the stored row; the recomputed one is never shown to it,
        // because the hook does not run on fresh output.
        validateReplay: () => (ran === 0 ? refuseAlways() : undefined),
      },
      async () => {
        ran += 1;
        return storedSynthesis();
      },
    );

    expect(ran).toBe(1);
    expect(step.replayed).toBe(false);
    expect(step.revalidation?.kind).toBe("invariant");
    // An invariant rejection has no Zod issues to report — the distinction an
    // operator needs is which kind it was, so that is what the event carries.
    expect(step.revalidation?.issues).toEqual([]);
    expect(rejections).toEqual([{ kind: "invariant", reason: refuseAlways() }]);

    const row = await runs.getStep(sql, h.runId, key);
    expect(row?.attempt).toBe(2);
    expect(row?.status).toBe("COMPLETED");
  });

  it("does not run against freshly executed output", async () => {
    const h = await makeHarness(sql);
    const input = { probe: "invariant-fresh" };

    // The point of replay-only, and the reason this test exists: the stage that
    // produces a value checks these invariants itself and can re-prompt the
    // model when they fail. Running the hook here too would convert that
    // recoverable failure into a dead step, so a hook that refuses everything
    // must still let a fresh value through.
    let ran = 0;
    const step = await durableStep(
      journalCtxFor(h.runId),
      {
        stage: "SYNTHESIS",
        input,
        output: StoredSynthesisSchema,
        validateReplay: refuseAlways,
      },
      async () => {
        ran += 1;
        return storedSynthesis();
      },
    );

    expect(ran).toBe(1);
    expect(step.replayed).toBe(false);
    expect(step.revalidation).toBeUndefined();
    expect(step.value.synthesis.summary).toContain("replicates");
  });

  it("stays bounded when the stored value can never satisfy the invariant", async () => {
    const h = await makeHarness(sql);
    const input = { probe: "invariant-unsatisfiable" };
    await journalRow(h.runId, "SYNTHESIS", input, storedSynthesis());

    // Refused on replay, recomputed, and the recomputed value is stored — then
    // a *second* resume refuses it again. Each call spends one execution at
    // most, which is what keeps a permanently-violated invariant from becoming
    // a recompute loop that bills on every pass.
    let ran = 0;
    const call = () =>
      durableStep(
        journalCtxFor(h.runId),
        {
          stage: "SYNTHESIS",
          input,
          output: StoredSynthesisSchema,
          validateReplay: refuseAlways,
        },
        async () => {
          ran += 1;
          return storedSynthesis();
        },
      );

    await call();
    expect(ran).toBe(1);
    await call();
    expect(ran).toBe(2);
  });
});
