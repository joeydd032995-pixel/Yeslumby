import { z } from "zod";
import { GenomeValidationError, MutationPolicyError } from "@meta/shared";
import {
  AgentSchema,
  EdgeSchema,
  InteractionSchema,
  MemoryPolicySchema,
  ModelConfigSchema,
  MutationTypeSchema,
  PRIVILEGE_BEARING_MUTATIONS,
  ProtocolsSchema,
  StopCriteriaSchema,
  WatcherSchema,
  type ArchitectureGenome,
  type MutationType,
} from "./schema.js";
import { parseGenome } from "./validate.js";

/**
 * Mutations are explicit, versioned patches — never in-place edits.
 *
 * `applyPatches` is pure: it deep-clones, applies, then re-parses and
 * re-validates. A patch set that would produce an invalid organization fails
 * here rather than at run time, and the input genome is never touched, so a
 * rejected mutation cannot leave a half-applied genome behind.
 */

const slug = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/);

export const MutationPatchSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ADD_AGENT"), agent: AgentSchema, rationale: z.string().optional() }),
  z.object({ type: z.literal("REMOVE_AGENT"), agentId: slug, rationale: z.string().optional() }),
  z.object({
    type: z.literal("UPDATE_PROMPT"),
    agentId: slug,
    systemPrompt: z.string().min(1).max(8000),
    rationale: z.string().optional(),
  }),
  z.object({
    type: z.literal("UPDATE_MODEL"),
    agentId: slug,
    model: ModelConfigSchema.partial(),
    rationale: z.string().optional(),
  }),
  z.object({
    type: z.literal("UPDATE_CAPABILITIES"),
    agentId: slug,
    capabilities: AgentSchema.shape.capabilities,
    rationale: z.string().optional(),
  }),
  z.object({ type: z.literal("ADD_EDGE"), edge: EdgeSchema, rationale: z.string().optional() }),
  z.object({
    type: z.literal("REMOVE_EDGE"),
    from: slug,
    to: slug,
    interaction: InteractionSchema,
    rationale: z.string().optional(),
  }),
  z.object({
    type: z.literal("CHANGE_PROTOCOL"),
    protocols: ProtocolsSchema.partial(),
    rationale: z.string().optional(),
  }),
  z.object({
    type: z.literal("CHANGE_WATCHER"),
    watcher: WatcherSchema.partial(),
    rationale: z.string().optional(),
  }),
  z.object({
    type: z.literal("CHANGE_MEMORY_POLICY"),
    memoryPolicy: MemoryPolicySchema.partial(),
    rationale: z.string().optional(),
  }),
  z.object({
    type: z.literal("CHANGE_STOP_CRITERIA"),
    stopCriteria: StopCriteriaSchema.partial(),
    rationale: z.string().optional(),
  }),
]);

/** A validated patch, with defaults applied. */
export type MutationPatch = z.output<typeof MutationPatchSchema>;
/**
 * A patch as authored. Patches usually arrive as JSON from the Watcher, so the
 * public entry point accepts this shape and validates it rather than trusting
 * callers to have materialized every default.
 */
export type MutationPatchInput = z.input<typeof MutationPatchSchema>;

export const MutationPatchListSchema = z.array(MutationPatchSchema).min(1).max(20);

export type MutationActor = "WATCHER" | "HUMAN" | "BREEDING";

export interface ApplyOptions {
  /** Who is applying. A Watcher is held to stricter limits than a human. */
  actor: MutationActor;
  /** Set when a human has explicitly approved this patch set. */
  humanApproved?: boolean;
  /** Skip policy checks. Only for breeding, which composes validated parents. */
  bypassPolicy?: boolean;
}

/**
 * Reject patches the genome's own policy forbids.
 *
 * The security-relevant case is the last one: a Watcher must not be able to
 * widen capabilities or rewrite its own evaluation configuration without a
 * human in the loop. That check does not depend on the Watcher behaving well,
 * because the Watcher never applies patches itself — it proposes them, and this
 * function is what decides.
 */
export function assertPatchesAllowed(
  genome: ArchitectureGenome,
  patches: readonly MutationPatch[],
  options: ApplyOptions,
): void {
  if (options.bypassPolicy) return;

  const policy = genome.mutationPolicy;
  if (!policy.enabled) {
    throw new MutationPolicyError("mutation is disabled for this genome", {
      actor: options.actor,
    });
  }

  if (patches.length > policy.maxMutationsPerRun && options.actor === "WATCHER") {
    throw new MutationPolicyError(
      `watcher proposed ${patches.length} patches but maxMutationsPerRun is ${policy.maxMutationsPerRun}`,
      { actor: options.actor, proposed: patches.length, limit: policy.maxMutationsPerRun },
    );
  }

  const allowed = new Set<MutationType>(policy.allowed);
  for (const patch of patches) {
    if (!allowed.has(patch.type)) {
      throw new MutationPolicyError(
        `mutation type ${patch.type} is not in mutationPolicy.allowed`,
        { actor: options.actor, type: patch.type, allowed: [...allowed] },
      );
    }

    const privilegeBearing = PRIVILEGE_BEARING_MUTATIONS.includes(patch.type);
    if (privilegeBearing && options.actor === "WATCHER" && !options.humanApproved) {
      throw new MutationPolicyError(
        `${patch.type} can widen the organization's permissions and requires human ` +
          `approval when proposed by the watcher`,
        { actor: options.actor, type: patch.type },
      );
    }

    if (policy.humanApprovalRequired && options.actor === "WATCHER" && !options.humanApproved) {
      throw new MutationPolicyError(
        `mutationPolicy.humanApprovalRequired is set; watcher patches need approval`,
        { actor: options.actor, type: patch.type },
      );
    }
  }
}

export interface ApplyResult {
  genome: ArchitectureGenome;
  applied: MutationPatch[];
}

/**
 * Parse an untrusted patch list.
 *
 * The Watcher proposes mutations as model output, so patches are untrusted data
 * on the same footing as any other model output — validated before they can
 * touch a genome.
 */
export function parsePatches(input: unknown): MutationPatch[] {
  const parsed = MutationPatchListSchema.safeParse(input);
  if (!parsed.success) {
    throw new GenomeValidationError("mutation patches failed validation", {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  return parsed.data;
}

/**
 * Produce a new genome by applying patches. The input is never mutated.
 */
export function applyPatches(
  genome: ArchitectureGenome,
  patches: readonly MutationPatchInput[],
  options: ApplyOptions,
): ApplyResult {
  const validated = parsePatches(patches);
  assertPatchesAllowed(genome, validated, options);

  const draft = structuredClone(genome) as ArchitectureGenome;

  for (const patch of validated) {
    switch (patch.type) {
      case "ADD_AGENT": {
        if (draft.agents.some((a) => a.id === patch.agent.id)) {
          throw new MutationPolicyError(`agent "${patch.agent.id}" already exists`, {
            type: patch.type,
          });
        }
        draft.agents.push(patch.agent);
        break;
      }

      case "REMOVE_AGENT": {
        if (patch.agentId === draft.synthesizerId) {
          // Removing the synthesizer would leave the organization unable to
          // produce a result at all; a mutation must never do that silently.
          throw new MutationPolicyError(
            `cannot remove "${patch.agentId}": it is the synthesizer`,
            { type: patch.type },
          );
        }
        const before = draft.agents.length;
        draft.agents = draft.agents.filter((a) => a.id !== patch.agentId);
        if (draft.agents.length === before) {
          throw new MutationPolicyError(`agent "${patch.agentId}" does not exist`, {
            type: patch.type,
          });
        }
        // Edges touching a removed agent would dangle and fail invariants.
        draft.edges = draft.edges.filter(
          (e) => e.from !== patch.agentId && e.to !== patch.agentId,
        );
        break;
      }

      case "UPDATE_PROMPT": {
        const agent = findAgent(draft, patch.agentId, patch.type);
        agent.systemPrompt = patch.systemPrompt;
        break;
      }

      case "UPDATE_MODEL": {
        const agent = findAgent(draft, patch.agentId, patch.type);
        agent.model = mergeDefined(agent.model, patch.model);
        break;
      }

      case "UPDATE_CAPABILITIES": {
        const agent = findAgent(draft, patch.agentId, patch.type);
        agent.capabilities = [...patch.capabilities];
        break;
      }

      case "ADD_EDGE": {
        const exists = draft.edges.some(
          (e) =>
            e.from === patch.edge.from &&
            e.to === patch.edge.to &&
            e.interaction === patch.edge.interaction,
        );
        if (!exists) draft.edges.push(patch.edge);
        break;
      }

      case "REMOVE_EDGE": {
        draft.edges = draft.edges.filter(
          (e) =>
            !(e.from === patch.from && e.to === patch.to && e.interaction === patch.interaction),
        );
        break;
      }

      case "CHANGE_PROTOCOL":
        draft.protocols = mergeDefined(draft.protocols, patch.protocols);
        break;

      case "CHANGE_WATCHER":
        draft.watcher = mergeDefined(draft.watcher, patch.watcher);
        break;

      case "CHANGE_MEMORY_POLICY":
        draft.memoryPolicy = mergeDefined(draft.memoryPolicy, patch.memoryPolicy);
        break;

      case "CHANGE_STOP_CRITERIA":
        draft.stopCriteria = mergeDefined(draft.stopCriteria, patch.stopCriteria);
        break;
    }
  }

  // Re-validate. A patch set that produces an incoherent organization — a
  // dangling edge, a lost synthesizer, an agent count over the cap — fails here
  // rather than at run time.
  //
  // Warnings are fatal for an unattended Watcher mutation but not for a human
  // one. A person may knowingly accept a genome that trips a warning — they can
  // see it and are choosing it. An automated mutation that quietly collapses
  // cognitive diversity, or points the Watcher at the Synthesizer's own model
  // family, degrades the very signal the evolutionary loop steers by, and
  // nobody is watching at the moment it happens.
  const strict = options.actor === "WATCHER";
  return { genome: parseGenome(draft, { strict }), applied: validated };
}

function findAgent(genome: ArchitectureGenome, id: string, type: MutationType) {
  const agent = genome.agents.find((a) => a.id === id);
  if (!agent) {
    throw new MutationPolicyError(`agent "${id}" does not exist`, { type });
  }
  return agent;
}

/**
 * Overlay only the keys the patch actually set.
 *
 * A Zod `.partial()` result carries every key with an explicit `undefined` for
 * the ones the author omitted. Spreading that over the base would erase real
 * values, turning "change temperature" into "reset the whole model config".
 */
function mergeDefined<T extends object>(base: T, patch: object): T {
  const out: Record<string, unknown> = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// Diffing, for the evolution graph
// ---------------------------------------------------------------------------

export interface GenomeDiff {
  agentsAdded: string[];
  agentsRemoved: string[];
  agentsChanged: Array<{ id: string; fields: string[] }>;
  edgesAdded: string[];
  edgesRemoved: string[];
  protocolChanges: Array<{ key: string; from: unknown; to: unknown }>;
  watcherChanged: boolean;
  memoryPolicyChanged: boolean;
  stopCriteriaChanged: boolean;
}

const edgeKey = (e: { from: string; to: string; interaction: string }) =>
  `${e.from} -${e.interaction}-> ${e.to}`;

export function diffGenomes(before: ArchitectureGenome, after: ArchitectureGenome): GenomeDiff {
  const beforeAgents = new Map(before.agents.map((a) => [a.id, a]));
  const afterAgents = new Map(after.agents.map((a) => [a.id, a]));

  const agentsAdded = [...afterAgents.keys()].filter((id) => !beforeAgents.has(id));
  const agentsRemoved = [...beforeAgents.keys()].filter((id) => !afterAgents.has(id));

  const agentsChanged: GenomeDiff["agentsChanged"] = [];
  for (const [id, a] of afterAgents) {
    const b = beforeAgents.get(id);
    if (!b) continue;
    const fields = (
      ["name", "role", "cognitiveMode", "systemPrompt", "weight", "proposes"] as const
    ).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    if (JSON.stringify(a.model) !== JSON.stringify(b.model)) fields.push("model" as never);
    if (JSON.stringify(a.capabilities) !== JSON.stringify(b.capabilities)) {
      fields.push("capabilities" as never);
    }
    if (fields.length) agentsChanged.push({ id, fields: [...fields] });
  }

  const beforeEdges = new Set(before.edges.map(edgeKey));
  const afterEdges = new Set(after.edges.map(edgeKey));

  const protocolChanges: GenomeDiff["protocolChanges"] = [];
  for (const key of Object.keys(after.protocols) as Array<keyof typeof after.protocols>) {
    if (JSON.stringify(before.protocols[key]) !== JSON.stringify(after.protocols[key])) {
      protocolChanges.push({ key, from: before.protocols[key], to: after.protocols[key] });
    }
  }

  return {
    agentsAdded,
    agentsRemoved,
    agentsChanged,
    edgesAdded: [...afterEdges].filter((e) => !beforeEdges.has(e)),
    edgesRemoved: [...beforeEdges].filter((e) => !afterEdges.has(e)),
    protocolChanges,
    watcherChanged: JSON.stringify(before.watcher) !== JSON.stringify(after.watcher),
    memoryPolicyChanged:
      JSON.stringify(before.memoryPolicy) !== JSON.stringify(after.memoryPolicy),
    stopCriteriaChanged:
      JSON.stringify(before.stopCriteria) !== JSON.stringify(after.stopCriteria),
  };
}

export function isEmptyDiff(diff: GenomeDiff): boolean {
  return (
    diff.agentsAdded.length === 0 &&
    diff.agentsRemoved.length === 0 &&
    diff.agentsChanged.length === 0 &&
    diff.edgesAdded.length === 0 &&
    diff.edgesRemoved.length === 0 &&
    diff.protocolChanges.length === 0 &&
    !diff.watcherChanged &&
    !diff.memoryPolicyChanged &&
    !diff.stopCriteriaChanged
  );
}

export { MutationTypeSchema };
