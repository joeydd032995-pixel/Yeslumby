import { describe, it, expect } from "vitest";
import { rank, pearson, spearman, bootstrapCorrelation, wilson } from "../src/stats.js";

describe("rank", () => {
  it("ranks ascending, 1-based", () => {
    expect(rank([10, 30, 20])).toEqual([1, 3, 2]);
  });

  it("averages ties", () => {
    // Two values tied for ranks 2 and 3 both become 2.5.
    expect(rank([5, 7, 7, 9])).toEqual([1, 2.5, 2.5, 4]);
  });
});

describe("spearman", () => {
  it("is 1 for a perfectly monotone increasing relationship", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 10);
  });

  it("is 1 for a monotone but non-linear relationship", () => {
    // The point of using ranks: Pearson would not report 1 here.
    const xs = [1, 2, 3, 4];
    const ys = [1, 4, 9, 16];
    expect(spearman(xs, ys)).toBeCloseTo(1, 10);
    expect(pearson(xs, ys)!).toBeLessThan(1);
  });

  it("is -1 when reversed", () => {
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 10);
  });

  it("matches a worked example", () => {
    // Classic textbook pair: rho = 1 - 6*sum(d^2)/(n(n^2-1))
    //   ranks x: 1 2 3 4 5 ; ranks y: 2 1 4 3 5 ; d^2 = 1+1+1+1+0 = 4
    //   rho = 1 - 24/120 = 0.8
    const xs = [1, 2, 3, 4, 5];
    const ys = [20, 10, 40, 30, 50];
    expect(spearman(xs, ys)).toBeCloseTo(0.8, 10);
  });

  it("returns null without variance", () => {
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull();
  });
});

describe("bootstrapCorrelation", () => {
  it("reports a strong relationship as distinguishable from nothing", () => {
    const xs = Array.from({ length: 30 }, (_, i) => i);
    const ys = xs.map((x) => x + (x % 3));
    const ci = bootstrapCorrelation(xs, ys, { seed: 1 });
    expect(ci.estimate).toBeGreaterThan(0.9);
    expect(ci.includesZero).toBe(false);
  });

  it("reports noise as indistinguishable from no effect", () => {
    // The property that matters most: the harness must not manufacture a
    // finding from an evaluator that is actually uncorrelated with judgment.
    let s = 12345;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const xs = Array.from({ length: 20 }, () => rnd());
    const ys = Array.from({ length: 20 }, () => rnd());
    const ci = bootstrapCorrelation(xs, ys, { seed: 7 });
    expect(ci.includesZero).toBe(true);
  });

  it("is reproducible for the same data and seed", () => {
    const xs = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3];
    const ys = [2, 7, 1, 8, 2, 8, 1, 8, 2, 8];
    const a = bootstrapCorrelation(xs, ys, { seed: 42 });
    const b = bootstrapCorrelation(xs, ys, { seed: 42 });
    expect(a).toEqual(b);
  });
});

describe("wilson", () => {
  it("does not call a small clean sweep certain", () => {
    // 8/8 wins is suggestive, not proof; the interval must stay well below 1.
    const ci = wilson(8, 8);
    expect(ci.estimate).toBe(1);
    expect(ci.low).toBeLessThan(0.75);
    expect(ci.includesZero).toBe(false);
  });

  it("treats a coin flip as no effect", () => {
    const ci = wilson(10, 20);
    expect(ci.includesZero).toBe(true);
  });

  it("matches a known interval", () => {
    // Wilson 95% for 5/10 is approximately [0.237, 0.763].
    const ci = wilson(5, 10);
    expect(ci.low).toBeCloseTo(0.237, 2);
    expect(ci.high).toBeCloseTo(0.763, 2);
  });
});
