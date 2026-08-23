import { describe, it, expect } from "vitest";
import { scoreDisagreement } from "../src/scoring.js";
import type { ClaimSeverity } from "@meta/runtime";

/**
 * `disagreementPreserved` is 20% of the default score, and since the assessor
 * landed that score decides which architecture gets promoted. These cases are
 * the specification for what it rewards.
 *
 * The dimension is deliberately two-sided: it penalizes erasing disagreement
 * that happened *and* manufacturing disagreement that did not. Rows 1-2 below
 * are the discrimination this was changed to add; rows 3-4 exist to prove the
 * two-sidedness survived the change.
 */

const contested = (...severities: ClaimSeverity[]) => severities.map((severity) => ({ severity }));

describe("scoreDisagreement", () => {
  it("rewards surfacing a fatal disagreement that actually occurred", () => {
    // Measured 0.75 is what computeDisagreement reports once any objection is
    // fatal. A synthesis that contests one claim and rates it fatal has
    // preserved exactly what happened, even though it is one claim among ten.
    expect(scoreDisagreement(0.75, contested("fatal"), 9)).toBeCloseTo(1, 3);
  });

  it("penalizes reporting a fatal disagreement as a minor one", () => {
    // Same count of contested claims as the case above — identical under the
    // old count-based ratio, which is the gap this closes.
    expect(scoreDisagreement(0.75, contested("minor"), 9)).toBeCloseTo(0.303, 3);
  });

  it("distinguishes severities that the old count-based ratio could not", () => {
    const fatal = scoreDisagreement(0.75, contested("fatal"), 9);
    const substantive = scoreDisagreement(0.75, contested("substantive"), 9);
    const minor = scoreDisagreement(0.75, contested("minor"), 9);

    // One contested claim in every case. Only the rating differs.
    expect(fatal).toBeGreaterThan(substantive);
    expect(substantive).toBeGreaterThan(minor);
  });

  it("penalizes manufacturing severity that did not occur", () => {
    // Measured disagreement is low, so rating a claim fatal overstates it.
    expect(scoreDisagreement(0.2, contested("fatal"), 9)).toBeCloseTo(0.45, 3);
  });

  it("rewards a proportionate report of mild disagreement", () => {
    expect(scoreDisagreement(0.2, contested("minor"), 9)).toBeCloseTo(0.853, 3);
  });

  it("still penalizes flattening disagreement away entirely", () => {
    // No contested claims at all against measured 0.75. This case is unchanged
    // by the severity work and must stay that way.
    expect(scoreDisagreement(0.75, [], 9)).toBeCloseTo(0.25, 3);
  });

  it("heavily penalizes contesting everything when nothing was contested", () => {
    expect(scoreDisagreement(0.1, contested("fatal", "fatal", "fatal"), 0)).toBeCloseTo(0.1, 3);
  });

  it("treats a synthesis with nothing in it as agreement", () => {
    // No claims and no contested items: only defensible when the challenge
    // stage also found nothing to disagree about.
    expect(scoreDisagreement(0.1, [], 0)).toBe(1);
    expect(scoreDisagreement(0.9, [], 0)).toBe(0);
  });

  it("is bounded to [0,1]", () => {
    for (const measured of [0, 0.25, 0.5, 0.75, 1]) {
      for (const claims of [0, 1, 5, 40]) {
        for (const severity of ["minor", "substantive", "fatal"] as ClaimSeverity[]) {
          const score = scoreDisagreement(measured, contested(severity), claims);
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
