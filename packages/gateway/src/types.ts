import type { TokenUsage } from "@meta/shared";

/**
 * The model access port.
 *
 * Every model call in the system goes through one interface, for two reasons.
 * First, cost and latency are first-class metrics, so there must be exactly one
 * place that observes them. Second, the product's central claim is that a run
 * against a fixed genome version is reproducible — which requires that the
 * model layer be swappable for a deterministic one, not merely mockable in
 * unit tests.
 */

/** JSON Schema subset produced by `z.toJSONSchema`. */
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  description?: string;
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
}

/** Where a call came from, for telemetry attribution. */
export interface CallAttribution {
  orgId?: string | null;
  workspaceId?: string | null;
  ecosystemId?: string | null;
  runId?: string | null;
  artifactId?: string | null;
  agentId?: string | null;
  stage?: string | null;
}

export interface ModelCallRequest {
  /** Primary model, `provider/model`. */
  modelId: string;
  /** Tried in order if the primary fails. */
  fallbacks?: readonly string[];
  /** Trusted policy channel. Assembled by the prompt builder, never user text. */
  system: string;
  /** The message body. Untrusted content inside is already fenced. */
  prompt: string;
  temperature: number;
  maxOutputTokens: number;
  /** When set, the response must satisfy this schema. */
  jsonSchema?: JsonSchema;
  /**
   * Determinism seed. The simulator derives its entire response from this, so
   * two runs with the same seed produce byte-identical output.
   */
  seed: string;
  attribution?: CallAttribution;
}

export interface ModelCallResult {
  /** The model that actually served the call, which may be a fallback. */
  modelId: string;
  text: string;
  /** Parsed structured output, present when `jsonSchema` was supplied. */
  json?: unknown;
  usage: TokenUsage;
  costUsd: number;
  unpriced: boolean;
  latencyMs: number;
  /** Total attempts across all models tried. */
  attempts: number;
  fallbackUsed: boolean;
  finishReason: string;
}

/** What a concrete provider must implement. Retries and fallback live above. */
export interface ModelProvider {
  readonly name: string;
  /** True when this provider can serve the given model id. */
  supports(modelId: string): boolean;
  generate(request: ProviderRequest): Promise<ProviderResult>;
}

export interface ProviderRequest {
  modelId: string;
  system: string;
  prompt: string;
  temperature: number;
  maxOutputTokens: number;
  jsonSchema?: JsonSchema;
  seed: string;
}

export interface ProviderResult {
  text: string;
  json?: unknown;
  usage: TokenUsage;
  finishReason: string;
  /**
   * Provider-reported latency. When set, the gateway records this instead of
   * wall-clock elapsed time — which is what lets the deterministic provider
   * produce reproducible timings rather than ones that vary with machine speed.
   */
  latencyMs?: number;
  /**
   * Provider-reported cost in USD for this call. When set, the gateway
   * records this instead of the static MODEL_PRICING table — the same
   * override relationship latencyMs already has with wall-clock timing.
   */
  costUsd?: number;
}

/** Receives a usage record for every completed call. */
export interface UsageSink {
  record(event: {
    modelId: string;
    provider: string;
    usage: TokenUsage;
    costUsd: number;
    unpriced: boolean;
    latencyMs: number;
    attribution: CallAttribution;
  }): Promise<void> | void;
}

export interface ModelGateway {
  generate(request: ModelCallRequest): Promise<ModelCallResult>;
}
