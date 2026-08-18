import { randomUUID } from "node:crypto";

/**
 * Branded identifiers.
 *
 * This system threads many string ids through the same function signatures — a
 * run id, a genome version id, an agent id and an artifact id are all strings.
 * Branding makes swapping two of them a compile error rather than a silent
 * lookup miss at runtime.
 */
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type OrganizationId = Brand<string, "OrganizationId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type UserId = Brand<string, "UserId">;
export type EcosystemId = Brand<string, "EcosystemId">;
export type GenomeVersionId = Brand<string, "GenomeVersionId">;
export type RunId = Brand<string, "RunId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type MutationId = Brand<string, "MutationId">;
export type MemoryId = Brand<string, "MemoryId">;
export type BenchmarkId = Brand<string, "BenchmarkId">;
export type BenchmarkResultId = Brand<string, "BenchmarkResultId">;
export type UsageEventId = Brand<string, "UsageEventId">;
export type EvaluationId = Brand<string, "EvaluationId">;
export type AuditEntryId = Brand<string, "AuditEntryId">;

/** Agent ids are authored inside a genome, so they are plain slugs, not generated. */
export type AgentId = Brand<string, "AgentId">;

export const asAgentId = (value: string): AgentId => value as AgentId;

const PREFIXES = {
  org: "org",
  workspace: "ws",
  user: "usr",
  ecosystem: "eco",
  genomeVersion: "gv",
  run: "run",
  artifact: "art",
  mutation: "mut",
  memory: "mem",
  benchmark: "bm",
  benchmarkResult: "bmr",
  usageEvent: "ue",
  evaluation: "ev",
  auditEntry: "aud",
} as const;

export type IdKind = keyof typeof PREFIXES;

/**
 * Id allocation as an injected capability, for the same reason as {@link Clock}:
 * ids appear in content-addressed artifacts, so a reproducible run needs
 * reproducible ids.
 */
export interface IdGenerator {
  next(kind: IdKind): string;
}

export const randomIds: IdGenerator = {
  next: (kind) => `${PREFIXES[kind]}_${randomUUID().replace(/-/g, "")}`,
};

/** Monotonic per-kind counters, so ids are stable across identical runs. */
export class DeterministicIds implements IdGenerator {
  readonly #counters = new Map<IdKind, number>();

  constructor(private readonly namespace = "t") {}

  next(kind: IdKind): string {
    const n = (this.#counters.get(kind) ?? 0) + 1;
    this.#counters.set(kind, n);
    return `${PREFIXES[kind]}_${this.namespace}${String(n).padStart(6, "0")}`;
  }
}
