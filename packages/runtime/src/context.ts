import type { ArchitectureGenome } from "@meta/genome";
import type { ModelGateway, CallAttribution } from "@meta/gateway";
import type { Clock, IdGenerator, TokenUsage } from "@meta/shared";
import type { Sql } from "@meta/db";

/** A memory as offered to an agent's context. */
export interface RecalledKnowledge {
  id: string;
  type: string;
  content: string;
  similarity: number;
}

/**
 * The knowledge-memory reader available during a run.
 *
 * This port exposes knowledge memory and nothing else. Evolutionary memory —
 * what the ecosystem learned about its own structure — is deliberately
 * unreachable from a RunContext: an agent that can read which architectures
 * score well is an agent that can optimize for its own evaluation instead of
 * the user's question. The mutation engine reads that store, on the other side
 * of the run.
 */
export interface KnowledgeRecall {
  recall(query: string, opts: { limit: number; minSimilarity: number }): Promise<RecalledKnowledge[]>;
}

export type RunEvent =
  | { type: "stage.start"; stage: string; iteration: number }
  | { type: "stage.finish"; stage: string; iteration: number; replayed: boolean }
  | { type: "agent.start"; stage: string; agentId: string }
  | {
      type: "agent.finish";
      stage: string;
      agentId: string;
      costUsd: number;
      latencyMs: number;
      replayed: boolean;
    }
  | { type: "run.paused"; stage: string; approvalId: string }
  | { type: "run.finished"; status: string };

export interface RunContext {
  sql: Sql;
  gateway: ModelGateway;
  clock: Clock;
  ids: IdGenerator;

  genome: ArchitectureGenome;
  run: {
    id: string;
    ecosystemId: string;
    genomeVersionId: string;
    objective: string;
    seed: string;
  };
  iteration: number;

  attribution: CallAttribution;
  emit: (event: RunEvent) => void;
  recall?: KnowledgeRecall;
}

/** Aggregate cost of a stage, folded into the run totals. */
export interface StageCost {
  usage: TokenUsage;
  costUsd: number;
}
