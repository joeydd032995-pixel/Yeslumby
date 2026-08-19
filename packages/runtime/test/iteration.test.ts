import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runs, type Sql } from "@meta/db";
import { SimulatorProvider } from "@meta/gateway";
import { parseGenome, BALANCED_ANALYSIS } from "@meta/genome";
import { runEcosystem, isStagnant, summarizeRound } from "../src/orchestrator.js";
import { ensureSchema, makeHarness, testSql } from "./harness.js";

let sql: Sql;

beforeAll(async () => {
  sql = testSql();
  await ensureSchema(sql);
});

afterAll(async () => {
  await sql.end();
});

/** The default genome caps itself at one round; these need room to iterate. */
const multiRound = (overrides: Record<string, unknown> = {}) =>
  parseGenome({
    ...structuredClone(BALANCED_ANALYSIS),
    protocols: { maxRounds: 3 },
    stopCriteria: { maxIterations: 3, targetScore: 0.99, ...overrides },
  });


/**
 * Pin the Watcher to "continue" with a low score.
 *
 * The simulator picks `recommendation` at random from its enum, and
 * `shouldContinue` halts on "stop" or "human_review" — so without this, whether
 * a second round happens is a coin flip. These tests are about the loop, not
 * about the Watcher's judgment, so the judgment is held fixed.
 */
function keepGoing(simulator: SimulatorProvider): SimulatorProvider {
  simulator.script(
    { systemContains: "Evaluate this organization" },
    {
      json: {
        scores: { overall: 0.4, diversity: 0.4, challengeQuality: 0.4 },
        failureModes: [
          { mode: "shallow evidence", evidence: "few sources cited", severity: "medium" },
        ],
        suggestedMutations: [],
        memoryRetention: { knowledge: [], structural: [] },
        recommendation: "continue",
        rationale: "more rounds should help",
      },
    },
  );
  return simulator;
}

describe("runEcosystem", () => {
  it("runs multiple rounds and records a trajectory", async () => {
    const h = await makeHarness(sql, {
      genome: multiRound(),
      simulator: keepGoing(new SimulatorProvider()),
    });
    const result = await runEcosystem(h.ctx);

    expect(result.trajectory.length).toBeGreaterThan(1);
    expect(result.trajectory.map((t) => t.iteration)).toEqual(
      result.trajectory.map((_, i) => i),
    );
    expect(result.final).toBeDefined();
    expect(result.stoppedBecause).toBeTruthy();
  });

  it("halts rather than looping without bound", async () => {
    // targetScore is unreachable and the watcher is pinned to "continue", so
    // only the iteration bound can end this.
    const h = await makeHarness(sql, {
      genome: multiRound(),
      simulator: keepGoing(new SimulatorProvider()),
    });
    const result = await runEcosystem(h.ctx);
    expect(result.trajectory.length).toBeLessThanOrEqual(3);
    expect(result.stoppedBecause).toMatch(/maxIterations|maxRounds|iteration cap|score|cost/i);
  });

  it("respects a caller-supplied iteration cap", async () => {
    const h = await makeHarness(sql, { genome: multiRound() });
    const result = await runEcosystem(h.ctx, { maxIterations: 1 });
    expect(result.trajectory).toHaveLength(1);
  });

  it("stops on cumulative cost even when no single round trips the ceiling", async () => {
    // Per-round cost sits under the ceiling; only the running total crosses it.
    const h = await makeHarness(sql, { genome: multiRound() });
    const oneRound = await runEcosystem(h.ctx, { maxIterations: 1 });

    const budget = oneRound.totalCostUsd * 1.5;
    const g = parseGenome({
      ...structuredClone(BALANCED_ANALYSIS),
      protocols: { maxRounds: 5 },
      stopCriteria: { maxIterations: 5, targetScore: 0.99, maxCostUsd: budget },
    });

    const h2 = await makeHarness(sql, {
      genome: g,
      simulator: keepGoing(new SimulatorProvider()),
    });
    const result = await runEcosystem(h2.ctx);

    expect(result.totalCostUsd).toBeGreaterThanOrEqual(budget);
    expect(result.stoppedBecause).toContain("cumulative cost");
    expect(result.trajectory.length).toBeLessThan(5);
  });

  it("marks the run COMPLETED with its trajectory", async () => {
    const h = await makeHarness(sql, { genome: multiRound() });
    await runEcosystem(h.ctx);

    const row = await runs.getRun(sql, h.runId);
    expect(row?.status).toBe("COMPLETED");
    const result = row?.result as { trajectory?: unknown[]; stoppedBecause?: string };
    expect(Array.isArray(result?.trajectory)).toBe(true);
    expect(result?.stoppedBecause).toBeTruthy();
  });

  it("marks the run FAILED when a round throws", async () => {
    const simulator = new SimulatorProvider();
    simulator.failNext({ systemContains: "Establish the shared framing" }, "boom", false);
    const h = await makeHarness(sql, { genome: multiRound(), simulator });

    await expect(runEcosystem(h.ctx)).rejects.toThrow(/boom/);
    const row = await runs.getRun(sql, h.runId);
    expect(row?.status).toBe("FAILED");
  });
});

describe("iteration journaling", () => {
  it("keeps each iteration's steps separate", async () => {
    const h = await makeHarness(sql, {
      genome: multiRound(),
      simulator: keepGoing(new SimulatorProvider()),
    });
    const result = await runEcosystem(h.ctx);

    const steps = await runs.listSteps(sql, h.runId);
    const iterations = new Set(steps.map((s) => s.iteration));
    expect(iterations.size).toBe(result.trajectory.length);
  });

  it("replays earlier iterations instead of re-running them after a crash", async () => {
    const simulator = keepGoing(new SimulatorProvider());
    const h = await makeHarness(sql, { genome: multiRound(), simulator });

    // Run one iteration cleanly and journal it, then re-enter asking for two.
    // Iteration 0 must come back from the journal rather than being recomputed.
    await runEcosystem(h.ctx, { maxIterations: 1, finalizeRun: false });
    const callsAfterFirst = simulator.callCount;
    const stepsAfterFirst = await runs.listSteps(sql, h.runId);
    expect(stepsAfterFirst.every((s) => s.attempt === 1)).toBe(true);

    // Now re-enter with room for two iterations. Iteration 0 must replay.
    const resumed = h.reenter();
    await runEcosystem(resumed, { maxIterations: 2 });

    const steps = await runs.listSteps(sql, h.runId);
    const firstIteration = steps.filter((s) => s.iteration === 0);
    expect(firstIteration.length).toBeGreaterThan(0);
    for (const step of firstIteration) {
      expect(step.attempt, `${step.stage}/${step.unit_id} re-ran`).toBe(1);
    }
    // Some new work happened (iteration 1), but iteration 0 cost nothing.
    expect(simulator.callCount).toBeGreaterThan(callsAfterFirst);
  });
});

describe("independence survives iteration", () => {
  it("carries the prior synthesis as shared framing, not as peer proposals", async () => {
    const simulator = new SimulatorProvider();
    const proposers = ["empiricist", "systems-thinker", "skeptic"];

    for (const id of proposers) {
      simulator.script(
        { systemContains: "You are answering alone", promptContains: `source=${id}` },
        {
          json: {
            summary: `MARK-${id.toUpperCase()}`,
            claims: [
              {
                id: `c-${id}`,
                text: `MARK-${id.toUpperCase()}-CLAIM`,
                confidence: 0.6,
                evidence: ["e"],
              },
            ],
            assumptions: [],
            openQuestions: [],
          },
        },
      );
    }

    const h = await makeHarness(sql, { genome: multiRound(), simulator: keepGoing(simulator) });
    const result = await runEcosystem(h.ctx, { maxIterations: 2 });
    expect(result.trajectory.length).toBe(2);

    const proposalCalls = simulator.calls.filter((c) =>
      c.system.includes("You are answering alone"),
    );
    // Two rounds of three proposers.
    expect(proposalCalls.length).toBe(6);

    for (const call of proposalCalls) {
      const self = proposers.find((id) => call.prompt.includes(`source=${id}`));
      for (const other of proposers) {
        if (other === self) continue;
        expect(
          call.prompt,
          `${self} saw ${other}'s proposal`,
        ).not.toContain(`MARK-${other.toUpperCase()}`);
      }
    }

    // And the second round's CONTEXT stage did receive the prior result.
    const contextCalls = simulator.calls.filter((c) =>
      c.system.includes("Re-establish the shared framing"),
    );
    expect(contextCalls.length).toBe(1);
    expect(contextCalls[0]!.prompt).toContain("kind=PEER_OUTPUT");
  });

  it("fences the prior round like any other untrusted content", async () => {
    const h = await makeHarness(sql, {
      genome: multiRound(),
      simulator: keepGoing(new SimulatorProvider()),
    });
    await runEcosystem(h.ctx, { maxIterations: 2 });

    const refinement = h.simulator.calls.filter((c) =>
      c.system.includes("Re-establish the shared framing"),
    );
    expect(refinement.length).toBeGreaterThan(0);
    for (const call of refinement) {
      const opens = (call.prompt.match(/<<<UNTRUSTED:[0-9a-f]{16}/g) ?? []).length;
      const closes = (call.prompt.match(/<<<END:[0-9a-f]{16}>>>/g) ?? []).length;
      expect(opens).toBe(closes);
      expect(opens).toBeGreaterThan(0);
    }
  });
});

describe("trajectory helpers", () => {
  it("summarizes a round into what the next needs", () => {
    const round = {
      synthesis: {
        summary: "s",
        contested: [{ question: "q1" }, { question: "q2" }],
        unknowns: ["u1"],
      },
      evaluation: { failureModes: [{ mode: "low diversity" }] },
    };
    const prior = summarizeRound(round as never, 0);
    expect(prior.iteration).toBe(0);
    expect(prior.contestedQuestions).toEqual(["q1", "q2"]);
    expect(prior.failureModes).toEqual(["low diversity"]);
  });

  it("detects stagnation only when later rounds fail to beat the first", () => {
    expect(isStagnant([{ score: 0.5 }, { score: 0.4 }] as never)).toBe(true);
    expect(isStagnant([{ score: 0.5 }, { score: 0.7 }] as never)).toBe(false);
    expect(isStagnant([{ score: 0.5 }] as never)).toBe(false);
    expect(isStagnant([{ score: null }, { score: null }] as never)).toBe(false);
  });
});
