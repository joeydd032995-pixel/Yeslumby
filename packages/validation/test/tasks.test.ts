import { describe, it, expect } from "vitest";
import { TRAINING, HELD_OUT, ALL_TASKS } from "../src/tasks.js";

describe("task sets", () => {
  it("are disjoint", () => {
    // The single most important property: an architecture evolved on TRAINING
    // and measured on TRAINING will always appear to improve.
    const overlap = TRAINING.filter((t) => HELD_OUT.some((h) => h.id === t.id));
    expect(overlap).toEqual([]);
  });

  it("have unique ids", () => {
    const ids = ALL_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("have no overlapping objective text", () => {
    const objectives = ALL_TASKS.map((t) => t.objective);
    expect(new Set(objectives).size).toBe(objectives.length);
  });

  it("are large enough for the intervals to mean anything", () => {
    expect(HELD_OUT.length).toBeGreaterThanOrEqual(8);
  });
});
