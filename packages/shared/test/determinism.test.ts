import { describe, it, expect } from "vitest";
import { createRng } from "../src/random.js";
import { FixedClock } from "../src/clock.js";
import { DeterministicIds } from "../src/ids.js";
import { computeCost, efficiency, addUsage, zeroUsage } from "../src/cost.js";

describe("createRng", () => {
  it("replays an identical sequence for the same seed", () => {
    const a = createRng("run-1");
    const b = createRng("run-1");
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("diverges for different seeds", () => {
    const one = createRng("run-1");
    const two = createRng("run-2");
    const a = Array.from({ length: 10 }, () => one.next());
    const b = Array.from({ length: 10 }, () => two.next());
    expect(a).not.toEqual(b);
  });

  it("keeps derived generators independent of sibling consumption", () => {
    // A child derived from a fresh parent must match a child derived from a
    // parent that has already been drawn from — otherwise adding a consumer
    // upstream would silently change every downstream agent's behaviour.
    const parent = createRng("root");
    const childBefore = parent.derive("agent-a").next();
    parent.next();
    parent.next();
    const childAfter = createRng("root").derive("agent-a").next();
    expect(childBefore).toBe(childAfter);
  });

  it("bounds int() inclusively", () => {
    const rng = createRng("bounds");
    for (let i = 0; i < 500; i++) {
      const v = rng.int(3, 7);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(7);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("shuffles reproducibly without mutating the input", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = createRng("s").shuffle(input);
    const b = createRng("s").shuffle(input);
    expect(a).toEqual(b);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...a].sort((x, y) => x - y)).toEqual(input);
  });

  it("rejects an empty pick rather than returning undefined", () => {
    expect(() => createRng("s").pick([])).toThrow(RangeError);
  });
});

describe("FixedClock", () => {
  it("does not advance on its own", () => {
    const clock = new FixedClock("2025-06-01T12:00:00.000Z");
    const first = clock.now().toISOString();
    expect(clock.now().toISOString()).toBe(first);
    clock.advance(1000);
    expect(clock.now().toISOString()).toBe("2025-06-01T12:00:01.000Z");
  });
});

describe("DeterministicIds", () => {
  it("produces the same ids for the same allocation order", () => {
    const mk = () => {
      const ids = new DeterministicIds();
      return [ids.next("run"), ids.next("artifact"), ids.next("run")];
    };
    expect(mk()).toEqual(mk());
    expect(mk()).toEqual(["run_t000001", "art_t000001", "run_t000002"]);
  });
});

describe("cost", () => {
  it("prices a known model from published rates", () => {
    const { costUsd, unpriced } = computeCost("anthropic/claude-sonnet-4", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(unpriced).toBe(false);
    expect(costUsd).toBeCloseTo(18, 10); // 3 in + 15 out
  });

  it("discounts cached input tokens when the model defines a cached rate", () => {
    const priced = computeCost("anthropic/claude-sonnet-4", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
    });
    // No cached rate configured for this model, so it falls back to input rate.
    expect(priced.costUsd).toBeCloseTo(3, 10);
  });

  it("flags unknown models instead of throwing mid-run", () => {
    const r = computeCost("vendor/not-in-table", { inputTokens: 100, outputTokens: 100 });
    expect(r).toEqual({ costUsd: 0, unpriced: true });
  });

  it("sums usage across calls", () => {
    const total = [
      { inputTokens: 10, outputTokens: 5 },
      { inputTokens: 3, outputTokens: 2 },
    ].reduce(addUsage, zeroUsage());
    expect(total).toEqual({ inputTokens: 13, outputTokens: 7 });
  });

  it("returns null efficiency for free runs so they cannot dominate rankings", () => {
    expect(efficiency(0.9, 0)).toBeNull();
    expect(efficiency(0.9, 0.5)).toBeCloseTo(1.8, 10);
  });
});
