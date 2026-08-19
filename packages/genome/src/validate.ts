import { GenomeValidationError } from "@meta/shared";
import {
  ArchitectureGenomeSchema,
  PRIVILEGE_BEARING_MUTATIONS,
  type ArchitectureGenome,
  type ArchitectureGenomeInput,
} from "./schema.js";

/**
 * Graph and policy invariants that a field-level schema cannot express.
 *
 * Zod validates each field in isolation; it cannot tell you that an edge points
 * at an agent that does not exist, or that the mutation policy lets the Watcher
 * widen its own capabilities. Those checks live here.
 */

export type IssueSeverity = "error" | "warning";

export interface ValidationIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  path?: string;
}

export interface ValidationResult {
  issues: ValidationIssue[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  ok: boolean;
}

/** The provider half of `provider/model`. Two agents share a family when equal. */
export function modelFamily(modelId: string): string {
  return modelId.split("/")[0] ?? modelId;
}

export function checkInvariants(genome: ArchitectureGenome): ValidationResult {
  const issues: ValidationIssue[] = [];
  const err = (code: string, message: string, path?: string) =>
    issues.push({ severity: "error", code, message, ...(path ? { path } : {}) });
  const warn = (code: string, message: string, path?: string) =>
    issues.push({ severity: "warning", code, message, ...(path ? { path } : {}) });

  // --- Agents -------------------------------------------------------------
  const ids = new Set<string>();
  for (const [i, agent] of genome.agents.entries()) {
    if (ids.has(agent.id)) {
      err("DUPLICATE_AGENT_ID", `duplicate agent id "${agent.id}"`, `agents[${i}].id`);
    }
    ids.add(agent.id);
  }

  // --- Edges --------------------------------------------------------------
  const seenEdges = new Set<string>();
  for (const [i, edge] of genome.edges.entries()) {
    if (!ids.has(edge.from)) {
      err("EDGE_UNKNOWN_SOURCE", `edge references unknown agent "${edge.from}"`, `edges[${i}].from`);
    }
    if (!ids.has(edge.to)) {
      err("EDGE_UNKNOWN_TARGET", `edge references unknown agent "${edge.to}"`, `edges[${i}].to`);
    }
    if (edge.from === edge.to) {
      // An agent challenging itself produces no independent signal and, for
      // challenge edges specifically, would feed its own output back as peer
      // input — the exact anchoring the protocol exists to prevent.
      err("SELF_EDGE", `agent "${edge.from}" cannot ${edge.interaction} itself`, `edges[${i}]`);
    }
    const key = `${edge.from}->${edge.to}:${edge.interaction}`;
    if (seenEdges.has(key)) {
      warn("DUPLICATE_EDGE", `duplicate edge ${key}`, `edges[${i}]`);
    }
    seenEdges.add(key);
  }

  // --- Synthesis ----------------------------------------------------------
  if (!ids.has(genome.synthesizerId)) {
    err(
      "UNKNOWN_SYNTHESIZER",
      `synthesizerId "${genome.synthesizerId}" is not an agent in this genome`,
      "synthesizerId",
    );
  }

  const synthesizer = genome.agents.find((a) => a.id === genome.synthesizerId);
  if (synthesizer?.proposes) {
    warn(
      "SYNTHESIZER_PROPOSES",
      `synthesizer "${synthesizer.id}" also produces an independent proposal, ` +
        `so synthesis may anchor on its own prior position`,
      "synthesizerId",
    );
  }

  // --- Proposal independence ---------------------------------------------
  const proposers = genome.agents.filter((a) => a.proposes);
  if (proposers.length === 0) {
    err("NO_PROPOSERS", "at least one agent must set proposes: true", "agents");
  }
  if (genome.protocols.crossChallenge && proposers.length < 2) {
    err(
      "CROSS_CHALLENGE_NEEDS_PEERS",
      "crossChallenge requires at least two proposing agents",
      "protocols.crossChallenge",
    );
  }
  if (genome.protocols.crossChallenge && !genome.edges.some((e) => e.interaction === "challenge")) {
    err(
      "NO_CHALLENGE_EDGES",
      "crossChallenge is enabled but no edge has interaction 'challenge'; " +
        "the challenge stage is edge-driven and would be a no-op",
      "edges",
    );
  }

  // --- Cognitive diversity ------------------------------------------------
  const modes = new Set(proposers.map((a) => a.cognitiveMode));
  if (proposers.length > 1 && modes.size === 1) {
    warn(
      "LOW_COGNITIVE_DIVERSITY",
      `all ${proposers.length} proposing agents share cognitiveMode "${[...modes][0]}"; ` +
        `the Watcher scores diversity and will penalize this`,
      "agents",
    );
  }

  if (
    genome.protocols.falsificationRequired &&
    !genome.agents.some((a) => a.cognitiveMode === "adversarial" || a.cognitiveMode === "critical")
  ) {
    warn(
      "NO_ADVERSARIAL_AGENT",
      "falsification is required but no agent is adversarial or critical",
      "agents",
    );
  }

  // --- Watcher self-bias --------------------------------------------------
  if (genome.watcher.enabled && synthesizer) {
    const watcherFamily = modelFamily(genome.watcher.model.primary);
    const synthFamily = modelFamily(synthesizer.model.primary);
    if (watcherFamily === synthFamily) {
      // A Watcher grading a Synthesizer of its own family tends to rate that
      // output generously. Not fatal, but it undermines the evaluation signal
      // the whole evolutionary loop is steered by.
      warn(
        "WATCHER_SHARES_SYNTHESIZER_FAMILY",
        `watcher and synthesizer both use "${watcherFamily}"; ` +
          `a different model family reduces self-bias in evaluation`,
        "watcher.model.primary",
      );
    }
  }

  // --- Mutation policy: privilege escalation ------------------------------
  if (genome.mutationPolicy.enabled && !genome.mutationPolicy.humanApprovalRequired) {
    const escalating = genome.mutationPolicy.allowed.filter((m) =>
      PRIVILEGE_BEARING_MUTATIONS.includes(m),
    );
    if (escalating.length > 0) {
      // This is the configuration that would let the Watcher grant itself
      // capabilities or rewrite its own evaluation config unattended.
      err(
        "UNATTENDED_PRIVILEGE_MUTATION",
        `mutation types ${escalating.join(", ")} can widen the organization's ` +
          `permissions and cannot be allowed while humanApprovalRequired is false`,
        "mutationPolicy",
      );
    }
  }

  if (genome.agents.length > genome.mutationPolicy.maxAgents) {
    err(
      "AGENT_LIMIT_EXCEEDED",
      `genome has ${genome.agents.length} agents but mutationPolicy.maxAgents is ` +
        `${genome.mutationPolicy.maxAgents}`,
      "mutationPolicy.maxAgents",
    );
  }

  // --- Memory policy coherence -------------------------------------------
  const writers = genome.agents.filter((a) => a.capabilities.includes("memory_write"));
  if (writers.length > 0 && genome.memoryPolicy.writeScopes.length === 0) {
    warn(
      "MEMORY_WRITE_WITHOUT_SCOPE",
      `${writers.length} agent(s) hold memory_write but memoryPolicy.writeScopes is empty`,
      "memoryPolicy.writeScopes",
    );
  }
  if (genome.memoryPolicy.minSimilarity >= genome.memoryPolicy.noveltyThreshold) {
    warn(
      "MEMORY_THRESHOLDS_INVERTED",
      `minSimilarity (${genome.memoryPolicy.minSimilarity}) >= noveltyThreshold ` +
        `(${genome.memoryPolicy.noveltyThreshold}): every recalled memory would count as a duplicate`,
      "memoryPolicy",
    );
  }

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return { issues, errors, warnings, ok: errors.length === 0 };
}

export interface ParseOptions {
  /** Promote warnings to errors. Use for genomes produced by mutation. */
  strict?: boolean;
}

/**
 * Parse, normalize, and validate a genome.
 *
 * Normalization matters as much as validation: defaults are applied here, so a
 * genome that omits `temperature` and one that states the default explicitly
 * produce the same normalized body and therefore the same content hash.
 */
export function parseGenome(
  input: ArchitectureGenomeInput | unknown,
  options: ParseOptions = {},
): ArchitectureGenome {
  const parsed = ArchitectureGenomeSchema.safeParse(input);
  if (!parsed.success) {
    throw new GenomeValidationError("genome failed schema validation", {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
        code: i.code,
      })),
    });
  }

  const result = checkInvariants(parsed.data);
  const fatal = options.strict ? result.issues : result.errors;
  if (fatal.length > 0) {
    throw new GenomeValidationError("genome failed invariant validation", {
      issues: fatal,
    });
  }
  return parsed.data;
}

/** Non-throwing variant, for editors and API validation endpoints. */
export function validateGenome(
  input: unknown,
  options: ParseOptions = {},
): { ok: true; genome: ArchitectureGenome; warnings: ValidationIssue[] } | { ok: false; issues: ValidationIssue[] } {
  const parsed = ArchitectureGenomeSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        severity: "error" as const,
        code: `SCHEMA_${i.code.toUpperCase()}`,
        message: i.message,
        path: i.path.join("."),
      })),
    };
  }

  const result = checkInvariants(parsed.data);
  if (!result.ok || (options.strict && result.warnings.length > 0)) {
    return { ok: false, issues: options.strict ? result.issues : result.errors };
  }
  return { ok: true, genome: parsed.data, warnings: result.warnings };
}
