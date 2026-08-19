import { ModelCallError } from "@meta/shared";
import type { ModelProvider, ProviderRequest, ProviderResult } from "./types.js";

/**
 * Vercel AI Gateway provider.
 *
 * All hosted inference routes through the gateway, so model choice stays a
 * genome-level decision and every provider is reached the same way. The gateway
 * exposes an OpenAI-compatible chat-completions endpoint and takes model ids in
 * the same `provider/model` form the genome uses, so no id translation is
 * needed here.
 *
 * This talks to that endpoint over fetch rather than through the AI SDK: the
 * surface used is small and stable, and it keeps a provider that cannot be
 * exercised without credentials from pulling in a large dependency tree.
 */

const DEFAULT_BASE_URL = "https://ai-gateway.vercel.sh/v1";

export interface AiGatewayOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Per-request timeout. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string; type?: string };
}

export class AiGatewayProvider implements ModelProvider {
  readonly name = "ai-gateway";
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: AiGatewayOptions = {}) {
    const apiKey = options.apiKey ?? process.env.AI_GATEWAY_API_KEY;
    if (!apiKey) {
      throw new Error(
        "AI_GATEWAY_API_KEY is not set. Use the simulator provider, or supply a key.",
      );
    }
    this.#apiKey = apiKey;
    this.#baseUrl = (options.baseUrl ?? process.env.AI_GATEWAY_BASE_URL ?? DEFAULT_BASE_URL)
      .replace(/\/$/, "");
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  /** The gateway fronts every provider, so any `provider/model` id is routable. */
  supports(modelId: string): boolean {
    return modelId.includes("/") && !modelId.startsWith("simulator/");
  }

  async generate(request: ProviderRequest): Promise<ProviderResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: request.modelId,
          temperature: request.temperature,
          max_tokens: request.maxOutputTokens,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.prompt },
          ],
          ...(request.jsonSchema
            ? {
                response_format: {
                  type: "json_schema",
                  json_schema: {
                    name: "stage_output",
                    strict: true,
                    schema: request.jsonSchema,
                  },
                },
              }
            : {}),
        }),
      });

      if (!response.ok) {
        throw new ModelCallError(
          `gateway returned ${response.status}: ${(await safeText(response)).slice(0, 300)}`,
          isRetryableStatus(response.status),
          { modelId: request.modelId, status: response.status },
        );
      }

      const body = (await response.json()) as ChatCompletionResponse;
      if (body.error) {
        throw new ModelCallError(body.error.message ?? "gateway error", false, {
          modelId: request.modelId,
          type: body.error.type,
        });
      }

      const choice = body.choices?.[0];
      const text = choice?.message?.content ?? "";
      if (!text) {
        // Empty content usually means a transient truncation or filter event
        // rather than a real answer; worth one retry.
        throw new ModelCallError("gateway returned empty content", true, {
          modelId: request.modelId,
          finishReason: choice?.finish_reason,
        });
      }

      const cached = body.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      return {
        text,
        usage: {
          inputTokens: body.usage?.prompt_tokens ?? 0,
          outputTokens: body.usage?.completion_tokens ?? 0,
          ...(cached > 0 ? { cachedInputTokens: cached } : {}),
        },
        finishReason: choice?.finish_reason ?? "stop",
      };
    } catch (error) {
      if (error instanceof ModelCallError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new ModelCallError(`gateway request timed out after ${this.#timeoutMs}ms`, true, {
          modelId: request.modelId,
        });
      }
      throw new ModelCallError(
        error instanceof Error ? error.message : "gateway request failed",
        true,
        { modelId: request.modelId },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 408/409/429 and 5xx are transient; other 4xx are caller errors. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable body>";
  }
}

/** True when hosted inference is configured for this process. */
export function hasGatewayCredentials(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY);
}
