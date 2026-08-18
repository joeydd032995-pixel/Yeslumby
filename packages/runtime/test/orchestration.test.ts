import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runs, type Sql } from "@meta/db";
import { SimulatorProvider } from "@meta/gateway";
import { parseGenome, BALANCED_ANALYSIS } from "@meta/genome";
import { RunPaused, StopCriterionError, contentHash } from "@meta/shared";
import { executeRound, shouldContinue } from "../src/machine.js";
import { computeDisagreement } from "../src/stages/challenges.js";
import { checkDisagreementPreserved } from "../src/stages/synthesis.js";
import { filterPrivilegedMutations } from "../src/stages/watcher.js";
import { ensureSchema, makeHarness, testSql } from "./harness.js";

let sql: Sql;

beforeAll(async () => {
  sql = testSql();
  await ensureSchema(sql);
});

afterAll(async () => {
  await sql.end();
});

const PROPOSERS = ["empiricist", "systems-thinker", "skeptic"];

describe("proposal independence", () => {
  it("shows no agent any peer's proposal", async () => {
    const simulator = new SimulatorProvider();
    // Give each proposer a unique, unmistakable output.
    for (const id of PROPOSERS) {
      simulator.script(
        // Scoped to the proposal stage: `source=<id>` alone would also match
        // that agent's own challenge call, which expects a different contract.
        { systemContains: "You are answering alone", promptContains: `source=${id}` },
        {
          json: {
            summary: `SENTINEL-${id.toUpperCase()}-SUMMARY`,
            claims: [
              {
                id: `c-${id}`,
                text: `SENTINEL-${id.toUpperCase()}-CLAIM`,
                confidence: 0.6,
                evidence: ["observed"],
              },
            ],
            assumptions: [],
            openQuestions: [],
          },
        },
      );
    }

    const h = await makeHarness(sql, { simulator });
    await executeRound(h.ctx);

    const proposalCalls = h.simulator.calls.filter((c) =>
      c.system.includes("You are answering alone"),
    );
    expect(proposalCalls.length).toBe(PROPOSERS.length);

    for (const call of proposalCalls) {
      const self = PROPOSERS.find((id) => call.prompt.includes(`source=${id}`));
      expect(self).toBeDefined();

      for (const other of PROPOSERS) {
        if (other === self) continue;
        // The core anti-anchoring guarantee.
        expect(
          call.prompt,
          `${self}'s proposal prompt leaked ${other}'s output`,
        ).not.toContain(`SENTINEL-${other.toUpperCase()}`);
      }
    }
  });

  it("does show peer output at the challenge stage, once proposals are final", async () => {
    const simulator = new SimulatorProvider();
    simulator.script(
      { systemContains: "You are answering alone", promptContains: "source=empiricist" },
      {
        json: {
          summary: "SENTINEL-EMPIRICIST",
          claims: [{ id: "c1", text: "SENTINEL-EMPIRICIST-CLAIM", confidence: 0.7, evidence: ["e"] }],
          assumptions: [],
          openQuestions: [],
        },
      },
    );

    const h = await makeHarness(sql, { simulator });
    await executeRound(h.ctx);

    const challengeCalls = h.simulator.calls.filter((c) =>
      c.system.includes("Challenge the peer analysis"),
    );
    expect(challengeCalls.length).toBeGreaterThan(0);
    expect(challengeCalls.some((c) => c.prompt.includes("SENTINEL-EMPIRICIST"))).toBe(true);
  });
});

describe("edge-driven challenges", () => {
  it("fires exactly the genome's challenge edges and no others", async () => {
    const h = await makeHarness(sql);
    await executeRound(h.ctx);

    const expected = h.genome.edges
      .filter((e) => e.interaction === "challenge")
      .map((e) => `${e.from}->${e.to}`)
      .sort();

    const steps = await runs.listSteps(sql, h.runId);
    const fired = steps
      .filter((s) => s.stage === "CHALLENGES")
      .map((s) => s.unit_id)
      .sort();

    expect(fired).toEqual(expected);
  });

  it("skips the challenge stage entirely when the protocol disables it", async () => {
    const genome = parseGenome({
      ...structuredClone(BALANCED_ANALYSIS),
      protocols: { crossChallenge: false },
    });
    const h = await makeHarness(sql, { genome });
    const result = await executeRound(h.ctx);

    expect(result.challenges).toEqual([]);
    expect(result.disagreementLevel).toBe(0);
  });
});

/**
 * Replace generated identifiers with positional placeholders.
 *
 * Two runs cannot share artifact ids — they are primary keys, so identical ids
 * across concurrently existing runs are impossible by construction. Since
 * synthesis cites the artifacts it actually rests on, those ids appear in its
 * content. Reproducibility is therefore over *reasoning*, with identity
 * normalized out: the same relation as git, where two identical trees hash
 * alike while the commits pointing at them differ.
 */
function normalizeIds(value: unknown): unknown {
  const seen = new Map<string, string>();
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      if (!/^(art|run|gv|eco|mem)_/.test(node)) return node;
      if (!seen.has(node)) seen.set(node, `<id-${seen.size}>`);
      return seen.get(node);
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    }
    return node;
  };
  return walk(value);
}

describe("determinism", () => {
  it("produces identical reasoning for the same genome, seed, and objective", async () => {
    const seed = "fixed-seed-for-determinism";
    const objective = "Is the observed correlation causal?";

    const a = await makeHarness(sql, { seed, objective });
    const b = await makeHarness(sql, { seed, objective });

    const ra = await executeRound(a.ctx);
    const rb = await executeRound(b.ctx);

    expect(contentHash(normalizeIds(ra.synthesis))).toBe(
      contentHash(normalizeIds(rb.synthesis)),
    );
    expect(contentHash(ra.proposals.map((p) => p.proposal))).toBe(
      contentHash(rb.proposals.map((p) => p.proposal)),
    );
    expect(ra.disagreementLevel).toBe(rb.disagreementLevel);
    expect(ra.costUsd).toBe(rb.costUsd);
    expect(ra.usage).toEqual(rb.usage);
  });

  it("produces different results for a different seed", async () => {
    const objective = "Is the observed correlation causal?";
    const a = await makeHarness(sql, { seed: "seed-alpha", objective });
    const b = await makeHarness(sql, { seed: "seed-beta", objective });

    const ra = await executeRound(a.ctx);
    const rb = await executeRound(b.ctx);
    expect(contentHash(normalizeIds(ra.synthesis))).not.toBe(
      contentHash(normalizeIds(rb.synthesis)),
    );
  });

  it("cites only artifacts that exist in this run", async () => {
    const h = await makeHarness(sql, { seed: "provenance-seed" });
    const result = await executeRound(h.ctx);

    const real = new Set([
      ...result.proposals.map((p) => p.artifactId),
      ...result.challenges.map((c) => c.artifactId),
      ...result.falsifications.map((f) => f.artifactId),
    ]);

    const cited = [
      ...result.synthesis.highConfidence.flatMap((c) => c.sources),
      ...result.synthesis.workingHypotheses.flatMap((c) => c.sources),
      ...result.synthesis.contested.flatMap((c) => c.positions.flatMap((p) => p.sources)),
    ];

    // "Every claim is traceable" is only true if the citations resolve. The
    // schema restricts them to an enum of this run's artifacts, so a fabricated
    // reference cannot be generated in the first place.
    expect(cited.length).toBeGreaterThan(0);
    for (const source of cited) {
      expect(real.has(source.artifactId), `dangling citation ${source.artifactId}`).toBe(true);
    }
  });
});

describe("restartability", () => {
  it("resumes from the journal without repeating a single model call", async () => {
    const simulator = new SimulatorProvider();
    // Fail at synthesis, after context, proposals, challenges, and
    // falsification have all completed and been journaled.
    simulator.failNext({ systemContains: "Integrate the full argument graph" }, "crash", false);

    const h = await makeHarness(sql, { simulator });

    await expect(executeRound(h.ctx)).rejects.toThrow(/crash/);
    const callsBeforeCrash = simulator.callCount;
    expect(callsBeforeCrash).toBeGreaterThan(5);

    // A fresh context, as a new process would build.
    const resumed = h.reenter();
    const result = await executeRound(resumed);

    const callsAfterResume = simulator.callCount - callsBeforeCrash;
    const stagesReplayed = ["CONTEXT", "PROPOSALS", "CHALLENGES", "FALSIFICATION"];

    const steps = await runs.listSteps(sql, h.runId);
    for (const stage of stagesReplayed) {
      const stageSteps = steps.filter((s) => s.stage === stage);
      expect(stageSteps.length).toBeGreaterThan(0);
      // Attempt 1 means the step was never re-executed after the crash.
      for (const step of stageSteps) {
        expect(step.attempt, `${stage}/${step.unit_id} was re-executed`).toBe(1);
      }
    }

    // Only synthesis and watcher ran on resume.
    expect(callsAfterResume).toBeLessThanOrEqual(3);
    expect(result.synthesis).toBeDefined();
    expect(result.evaluation).toBeDefined();
  });

  it("replays a completed round entirely, making no calls at all", async () => {
    const h = await makeHarness(sql);
    await executeRound(h.ctx);
    const afterFirst = h.simulator.callCount;

    const again = await executeRound(h.reenter());

    expect(h.simulator.callCount).toBe(afterFirst);
    expect(again.fullyReplayed).toBe(true);
  });

  it("recomputes a step whose inputs changed, and only that step", async () => {
    const h = await makeHarness(sql);
    await executeRound(h.ctx);
    const baseline = h.simulator.callCount;

    // Same run, but the objective changed — every stage that reads it is stale.
    const mutated = h.reenter();
    mutated.run.objective = "A materially different question about a different effect.";
    await executeRound(mutated);

    expect(h.simulator.callCount).toBeGreaterThan(baseline);
  });
});

describe("human approval", () => {
  const gated = () =>
    parseGenome({ ...structuredClone(BALANCED_ANALYSIS), protocols: { humanApproval: "all" } });

  it("pauses before synthesis and records a pending approval", async () => {
    const h = await makeHarness(sql, { genome: gated() });

    await expect(executeRound(h.ctx)).rejects.toThrow(RunPaused);

    const run = await runs.getRun(sql, h.runId);
    expect(run?.status).toBe("AWAITING_APPROVAL");

    const approval = await runs.getApproval(sql, h.runId, 0, "HUMAN_APPROVAL");
    expect(approval?.status).toBe("PENDING");

    expect(h.events.some((e) => e.type === "run.paused")).toBe(true);
    // Synthesis must not have run.
    expect(
      h.simulator.calls.some((c) => c.system.includes("Integrate the full argument graph")),
    ).toBe(false);
  });

  it("resumes from the pause point once approved, repeating no earlier work", async () => {
    const h = await makeHarness(sql, { genome: gated() });
    await expect(executeRound(h.ctx)).rejects.toThrow(RunPaused);
    const callsBeforeApproval = h.simulator.callCount;

    const approval = await runs.getApproval(sql, h.runId, 0, "HUMAN_APPROVAL");
    await runs.decideApproval(sql, approval!.id, "APPROVED", null, "looks reasonable");

    const result = await executeRound(h.reenter());

    expect(result.synthesis).toBeDefined();
    // Only synthesis and watcher; everything before the gate replayed.
    expect(h.simulator.callCount - callsBeforeApproval).toBeLessThanOrEqual(3);
  });

  it("stops the run when a human rejects", async () => {
    const h = await makeHarness(sql, { genome: gated() });
    await expect(executeRound(h.ctx)).rejects.toThrow(RunPaused);

    const approval = await runs.getApproval(sql, h.runId, 0, "HUMAN_APPROVAL");
    await runs.decideApproval(sql, approval!.id, "REJECTED", null, "not worth the spend");

    await expect(executeRound(h.reenter())).rejects.toThrow(StopCriterionError);
  });

  it("does not pause when the genome only gates mutations", async () => {
    const h = await makeHarness(sql); // humanApproval defaults to "mutations"
    const result = await executeRound(h.ctx);
    expect(result.synthesis).toBeDefined();
  });
});

describe("disagreement preservation", () => {
  it("measures disagreement from challenge artifacts, not from the synthesizer", () => {
    expect(computeDisagreement([])).toBe(0);
    expect(
      computeDisagreement([
        { targetAgentId: "a", objections: [], concessions: [], agreementScore: 1 },
      ] as never),
    ).toBe(0);
    expect(
      computeDisagreement([
        { targetAgentId: "a", objections: [], concessions: [], agreementScore: 0.2 },
        { targetAgentId: "b", objections: [], concessions: [], agreementScore: 0.4 },
      ] as never),
    ).toBeCloseTo(0.7, 3);
  });

  it("treats a fatal objection as high disagreement regardless of the stated score", () => {
    // A challenger claiming 95% agreement while calling a claim fatally flawed
    // is reporting inconsistently; the objection is the stronger signal.
    const level = computeDisagreement([
      {
        targetAgentId: "a",
        objections: [
          { targetClaimId: "c1", objection: "circular", severity: "fatal", reasoning: "r" },
        ],
        concessions: [],
        agreementScore: 0.95,
      },
    ] as never);
    expect(level).toBeGreaterThanOrEqual(0.75);
  });

  it("rejects a synthesis that reports no contested claims despite real disagreement", () => {
    const flattened = {
      summary: "Everyone agreed.",
      highConfidence: [{ text: "X", confidence: 0.9, sources: [{ kind: "proposal", artifactId: "a" }] }],
      workingHypotheses: [],
      contested: [],
      unknowns: [],
      recommendedExperiments: [],
    };
    const correction = checkDisagreementPreserved(flattened as never, 0.8, 0.3);
    expect(correction).toBeDefined();
    expect(correction).toContain("must be preserved");
  });

  it("accepts an empty contested list when the organization genuinely agreed", () => {
    const agreed = {
      summary: "Converged.",
      highConfidence: [],
      workingHypotheses: [],
      contested: [],
      unknowns: [],
      recommendedExperiments: [],
    };
    expect(checkDisagreementPreserved(agreed as never, 0.1, 0.3)).toBeUndefined();
  });

  it("fails the stage when the synthesizer will not preserve disagreement", async () => {
    const simulator = new SimulatorProvider();
    // Every challenger fully rejects its target.
    simulator.script(
      { systemContains: "Challenge the peer analysis" },
      {
        json: {
          targetAgentId: "x",
          objections: [
            { targetClaimId: "c1", objection: "unsupported", severity: "fatal", reasoning: "r" },
          ],
          concessions: [],
          agreementScore: 0.05,
        },
      },
    );
    // And the synthesizer insists there is nothing contested.
    simulator.script(
      { systemContains: "Integrate the full argument graph" },
      {
        json: {
          summary: "All agents converged.",
          highConfidence: [],
          workingHypotheses: [],
          contested: [],
          unknowns: [],
          recommendedExperiments: [],
        },
      },
    );

    const h = await makeHarness(sql, { simulator });
    await expect(executeRound(h.ctx)).rejects.toThrow(/erased disagreement/);
  });
});

describe("watcher containment", () => {
  it("strips privilege-bearing mutations before they reach the mutation engine", () => {
    const evaluation = {
      scores: { overall: 0.7 },
      failureModes: [],
      suggestedMutations: [
        { type: "UPDATE_PROMPT", agentId: "skeptic", systemPrompt: "sharper" },
        { type: "UPDATE_CAPABILITIES", agentId: "skeptic", capabilities: ["code_execution"] },
        { type: "CHANGE_WATCHER", watcher: { enabled: false } },
      ],
      memoryRetention: { knowledge: [], structural: [] },
      recommendation: "mutate",
      rationale: "r",
    };

    const { kept, rejected } = filterPrivilegedMutations(evaluation as never);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.type).toBe("UPDATE_PROMPT");
    expect(rejected.map((r) => r.type).sort()).toEqual(["CHANGE_WATCHER", "UPDATE_CAPABILITIES"]);
  });

  it("reports the rejection through the round result", async () => {
    const simulator = new SimulatorProvider();
    simulator.script(
      { systemContains: "Evaluate this organization" },
      {
        json: {
          scores: { overall: 0.6 },
          failureModes: [],
          suggestedMutations: [
            { type: "UPDATE_CAPABILITIES", agentId: "skeptic", capabilities: ["file_write"] },
          ],
          memoryRetention: { knowledge: [], structural: [] },
          recommendation: "mutate",
          rationale: "wants more power",
        },
      },
    );

    const h = await makeHarness(sql, { simulator });
    const result = await executeRound(h.ctx);

    expect(result.evaluation?.suggestedMutations).toHaveLength(0);
    expect(result.rejectedMutations).toHaveLength(1);
    expect(result.rejectedMutations[0]?.type).toBe("UPDATE_CAPABILITIES");
  });
});

describe("stop criteria", () => {
  it("halts on the cost ceiling", async () => {
    const genome = parseGenome({
      ...structuredClone(BALANCED_ANALYSIS),
      stopCriteria: { maxCostUsd: 0.0000001 },
    });
    const h = await makeHarness(sql, { genome });
    await expect(executeRound(h.ctx)).rejects.toThrow(StopCriterionError);
  });

  /** The default genome declares maxRounds: 1, which would stop the loop before
   * any other criterion could apply. These cases need room to iterate. */
  const multiRound = () =>
    parseGenome({ ...structuredClone(BALANCED_ANALYSIS), protocols: { maxRounds: 3 } });

  it("stops iterating once the target score is reached", async () => {
    const h = await makeHarness(sql, { genome: multiRound() });
    const decision = shouldContinue(
      h.ctx,
      { evaluation: { scores: { overall: 0.95 } }, costUsd: 0 } as never,
      0,
    );
    expect(decision.continue).toBe(false);
    expect(decision.reason).toContain("target score");
  });

  it("stops when the watcher escalates to human review", async () => {
    const h = await makeHarness(sql, { genome: multiRound() });
    const decision = shouldContinue(
      h.ctx,
      { evaluation: { scores: { overall: 0.4 }, recommendation: "human_review" }, costUsd: 0 } as never,
      0,
    );
    expect(decision.continue).toBe(false);
  });

  it("respects the genome's own round limit even when iterations remain", async () => {
    // maxRounds (1) is tighter than maxIterations (3): the organization's
    // declared limit governs, so a low score cannot push it to another round.
    const h = await makeHarness(sql);
    const decision = shouldContinue(
      h.ctx,
      { evaluation: { scores: { overall: 0.1 }, recommendation: "continue" }, costUsd: 0 } as never,
      0,
    );
    expect(decision.continue).toBe(false);
    expect(decision.reason).toContain("maxRounds");
  });
});

describe("provenance", () => {
  it("links synthesis back to every artifact that fed it", async () => {
    const h = await makeHarness(sql);
    const result = await executeRound(h.ctx);

    const trace = await runs.traceProvenance(sql, result.synthesisArtifactId);
    const stages = new Set(trace.map((a) => a.stage));

    expect(stages.has("SYNTHESIS")).toBe(true);
    expect(stages.has("PROPOSALS")).toBe(true);
    expect(stages.has("CHALLENGES")).toBe(true);
    // Falsifications descend from proposals, so the walk reaches them too.
    expect(stages.has("FALSIFICATION")).toBe(true);
  });
});
