import { describe, it, expect } from "vitest";
import { bootstrapPairedDelta, describePairedDelta } from "../src/significance.js";

/**
 * The promotion rule's whole job is to distinguish a real improvement from a
 * lucky sample, so these tests are mostly about what it *refuses* to claim.
 */

describe("bootstrapPairedDelta", () => {
  it("detects a consistent win: the interval clears zero", () => {
    const champion = [0.50, 0.52, 0.48, 0.51, 0.49, 0.50, 0.53, 0.47];
    const candidate = [0.70, 0.72, 0.68, 0.71, 0.69, 0.70, 0.73, 0.67];

    const delta = bootstrapPairedDelta(champion, candidate, { seed: "win" });

    expect(delta.meanDelta).toBeCloseTo(0.2, 3);
    expect(delta.includesZero).toBe(false);
    expect(delta.low).toBeGreaterThan(0);
    expect(delta.n).toBe(8);
  });

  it("detects a consistent loss: the interval clears zero downward", () => {
    const champion = [0.70, 0.72, 0.68, 0.71, 0.69, 0.70, 0.73, 0.67];
    const candidate = [0.50, 0.52, 0.48, 0.51, 0.49, 0.50, 0.53, 0.47];

    const delta = bootstrapPairedDelta(champion, candidate, { seed: "loss" });

    expect(delta.meanDelta).toBeLessThan(0);
    expect(delta.includesZero).toBe(false);
    expect(delta.high).toBeLessThan(0);
  });

  it("declines to call noise an improvement", () => {
    // The candidate wins on average, but the per-task differences swing either
    // way by far more than the mean. This is the case the old fixed-epsilon
    // rule promoted and this rule must not.
    const champion = [0.50, 0.80, 0.30, 0.65, 0.45, 0.70, 0.35, 0.60];
    const candidate = [0.72, 0.55, 0.58, 0.40, 0.68, 0.44, 0.61, 0.51];

    const delta = bootstrapPairedDelta(champion, candidate, { seed: "noise" });

    expect(delta.includesZero).toBe(true);
    expect(delta.low).toBeLessThanOrEqual(0);
    expect(delta.high).toBeGreaterThanOrEqual(0);
  });

  it("treats identical scores as no difference", () => {
    const scores = [0.4, 0.5, 0.6, 0.7, 0.8];
    const delta = bootstrapPairedDelta(scores, scores, { seed: "same" });

    expect(delta.meanDelta).toBe(0);
    expect(delta.includesZero).toBe(true);
  });

  it("refuses to test fewer than three pairs", () => {
    // Two pairs cannot support an interval; any bound would be an artifact of
    // resampling almost nothing.
    const delta = bootstrapPairedDelta([0.1, 0.2], [0.9, 0.95], { seed: "tiny" });

    expect(delta.n).toBe(2);
    expect(delta.includesZero).toBe(true);
    expect(delta.meanDelta).toBeGreaterThan(0);
    expect(describePairedDelta(delta)).toContain("too few to test");
  });

  it("handles an empty comparison without dividing by zero", () => {
    const delta = bootstrapPairedDelta([], [], { seed: "empty" });

    expect(delta.n).toBe(0);
    expect(delta.meanDelta).toBe(0);
    expect(delta.includesZero).toBe(true);
  });

  it("is reproducible for the same seed", () => {
    const champion = [0.5, 0.55, 0.45, 0.6, 0.5, 0.52];
    const candidate = [0.6, 0.5, 0.7, 0.55, 0.62, 0.48];

    const a = bootstrapPairedDelta(champion, candidate, { seed: "fixed" });
    const b = bootstrapPairedDelta(champion, candidate, { seed: "fixed" });

    // A promotion decision that replayed differently would undo the point of a
    // reproducible runtime.
    expect(a).toEqual(b);
  });

  it("rejects mismatched input lengths rather than silently truncating", () => {
    expect(() => bootstrapPairedDelta([0.1, 0.2], [0.3])).toThrow(/equal-length/);
  });

  it("is sensitive to sample size: the same effect clears zero with more tasks", () => {
    // A small consistent edge, measured on four tasks and then on sixteen. The
    // effect is identical; only the evidence differs. This is the argument for
    // the twelve-task suite.
    const pattern = [0.02, 0.03, 0.01, 0.04];
    const small = pattern;
    const large = [...pattern, ...pattern, ...pattern, ...pattern];

    const toPair = (deltas: number[]) => ({
      champion: deltas.map(() => 0.5),
      candidate: deltas.map((d) => 0.5 + d),
    });

    const s = toPair(small);
    const l = toPair(large);

    const narrow = bootstrapPairedDelta(s.champion, s.candidate, { seed: "n" });
    const wide = bootstrapPairedDelta(l.champion, l.candidate, { seed: "n" });

    expect(narrow.meanDelta).toBeCloseTo(wide.meanDelta, 4);
    expect(wide.high - wide.low).toBeLessThan(narrow.high - narrow.low);
  });
});

describe("describePairedDelta", () => {
  it("says plainly when the suite cannot tell two genomes apart", () => {
    const scores = [0.4, 0.5, 0.6, 0.7];
    const delta = bootstrapPairedDelta(scores, scores, { seed: "flat" });

    expect(describePairedDelta(delta)).toContain("indistinguishable from no difference");
  });

  it("names the winner when the interval clears zero", () => {
    const champion = [0.3, 0.32, 0.28, 0.31, 0.29, 0.30];
    const candidate = [0.8, 0.82, 0.78, 0.81, 0.79, 0.80];
    const delta = bootstrapPairedDelta(champion, candidate, { seed: "clear" });

    expect(describePairedDelta(delta)).toContain("candidate better");
    expect(describePairedDelta(delta)).toContain("95% CI");
  });
});
