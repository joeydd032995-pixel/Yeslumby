import { describe, it, expect } from "vitest";
import { blind, join, renderSheet, renderGradesTemplate } from "../src/blind.js";

interface Prov { condition: "evolved" | "baseline"; versionId: string }

const items = Array.from({ length: 12 }, (_, i) => ({
  provenance: {
    condition: (i % 2 === 0 ? "evolved" : "baseline") as Prov["condition"],
    versionId: `gv_${i}`,
  },
  content: `answer number ${i}`,
}));

describe("blinding", () => {
  it("never puts provenance on the sheet", () => {
    const set = blind(items, "seed-1");
    const sheet = renderSheet(set, "grade these");
    // The words that would give the game away must not appear anywhere.
    expect(sheet).not.toMatch(/evolved|baseline|gv_/);
    expect(JSON.stringify(set.entries)).not.toMatch(/evolved|baseline|gv_/);
  });

  it("does not order the sheet by condition", () => {
    const set = blind(items, "seed-1");
    const conditions = set.key.map((k) => k.provenance.condition);
    // The input alternates perfectly; a sheet that preserved input order would
    // let a grader infer condition from position alone.
    const alternating = conditions.every((c, i) =>
      i === 0 ? true : c !== conditions[i - 1],
    );
    expect(alternating).toBe(false);
  });

  it("does not derive ids from what they label", () => {
    // Two items with identical content but different provenance must not be
    // distinguishable, and identical provenance must not produce a stable id
    // across sets.
    const a = blind(items, "seed-1");
    const b = blind(items, "seed-2");
    expect(a.entries.map((e) => e.id)).not.toEqual(b.entries.map((e) => e.id));
  });

  it("is reproducible for the same seed", () => {
    expect(blind(items, "same")).toEqual(blind(items, "same"));
  });

  it("joins grades back to provenance", () => {
    const set = blind(items, "seed-1");
    const grades = Object.fromEntries(set.entries.map((e, i) => [e.id, i / 11]));
    const { graded, missing, unknown } = join(set, grades);
    expect(graded).toHaveLength(12);
    expect(missing).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it("reports skipped and unrecognised ids rather than dropping them", () => {
    const set = blind(items, "seed-1");
    const grades: Record<string, number | null> = { "deadbeef00": 1 };
    for (const e of set.entries.slice(0, 5)) grades[e.id] = 0.5;
    const { graded, missing, unknown } = join(set, grades);
    expect(graded).toHaveLength(5);
    expect(missing).toHaveLength(7);
    expect(unknown).toEqual(["deadbeef00"]);
  });

  it("emits a template with an entry per item", () => {
    const set = blind(items, "seed-1");
    const template = JSON.parse(renderGradesTemplate(set)) as Record<string, null>;
    expect(Object.keys(template)).toHaveLength(12);
    expect(Object.values(template).every((v) => v === null)).toBe(true);
  });
});
