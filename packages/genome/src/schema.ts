import { z } from "zod";

/**
 * The Architecture Genome.
 *
 * A genome is **pure data** — never application code. It describes an
 * organization of agents, how they are wired, and the protocols that govern a
 * run. The runtime interprets it; nothing here is ever evaluated.
 *
 * Note what is deliberately *absent*: version number, parent ids, and
 * timestamps. Those belong to the version envelope
 * ({@link GenomeArtifactSchema}), not the genome body. The body is what gets
 * content-hashed, and a hash that included its own version number could never
 * detect that two versions are semantically identical — which is exactly the
 * check that stops a no-op mutation from forking the lineage.
 */

/** Identifiers authored by humans inside a genome. */
const slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "must be lowercase alphanumeric with - or _");

/** Gateway model id, always `provider/model`. The provider half matters: the
 * Watcher must not share a family with the Synthesizer. */
const modelId = z
  .string()
  .min(3)
  .max(120)
  .regex(/^[a-z0-9-]+\/[a-zA-Z0-9._-]+$/, "must be in the form provider/model");

export const CognitiveModeSchema = z.enum([
  "analytical",
  "creative",
  "critical",
  "systems",
  "empirical",
  "adversarial",
  "synthetic",
  "pragmatic",
]);
export type CognitiveMode = z.output<typeof CognitiveModeSchema>;

export const InteractionSchema = z.enum([
  "challenge",
  "critique",
  "extend",
  "verify",
  "synthesize",
  "observe",
]);
export type Interaction = z.output<typeof InteractionSchema>;

/**
 * Tool capabilities. An agent may only use what its genome grants; the executor
 * refuses anything else. `memory_write` is separated from the read path so an
 * agent can consult knowledge memory without being able to poison it.
 */
export const CapabilitySchema = z.enum([
  "web_search",
  "http_request",
  "code_execution",
  "file_read",
  "file_write",
  "database_query",
  "memory_write",
]);
export type Capability = z.output<typeof CapabilitySchema>;

export const ModelConfigSchema = z.object({
  primary: modelId,
  /** Tried in order when the primary fails. Empty means no failover. */
  fallbacks: z.array(modelId).max(4).default([]),
  temperature: z.number().min(0).max(2).default(0.7),
  maxOutputTokens: z.number().int().min(64).max(64_000).default(4096),
});
export type ModelConfig = z.output<typeof ModelConfigSchema>;

export const AgentSchema = z.object({
  id: slug,
  name: z.string().min(1).max(120),
  role: z.string().min(1).max(300),
  cognitiveMode: CognitiveModeSchema,
  /** Inserted into prompts as delimited data, never concatenated into policy. */
  systemPrompt: z.string().min(1).max(8000),
  model: ModelConfigSchema,
  capabilities: z.array(CapabilitySchema).max(7).default([]),
  /** Relative influence during synthesis. Not a vote weight — see synthesis. */
  weight: z.number().min(0).max(1).default(1),
  /**
   * Whether this agent produces an independent proposal. A synthesizer usually
   * sets this false so it does not anchor on its own prior position.
   */
  proposes: z.boolean().default(true),
});
export type AgentSpec = z.output<typeof AgentSchema>;

export const EdgeSchema = z.object({
  from: slug,
  to: slug,
  interaction: InteractionSchema,
  weight: z.number().min(0).max(1).default(1),
});
export type EdgeSpec = z.output<typeof EdgeSchema>;

export const HumanApprovalSchema = z.enum(["none", "mutations", "high_risk", "all"]);
export type HumanApprovalLevel = z.output<typeof HumanApprovalSchema>;

export const ProtocolsSchema = z.object({
  /** No agent sees a peer's proposal until the whole proposal stage completes. */
  independentProposal: z.boolean().default(true),
  crossChallenge: z.boolean().default(true),
  preserveMinorityViews: z.boolean().default(true),
  falsificationRequired: z.boolean().default(true),
  humanApproval: HumanApprovalSchema.default("mutations"),
  maxRounds: z.number().int().min(1).max(10).default(1),
  /**
   * A claim is reportable as high-confidence only when the synthesizer's own
   * stated `confidence` is at or above this.
   *
   * Enforced by construction rather than checked afterwards: the synthesis
   * stage builds its per-call schema with this as the floor on `confidence` for
   * `highConfidence` claims, so it travels into the JSON Schema and a claim
   * below the bar cannot be generated. Only that list is gated —
   * `workingHypotheses` keeps the full range, because a less certain claim
   * needs somewhere legal to go rather than nowhere.
   *
   * This said "agreement" until it was found to be read by nothing at all.
   * Nothing in a run measures agreement per claim: `agreementScore` is
   * per-challenge, and objections join to *proposal* claims rather than to the
   * synthesis claims written afterwards. Confidence is the only per-claim number
   * that exists, so it is what this gates — narrower than the original wording,
   * and stated rather than assumed.
   */
  consensusThreshold: z.number().min(0).max(1).default(0.7),
  /**
   * Disagreement at or above this *must* survive into the synthesis output as
   * a contested claim. The synthesis stage validates against this.
   */
  disagreementThreshold: z.number().min(0).max(1).default(0.3),
});
export type Protocols = z.output<typeof ProtocolsSchema>;

export const WatcherDimensionSchema = z.enum([
  "diversity",
  "challengeQuality",
  "independence",
  "evidenceQuality",
  "efficiency",
  "goalAlignment",
]);
export type WatcherDimension = z.output<typeof WatcherDimensionSchema>;

export const WatcherSchema = z.object({
  enabled: z.boolean().default(true),
  model: ModelConfigSchema,
  /** The Watcher scores the organization, not the answer. */
  dimensions: z
    .array(WatcherDimensionSchema)
    .min(1)
    .default(["diversity", "challengeQuality", "independence", "evidenceQuality", "efficiency"]),
});
export type WatcherConfig = z.output<typeof WatcherSchema>;

export const RetentionSchema = z.enum(["ephemeral", "standard", "permanent"]);

export const MemoryPolicySchema = z.object({
  semanticRecall: z.boolean().default(true),
  recallLimit: z.number().int().min(0).max(50).default(8),
  /** Cosine similarity floor for a memory to be recalled into context. */
  minSimilarity: z.number().min(0).max(1).default(0.6),
  /** At or above this similarity a new memory is a duplicate and is merged. */
  noveltyThreshold: z.number().min(0).max(1).default(0.92),
  /** Below this importance a candidate memory is discarded. */
  importanceFloor: z.number().min(0).max(1).default(0.3),
  retention: RetentionSchema.default("standard"),
  /** Which stores this ecosystem may write. Reading is governed separately. */
  writeScopes: z
    .array(z.enum(["knowledge", "evolutionary"]))
    .default(["knowledge", "evolutionary"]),
});
export type MemoryPolicy = z.output<typeof MemoryPolicySchema>;

export const MutationTypeSchema = z.enum([
  "ADD_AGENT",
  "REMOVE_AGENT",
  "UPDATE_PROMPT",
  "UPDATE_MODEL",
  "UPDATE_CAPABILITIES",
  "ADD_EDGE",
  "REMOVE_EDGE",
  "CHANGE_PROTOCOL",
  "CHANGE_WATCHER",
  "CHANGE_MEMORY_POLICY",
  "CHANGE_STOP_CRITERIA",
]);
export type MutationType = z.output<typeof MutationTypeSchema>;

/**
 * Mutation types that can widen what the organization is permitted to do.
 * These are the ones a Watcher must never be able to apply unattended.
 */
export const PRIVILEGE_BEARING_MUTATIONS: readonly MutationType[] = [
  "UPDATE_CAPABILITIES",
  "CHANGE_WATCHER",
];

export const MutationPolicySchema = z.object({
  enabled: z.boolean().default(true),
  allowed: z
    .array(MutationTypeSchema)
    .default(["UPDATE_PROMPT", "ADD_EDGE", "REMOVE_EDGE", "ADD_AGENT", "CHANGE_PROTOCOL"]),
  humanApprovalRequired: z.boolean().default(true),
  maxAgents: z.number().int().min(1).max(24).default(12),
  maxMutationsPerRun: z.number().int().min(0).max(10).default(2),
});
export type MutationPolicy = z.output<typeof MutationPolicySchema>;

export const StopCriteriaSchema = z.object({
  maxIterations: z.number().int().min(1).max(20).default(3),
  /** Stop early once the Watcher's overall score reaches this. */
  targetScore: z.number().min(0).max(1).default(0.85),
  maxCostUsd: z.number().min(0).max(1000).default(5),
  maxTokens: z.number().int().min(1000).max(50_000_000).default(2_000_000),
});
export type StopCriteria = z.output<typeof StopCriteriaSchema>;

export const ArchitectureGenomeSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(""),
  /** The class of problem this organization is shaped for. Keys evolutionary memory. */
  problemClass: z.string().min(1).max(80).default("general"),
  tags: z.array(z.string().min(1).max(40)).max(20).default([]),

  agents: z.array(AgentSchema).min(1).max(24),
  edges: z.array(EdgeSchema).max(200).default([]),

  /** Which agent performs synthesis. Must reference an agent in `agents`. */
  synthesizerId: slug,

  // `prefault` (not `default`) so an omitted block is fed through the parser
  // and picks up each field's own default, rather than requiring a fully
  // materialized object here.
  protocols: ProtocolsSchema.prefault({}),
  watcher: WatcherSchema,
  memoryPolicy: MemoryPolicySchema.prefault({}),
  mutationPolicy: MutationPolicySchema.prefault({}),
  stopCriteria: StopCriteriaSchema.prefault({}),
});

/** The genome as authored, before defaults are applied. */
export type ArchitectureGenomeInput = z.input<typeof ArchitectureGenomeSchema>;
/** The normalized genome. This is the form that gets hashed and executed. */
export type ArchitectureGenome = z.output<typeof ArchitectureGenomeSchema>;

/**
 * The self-contained export format.
 *
 * `genome` is the hashed body; `lineage` is the version envelope around it.
 * Keeping them apart is what lets an importer verify the hash independently of
 * where the artifact came from.
 */
export const GenomeArtifactSchema = z.object({
  format: z.literal("meta-ecosystem/genome"),
  formatVersion: z.literal(1),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  lineage: z.object({
    version: z.number().int().min(1),
    parentIds: z.array(z.string()).default([]),
    parentHashes: z.array(z.string()).default([]),
    origin: z.enum(["SEED", "MUTATION", "BREEDING", "FORK", "MANUAL"]),
    createdAt: z.string(),
    ecosystem: z.string().optional(),
  }),
  genome: ArchitectureGenomeSchema,
});
export type GenomeArtifact = z.output<typeof GenomeArtifactSchema>;
