import { Gateway, type GatewayOptions } from "./gateway.js";
import { SimulatorProvider } from "./simulator.js";
import { AiGatewayProvider, hasGatewayCredentials } from "./ai-gateway.js";
import { OpenRouterProvider, hasOpenRouterCredentials } from "./openrouter.js";
import type { ModelProvider, UsageSink } from "./types.js";

export type {
  JsonSchema,
  CallAttribution,
  ModelCallRequest,
  ModelCallResult,
  ModelGateway,
  ModelProvider,
  ProviderRequest,
  ProviderResult,
  UsageSink,
} from "./types.js";

export { Gateway, type GatewayOptions } from "./gateway.js";
export {
  SimulatorProvider,
  type ScriptedResponse,
  type CallMatcher,
  type SimulatorOptions,
} from "./simulator.js";
export { AiGatewayProvider, hasGatewayCredentials, type AiGatewayOptions } from "./ai-gateway.js";
export {
  OpenRouterProvider,
  hasOpenRouterCredentials,
  type OpenRouterOptions,
} from "./openrouter.js";
export { synthesize, topicWords, type SynthContext } from "./synth.js";

export interface ResolveGatewayOptions extends Partial<Omit<GatewayOptions, "providers">> {
  /** Force the deterministic provider even when credentials are present. */
  forceSimulator?: boolean;
  usageSink?: UsageSink;
}

/**
 * Build the gateway appropriate to the environment.
 *
 * Hosted inference is used when credentials exist; otherwise the deterministic
 * provider serves every call. The simulator is always registered last so it
 * acts as a universal fallback: a model the hosted gateway cannot route still
 * produces a usable, reproducible response rather than failing the run.
 *
 * OpenRouter and the Vercel AI Gateway are swap-in alternatives, not two
 * permanently-registered providers: both claim the same `vendor/model` id
 * shape, and `Gateway.generate()` picks the first provider whose `supports()`
 * matches, so registering both would silently make one dead code. If both
 * credentials happen to be present in the same process there is no
 * functional reason to prefer either — both are OpenAI-compatible chat
 * backends — so the choice is made explicit rather than left to array order:
 * OpenRouter wins.
 */
export function resolveGateway(options: ResolveGatewayOptions = {}): Gateway {
  const providers: ModelProvider[] = [];

  if (!options.forceSimulator && hasOpenRouterCredentials()) {
    providers.push(new OpenRouterProvider());
  } else if (!options.forceSimulator && hasGatewayCredentials()) {
    providers.push(new AiGatewayProvider());
  }
  providers.push(new SimulatorProvider());

  const { forceSimulator: _ignored, ...rest } = options;
  return new Gateway({ ...rest, providers });
}

/** True when this process will serve model calls deterministically. */
export function isDeterministic(options: { forceSimulator?: boolean } = {}): boolean {
  return (
    Boolean(options.forceSimulator) || (!hasGatewayCredentials() && !hasOpenRouterCredentials())
  );
}
