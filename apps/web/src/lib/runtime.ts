import { Gateway, SimulatorProvider, AiGatewayProvider, hasGatewayCredentials } from "@meta/gateway";
import { DeterministicEmbedder, GatewayEmbedder, type EmbeddingProvider } from "@meta/memory";
import { randomIds, systemClock } from "@meta/shared";
import { telemetry } from "@meta/db";
import { db } from "./db.js";

/**
 * Model access for the app.
 *
 * Hosted inference when credentials exist, the deterministic provider
 * otherwise, with usage recorded to `usage_events` either way so the cost
 * displayed in the UI is measured rather than estimated.
 */
export function gateway() {
  const providers = hasGatewayCredentials()
    ? [new AiGatewayProvider(), new SimulatorProvider()]
    : [new SimulatorProvider()];

  return new Gateway({
    providers,
    clock: systemClock,
    usageSink: {
      record: (event) =>
        telemetry.recordUsage(db(), {
          id: randomIds.next("usageEvent"),
          modelId: event.modelId,
          provider: event.provider,
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          costUsd: event.costUsd,
          unpriced: event.unpriced,
          latencyMs: event.latencyMs,
          ...event.attribution,
        }),
    },
    // A telemetry outage must never re-run a paid model call.
    onUsageError: (error) => console.error("[usage] failed to record", error),
  });
}

export function embedder(): EmbeddingProvider {
  return hasGatewayCredentials() ? new GatewayEmbedder() : new DeterministicEmbedder();
}

/** True when this process serves model calls deterministically. */
export function isDeterministic(): boolean {
  return !hasGatewayCredentials();
}
