import { describe, it, expect } from "vitest";
import { scoreDisagreement } from "../src/scoring.js";
import { computeDisagreement, FATAL_DISAGREEMENT_FLOOR } from "@meta/runtime";

/**
 * `disagreementPreserved` is 20% of the default score, and since the assessor
 * landed that score decides which architecture gets promoted. These cases pin
 * down what it rewards — and, in the last block, why it deliberately still
 * ignores the severity that contested claims now carry.
 */

describe("scoreDisagreement", () => {
  it("rewards a report proportional to the disagreement that occurred", () => {
    // Measured 0.5 against 1 contested of 2 total: exactly proportional.
    expect(scoreDisagreement(0.5, 1, 1)).toBeCloseTo(1, 5);
  });

  it("penalizes flattening real disagreement away", () => {
    expect(scoreDisagreement(0.75, 0, 9)).toBeCloseTo(0.25, 5);
  });

  it("penalizes manufacturing disagreement that did not occur", () => {
    // Everything contested, nothing settled, against a near-unanimous round.
    expect(scoreDisagreement(0.1, 5, 0)).toBeCloseTo(0.1, 5);
  });

  it("treats a synthesis with nothing in it as agreement only when the round agreed", () => {
    expect(scoreDisagreement(0.1, 0, 0)).toBe(1);
    expect(scoreDisagreement(0.9, 0, 0)).toBe(0);
  });

  it("is bounded to [0,1]", () => {
    for (const measured of [0, 0.25, 0.5, 0.75, 1]) {
      for (const contested of [0, 1, 5, 40]) {
        for (const claims of [0, 1, 5, 40]) {
          const score = scoreDisagreement(measured, contested, claims);
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

/**
 * Severity-weighting the reported side was implemented, reviewed, and reverted.
 * These record the two failures concretely, because the next person to look at
 * the count-based ratio will have the same idea and deserves to know how it
 * went rather than rediscovering it in a promotion decision.
 */
describe("why the reported side is not severity-weighted", () => {
  const challenge = (agreementScore: number, severity: "minor" | "substantive" | "fatal") => ({
    targetAgentId: "a",
    agreementScore,
    concessions: [],
    objections: [{ targetClaimId: "c", objection: "o", severity, reasoning: "r" }],
  });

  it("measures a lone fatal objection as small once averaged over many challenges", () => {
    // The measured side floors the *one* fatal challenge, then divides by ten.
    // Any reported figure floored at 0.75 for the synthesis as a whole is being
    // compared against this — which is what produced an inverted score.
    const measured = computeDisagreement([
      challenge(1, "fatal"),
      ...Array.from({ length: 9 }, () => challenge(1, "minor")),
    ]);

    expect(measured).toBeCloseTo(FATAL_DISAGREEMENT_FLOOR / 10, 5);
    expect(measured).toBeLessThan(0.1);
  });

  it("distinguishes fatal from not, and nothing else", () => {
    // minor and substantive both fall through to agreementScore, so weighting
    // them apart on the reported side alone is a lever with no counterweight.
    const minor = computeDisagreement([challenge(0.8, "minor")]);
    const substantive = computeDisagreement([challenge(0.8, "substantive")]);
    const fatal = computeDisagreement([challenge(0.8, "fatal")]);

    expect(minor).toBe(substantive);
    expect(fatal).toBeGreaterThan(substantive);
  });
});
