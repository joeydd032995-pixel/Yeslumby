import { describe, it, expect } from "vitest";
import { makeSynthesisSchema, jsonSchemaFor } from "../src/schemas.js";

/**
 * `consensusThreshold` was declared on every genome, rendered in the UI, and
 * read by nothing at all. It now sets the floor on `confidence` for claims in
 * `highConfidence` — expressed in the per-call schema rather than checked after
 * the model answers, so a claim below the bar cannot be produced in the first
 * place, the same move that stops fabricated citations.
 *
 * The second case is the one that matters most: it fails if the threshold stops
 * being consulted, which is the assertion that was missing while the field was
 * dead.
 */

const ids = ["artifact_1"];
const claim = (confidence: number) => ({
  text: "the effect replicates",
  confidence,
  sources: [{ kind: "proposal", artifactId: "artifact_1" }],
});

const synthesis = (overrides: Record<string, unknown> = {}) => ({
  summary: "s",
  highConfidence: [],
  workingHypotheses: [],
  contested: [],
  unknowns: [],
  recommendedExperiments: [],
  ...overrides,
});

describe("consensusThreshold in the synthesis contract", () => {
  it("accepts a high-confidence claim that clears the bar", () => {
    const schema = makeSynthesisSchema(ids, 0.7);
    expect(schema.safeParse(synthesis({ highConfidence: [claim(0.9)] })).success).toBe(true);
  });

  it("rejects a high-confidence claim below the bar", () => {
    const schema = makeSynthesisSchema(ids, 0.7);
    expect(schema.safeParse(synthesis({ highConfidence: [claim(0.4)] })).success).toBe(false);
  });

  it("actually reads the threshold rather than applying a fixed bar", () => {
    // The same synthesis, judged by two genomes differing *only* in this field.
    // If the threshold were ignored both verdicts would match — which is
    // precisely the state the field sat in before.
    const s = synthesis({ highConfidence: [claim(0.6)] });

    expect(makeSynthesisSchema(ids, 0.5).safeParse(s).success).toBe(true);
    expect(makeSynthesisSchema(ids, 0.8).safeParse(s).success).toBe(false);
  });

  it("treats the bar as inclusive", () => {
    const schema = makeSynthesisSchema(ids, 0.7);
    expect(schema.safeParse(synthesis({ highConfidence: [claim(0.7)] })).success).toBe(true);
  });

  it("leaves workingHypotheses unconstrained", () => {
    // Gating both lists would leave a low-confidence claim with nowhere legal
    // to go and turn every cautious synthesis into a failure. Being unsure is
    // supposed to have somewhere to live.
    const schema = makeSynthesisSchema(ids, 0.9);
    expect(schema.safeParse(synthesis({ workingHypotheses: [claim(0.1)] })).success).toBe(true);
  });

  it("carries the bar into the JSON Schema the model is given", () => {
    // The point of putting this in the schema rather than in a post-hoc check:
    // the constraint has to reach the model, or it is only ever discovered
    // after a wasted call.
    interface ClaimList {
      items: { properties: { confidence: { minimum: number } } };
    }
    const json = jsonSchemaFor(makeSynthesisSchema(ids, 0.7)) as unknown as {
      properties: { highConfidence: ClaimList; workingHypotheses: ClaimList };
    };

    expect(json.properties.highConfidence.items.properties.confidence.minimum).toBe(0.7);
    expect(json.properties.workingHypotheses.items.properties.confidence.minimum).toBe(0);
  });

  it("defaults to no floor, so callers that do not care are unaffected", () => {
    expect(makeSynthesisSchema(ids).safeParse(synthesis({ highConfidence: [claim(0)] })).success)
      .toBe(true);
  });
});
