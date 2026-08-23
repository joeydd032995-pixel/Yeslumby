import { describe, it, expect, vi } from "vitest";
import { ModelCallError } from "@meta/shared";
import { OpenRouterProvider } from "../src/index.js";
import type { ProviderRequest } from "../src/index.js";

const baseRequest: ProviderRequest = {
  modelId: "anthropic/claude-sonnet-4",
  system: "SYSTEM POLICY",
  prompt: "Assess whether the reported effect replicates.",
  temperature: 0.7,
  maxOutputTokens: 1024,
  seed: "run-1:PROPOSALS:skeptic",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeProvider(fetchImpl: typeof fetch) {
  return new OpenRouterProvider({ apiKey: "test-key", fetchImpl });
}

describe("OpenRouterProvider", () => {
  it("constructs without a key when one is supplied via options", () => {
    expect(() => new OpenRouterProvider({ apiKey: "x", fetchImpl: vi.fn() })).not.toThrow();
  });

  it("throws when no API key is available", () => {
    const prevEnv = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect(() => new OpenRouterProvider({ fetchImpl: vi.fn() })).toThrow(/OPENROUTER_API_KEY/);
    } finally {
      if (prevEnv !== undefined) process.env.OPENROUTER_API_KEY = prevEnv;
    }
  });

  it("maps a successful completion", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        choices: [{ message: { content: "the effect likely replicates" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 42, completion_tokens: 17 },
      }),
    );

    const result = await makeProvider(fetchImpl as unknown as typeof fetch).generate(baseRequest);

    expect(result.text).toBe("the effect likely replicates");
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 17 });
    expect(result.finishReason).toBe("stop");
    expect(result.costUsd).toBeUndefined();
  });

  it("parses provider-reported cost when present", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        choices: [{ message: { content: "answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.00234 },
      }),
    );

    const result = await makeProvider(fetchImpl as unknown as typeof fetch).generate(baseRequest);
    expect(result.costUsd).toBe(0.00234);
  });

  it("leaves costUsd unset when the response has no cost field", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        choices: [{ message: { content: "answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );

    const result = await makeProvider(fetchImpl as unknown as typeof fetch).generate(baseRequest);
    expect(result.costUsd).toBeUndefined();
  });

  it("requests usage accounting so cost can be reported back", async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return jsonResponse(200, {
        choices: [{ message: { content: "answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });

    await makeProvider(fetchImpl as unknown as typeof fetch).generate(baseRequest);
    expect(sentBody.usage).toEqual({ include: true });
  });

  it("sends a JSON schema as response_format when requested", async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return jsonResponse(200, {
        choices: [{ message: { content: '{"verdict":"supported"}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });

    const result = await makeProvider(fetchImpl as unknown as typeof fetch).generate({
      ...baseRequest,
      jsonSchema: { type: "object" },
    });

    expect(sentBody.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "stage_output", strict: true, schema: { type: "object" } },
    });
    // Parsing structured output into `json` is the gateway's job, not the
    // provider's — matches AiGatewayProvider's behavior.
    expect(result.json).toBeUndefined();
  });

  it("includes optional attribution headers only when configured", async () => {
    let sentHeaders: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      sentHeaders = init.headers as Record<string, string>;
      return jsonResponse(200, {
        choices: [{ message: { content: "answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });

    await new OpenRouterProvider({
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      siteUrl: "https://example.com",
      appName: "meta-ecosystem",
    }).generate(baseRequest);

    expect(sentHeaders["HTTP-Referer"]).toBe("https://example.com");
    expect(sentHeaders["X-Title"]).toBe("meta-ecosystem");
  });

  it("omits attribution headers when not configured", async () => {
    let sentHeaders: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      sentHeaders = init.headers as Record<string, string>;
      return jsonResponse(200, {
        choices: [{ message: { content: "answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });

    await makeProvider(fetchImpl as unknown as typeof fetch).generate(baseRequest);
    expect(sentHeaders["HTTP-Referer"]).toBeUndefined();
    expect(sentHeaders["X-Title"]).toBeUndefined();
  });

  it("classifies a 500 as retryable", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: { message: "boom" } }));

    await expect(
      makeProvider(fetchImpl as unknown as typeof fetch).generate(baseRequest),
    ).rejects.toMatchObject({ retryable: true });
  });

  it("classifies a 429 as retryable", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, { error: { message: "rate limited" } }));

    await expect(
      makeProvider(fetchImpl as unknown as typeof fetch).generate(baseRequest),
    ).rejects.toMatchObject({ retryable: true });
  });

  it("classifies a 400 as non-retryable", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, { error: { message: "bad request" } }));

    await expect(
      makeProvider(fetchImpl as unknown as typeof fetch).generate(baseRequest),
    ).rejects.toMatchObject({ retryable: false });
  });

  it("classifies a 402 (insufficient credit) as non-retryable", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(402, { error: { message: "insufficient credit" } }));

    await expect(
      makeProvider(fetchImpl as unknown as typeof fetch).generate(baseRequest),
    ).rejects.toMatchObject({ retryable: false });
  });

  it("treats empty content as retryable", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        choices: [{ message: { content: "" }, finish_reason: "content_filter" }],
        usage: { prompt_tokens: 1, completion_tokens: 0 },
      }),
    );

    await expect(
      makeProvider(fetchImpl as unknown as typeof fetch).generate(baseRequest),
    ).rejects.toMatchObject({ retryable: true });
  });

  it("surfaces a body-level error as non-retryable", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { error: { message: "model not found", type: "invalid_request" } }),
    );

    await expect(
      makeProvider(fetchImpl as unknown as typeof fetch).generate(baseRequest),
    ).rejects.toMatchObject({ retryable: false, message: expect.stringContaining("model not found") });
  });

  it("wraps a request error as retryable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });

    await expect(
      makeProvider(fetchImpl as unknown as typeof fetch).generate(baseRequest),
    ).rejects.toBeInstanceOf(ModelCallError);
  });

  it("claims any vendor/model id and rejects a simulator id", () => {
    const provider = new OpenRouterProvider({ apiKey: "test-key", fetchImpl: vi.fn() });
    expect(provider.supports("anthropic/claude-sonnet-4")).toBe(true);
    expect(provider.supports("meta-llama/llama-3.1-70b-instruct")).toBe(true);
    expect(provider.supports("simulator/deterministic")).toBe(false);
    expect(provider.supports("no-slash")).toBe(false);
  });
});
