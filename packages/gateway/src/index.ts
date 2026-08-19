import { Gateway, type GatewayOptions } from "./gateway.js";
import { SimulatorProvider } from "./simulator.js";
import { AiGatewayProvider, hasGatewayCredentials } from "./ai-gateway.js";
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
 */
export function resolveGateway(options: ResolveGatewayOptions = {}): Gateway {
  const providers: ModelProvider[] = [];

  if (!options.forceSimulator && hasGatewayCredentials()) {
    providers.push(new AiGatewayProvider());
  }
  providers.push(new SimulatorProvider());

  const { forceSimulator: _ignored, ...rest } = options;
  return new Gateway({ ...rest, providers });
}

/** True when this process will serve model calls deterministically. */
export function isDeterministic(options: { forceSimulator?: boolean } = {}): boolean {
  return Boolean(options.forceSimulator) || !hasGatewayCredentials();
}
