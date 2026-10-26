import { describe, it, expect } from "vitest";
import {
  ContestedClaimSchema,
  ClaimSeveritySchema,
  ObjectionSchema,
  makeSynthesisSchema,
} from "../src/schemas.js";
import { computeDisagreement, FATAL_DISAGREEMENT_FLOOR } from "../src/stages/challenges.js";

/**
 * Severity is the one vocabulary shared by the two sides of the disagreement
 * comparison — objections measure it, contested claims report it, and
 * `scoreDisagreement` only means anything if they stay the same scale.
 */

const contested = {
  question: "Does the effect replicate?",
  positions: [
    { agentIds: ["a"], position: "yes", reasoning: "two direct replications", sources: [] },
    { agentIds: ["b"], position: "no", reasoning: "both underpowered", sources: [] },
  ],
  whyUnresolved: "no adequately powered replication exists",
  resolvingEvidence: "a preregistered replication at n=800",
};

describe("ClaimSeverity", () => {
  it("is the same scale for objections and contested claims", () => {
    // Not just equal today — literally the same schema. Two enums that happened
    // to match would let one drift and silently break the comparison.
    expect(ObjectionSchema.shape.severity).toBe(ClaimSeveritySchema);
    expect(ContestedClaimSchema.shape.severity.def.innerType).toBe(ClaimSeveritySchema);
  });

  it("rejects a severity outside the scale", () => {
    expect(ContestedClaimSchema.safeParse({ ...contested, severity: "catastrophic" }).success).toBe(
      false,
    );
  });
});

describe("ContestedClaimSchema.severity", () => {
  it("defaults to the neutral middle when absent", () => {
    const parsed = ContestedClaimSchema.parse(contested);
    expect(parsed.severity).toBe("substantive");
  });

  // The case this schema used to carry — "does not protect the journal replay
  // path, which never parses" — is gone, and deliberately not adapted. It
  // asserted a key was missing from a `structuredClone`d literal, so it never
  // exercised `durableStep` at all and would have kept passing while
  // documenting a falsehood. The behaviour it was about is now pinned against
  // a real journal row in `journal-replay.test.ts`.

  it("keeps an explicit severity", () => {
    expect(ContestedClaimSchema.parse({ ...contested, severity: "fatal" }).severity).toBe("fatal");
  });
});

describe("makeSynthesisSchema", () => {
  it("requires severity, so a live call cannot fall through to the default", () => {
    const schema = makeSynthesisSchema(["artifact_1"]);
    const synthesis = {
      summary: "s",
      highConfidence: [],
      workingHypotheses: [],
      contested: [contested],
      unknowns: [],
      recommendedExperiments: [],
    };

    expect(schema.safeParse(synthesis).success).toBe(false);
    expect(
      schema.safeParse({ ...synthesis, contested: [{ ...contested, severity: "minor" }] }).success,
    ).toBe(true);
  });
});

describe("FATAL_DISAGREEMENT_FLOOR", () => {
  it("is what computeDisagreement actually applies", () => {
    // A challenger claiming near-total agreement while raising a fatal
    // objection is reporting inconsistently; the fatal objection wins.
    const level = computeDisagreement([
      {
        targetAgentId: "a",
        agreementScore: 0.95,
        concessions: [],
        objections: [
          { targetClaimId: "c1", objection: "o", severity: "fatal", reasoning: "r" },
        ],
      },
    ]);

    expect(level).toBe(FATAL_DISAGREEMENT_FLOOR);
  });

  it("leaves a non-fatal challenge on its own agreement score", () => {
    const level = computeDisagreement([
      {
        targetAgentId: "a",
        agreementScore: 0.9,
        concessions: [],
        objections: [
          { targetClaimId: "c1", objection: "o", severity: "substantive", reasoning: "r" },
        ],
      },
    ]);

    expect(level).toBeCloseTo(0.1, 5);
  });
});
