import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ModelCallError, FixedClock } from "@meta/shared";
import { Gateway, SimulatorProvider, synthesize, topicWords } from "../src/index.js";
import type { ModelProvider, UsageSink } from "../src/index.js";

const noSleep = async () => {};

function makeGateway(provider: ModelProvider, sink?: UsageSink) {
  return new Gateway({
    providers: [provider],
    ...(sink ? { usageSink: sink } : {}),
    sleep: noSleep,
    clock: new FixedClock(),
  });
}

const baseRequest = {
  modelId: "anthropic/claude-sonnet-4",
  system: "SYSTEM POLICY",
  prompt: "Assess whether the reported effect replicates.",
  temperature: 0.7,
  maxOutputTokens: 1024,
  seed: "run-1:PROPOSALS:skeptic",
};

describe("determinism", () => {
  it("returns byte-identical output for the same seed", async () => {
    const a = await makeGateway(new SimulatorProvider()).generate(baseRequest);
    const b = await makeGateway(new SimulatorProvider()).generate(baseRequest);
    expect(a.text).toBe(b.text);
    expect(a.usage).toEqual(b.usage);
  });

  it("returns different output for different seeds", async () => {
    const gw = makeGateway(new SimulatorProvider());
    const a = await gw.generate({ ...baseRequest, seed: "run-1:PROPOSALS:skeptic" });
    const b = await gw.generate({ ...baseRequest, seed: "run-1:PROPOSALS:empiricist" });
    expect(a.text).not.toBe(b.text);
  });

  it("satisfies a supplied JSON schema", async () => {
    const Schema = z.object({
      claims: z.array(z.object({ text: z.string(), confidence: z.number().min(0).max(1) })).min(1),
      verdict: z.enum(["supported", "contested", "refuted"]),
    });

    const result = await makeGateway(new SimulatorProvider()).generate({
      ...baseRequest,
      jsonSchema: z.toJSONSchema(Schema) as never,
    });

    // The point: an arbitrary stage schema is satisfied without hand-written
    // fixtures, so stages can evolve their output shape freely.
    const parsed = Schema.safeParse(result.json);
    expect(parsed.success, JSON.stringify(result.json)).toBe(true);
    if (parsed.success) {
      expect(parsed.data.claims.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("satisfies nested and optional schema shapes", async () => {
    const Schema = z.object({
      contested: z
        .array(
          z.object({
            claim: z.string(),
            positions: z
              .array(z.object({ agentId: z.string(), reason: z.string() }))
              .min(2),
          }),
        )
        .min(1),
      unknowns: z.array(z.string()),
      note: z.string().optional(),
    });

    const result = await makeGateway(new SimulatorProvider()).generate({
      ...baseRequest,
      jsonSchema: z.toJSONSchema(Schema) as never,
    });

    const parsed = Schema.safeParse(result.json);
    expect(parsed.success, JSON.stringify(result.json, null, 1)).toBe(true);
    if (parsed.success) {
      // minItems on a nested array must be honoured, or the disagreement-
      // preservation checks downstream would be testing nothing.
      for (const c of parsed.data.contested) {
        expect(c.positions.length).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

describe("cost accounting", () => {
  it("prices against the requested model, so genome cost differences are real", async () => {
    const gw = makeGateway(new SimulatorProvider());
    const opus = await gw.generate({ ...baseRequest, modelId: "anthropic/claude-opus-4" });
    const haiku = await gw.generate({ ...baseRequest, modelId: "anthropic/claude-haiku-4" });

    expect(opus.costUsd).toBeGreaterThan(haiku.costUsd);
    expect(opus.unpriced).toBe(false);
  });

  it("flags an unpriced model without failing the call", async () => {
    const result = await makeGateway(new SimulatorProvider()).generate({
      ...baseRequest,
      modelId: "newvendor/experimental",
    });
    expect(result.unpriced).toBe(true);
    expect(result.costUsd).toBe(0);
    expect(result.text.length).toBeGreaterThan(0);
  });

  it("prefers a provider-reported cost over the static table", async () => {
    const reporting: ModelProvider = {
      name: "reporting",
      supports: () => true,
      generate: async () => ({
        text: "answer",
        usage: { inputTokens: 10, outputTokens: 10 },
        finishReason: "stop",
        costUsd: 0.0042,
      }),
    };

    const result = await makeGateway(reporting).generate({
      ...baseRequest,
      modelId: "anthropic/claude-opus-4", // has a MODEL_PRICING entry that would price differently
    });

    expect(result.costUsd).toBe(0.0042);
    expect(result.unpriced).toBe(false);
  });

  it("falls back to the static table when the provider reports no cost", async () => {
    const result = await makeGateway(new SimulatorProvider()).generate({
      ...baseRequest,
      modelId: "anthropic/claude-opus-4",
    });

    // SimulatorProvider never sets costUsd, so this exercises the static-table path.
    expect(result.unpriced).toBe(false);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("emits one usage record per successful call, with attribution", async () => {
    const records: unknown[] = [];
    const sink: UsageSink = { record: (e) => void records.push(e) };

    await makeGateway(new SimulatorProvider(), sink).generate({
      ...baseRequest,
      attribution: { runId: "run_1", agentId: "skeptic", stage: "PROPOSALS" },
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      modelId: "anthropic/claude-sonnet-4",
      provider: "simulator",
      attribution: { runId: "run_1", agentId: "skeptic", stage: "PROPOSALS" },
    });
  });

  it("records no usage for a failed call", async () => {
    const records: unknown[] = [];
    const provider = new SimulatorProvider();
    provider.failNext({}, "hard failure", false);

    await expect(
      makeGateway(provider, { record: (e) => void records.push(e) }).generate(baseRequest),
    ).rejects.toThrow(ModelCallError);
    expect(records).toHaveLength(0);
  });
});

describe("retry and failover", () => {
  it("retries a retryable failure on the same model", async () => {
    const provider = new SimulatorProvider();
    provider.failNext({}, "transient", true);

    const result = await makeGateway(provider).generate(baseRequest);
    expect(result.attempts).toBe(2);
    expect(result.fallbackUsed).toBe(false);
    expect(result.modelId).toBe("anthropic/claude-sonnet-4");
  });

  it("does not retry a non-retryable failure, moving to the fallback instead", async () => {
    const provider = new SimulatorProvider();
    provider.script({ modelId: "anthropic/claude-opus-4" }, {
      error: { message: "model unavailable", retryable: false },
    });

    const result = await makeGateway(provider).generate({
      ...baseRequest,
      modelId: "anthropic/claude-opus-4",
      fallbacks: ["anthropic/claude-sonnet-4"],
    });

    expect(result.modelId).toBe("anthropic/claude-sonnet-4");
    expect(result.fallbackUsed).toBe(true);
    // One attempt on the primary, one on the fallback — the non-retryable
    // failure must not have burned the primary's second attempt.
    expect(result.attempts).toBe(2);
  });

  it("prices a fallback against the model that actually served", async () => {
    const provider = new SimulatorProvider();
    provider.script({ modelId: "anthropic/claude-opus-4" }, {
      error: { message: "down", retryable: false },
    });

    const result = await makeGateway(provider).generate({
      ...baseRequest,
      modelId: "anthropic/claude-opus-4",
      fallbacks: ["anthropic/claude-haiku-4"],
    });

    const direct = await makeGateway(new SimulatorProvider()).generate({
      ...baseRequest,
      modelId: "anthropic/claude-haiku-4",
    });
    expect(result.costUsd).toBeCloseTo(direct.costUsd, 10);
  });

  it("throws the last error when every model in the chain fails", async () => {
    const provider = new SimulatorProvider();
    provider.script({}, { error: { message: "everything is down", retryable: false } });

    await expect(
      makeGateway(provider).generate({ ...baseRequest, fallbacks: ["anthropic/claude-haiku-4"] }),
    ).rejects.toThrow(/everything is down/);
  });

  it("backs off between retries", async () => {
    const sleep = vi.fn(async () => {});
    const provider = new SimulatorProvider();
    provider.failNext({}, "transient", true);

    await new Gateway({
      providers: [provider],
      sleep,
      backoffMs: 100,
      clock: new FixedClock(),
    }).generate(baseRequest);

    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("reports no provider for an unroutable model", async () => {
    const narrow: ModelProvider = {
      name: "narrow",
      supports: (id) => id === "openai/gpt-4o",
      generate: async () => {
        throw new Error("unreachable");
      },
    };
    await expect(makeGateway(narrow).generate(baseRequest)).rejects.toThrow(/no provider serves/);
  });
});

describe("structured output parsing", () => {
  it("extracts JSON from a fenced code block", async () => {
    const provider = new SimulatorProvider();
    provider.script({}, { text: '```json\n{"verdict":"supported"}\n```' });

    const result = await makeGateway(provider).generate({
      ...baseRequest,
      jsonSchema: { type: "object" },
    });
    expect(result.json).toEqual({ verdict: "supported" });
  });

  it("extracts JSON surrounded by prose", async () => {
    const provider = new SimulatorProvider();
    provider.script({}, { text: 'Here is my answer: {"verdict":"contested"} — hope that helps.' });

    const result = await makeGateway(provider).generate({
      ...baseRequest,
      jsonSchema: { type: "object" },
    });
    expect(result.json).toEqual({ verdict: "contested" });
  });

  it("treats unparseable structured output as retryable", async () => {
    const provider = new SimulatorProvider();
    // Fails both attempts, so the call surfaces the parse error.
    provider.script({}, { text: "I would rather explain in prose." });

    await expect(
      makeGateway(provider).generate({ ...baseRequest, jsonSchema: { type: "object" } }),
    ).rejects.toThrow(/parseable JSON/);
    // Two attempts means the gateway classified it retryable.
    expect(provider.callCount).toBe(2);
  });
});

describe("synth helpers", () => {
  it("derives topic words, dropping stopwords and short tokens", () => {
    const words = topicWords("What is the causal effect of the intervention on retention?");
    expect(words).toContain("causal");
    expect(words).toContain("intervention");
    expect(words).not.toContain("the");
    expect(words).not.toContain("is");
  });

  it("respects numeric bounds", () => {
    for (let i = 0; i < 50; i++) {
      const v = synthesize({ type: "number", minimum: 0, maximum: 1 }, `s${i}`, {
        topic: [],
        voice: "v",
      }) as number;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("picks only from an enum", () => {
    for (let i = 0; i < 25; i++) {
      const v = synthesize({ enum: ["a", "b", "c"] }, `s${i}`, { topic: [], voice: "v" });
      expect(["a", "b", "c"]).toContain(v);
    }
  });

  it("terminates on a self-referential schema", () => {
    const recursive = {
      type: "object",
      properties: { child: { $ref: "#/$defs/node" } },
      $defs: { node: { type: "object", properties: { child: { $ref: "#/$defs/node" } } } },
    };
    expect(() => synthesize(recursive, "s", { topic: [], voice: "v" })).not.toThrow();
  });
});
