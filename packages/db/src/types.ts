/** Row shapes as returned by the driver. NUMERIC columns arrive as strings. */

export type Role = "OWNER" | "ADMIN" | "ARCHITECT" | "OPERATOR" | "VIEWER";
export type Visibility = "private" | "public";

export type RunStatus =
  | "PENDING"
  | "RUNNING"
  | "AWAITING_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "STOPPED";

export type StepStatus = "RUNNING" | "COMPLETED" | "FAILED";
export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED";
export type GenomeOrigin = "SEED" | "MUTATION" | "BREEDING" | "FORK" | "MANUAL";
export type MutationStatus = "PROPOSED" | "APPROVED" | "REJECTED" | "APPLIED";
export type ProposedBy = "WATCHER" | "HUMAN" | "BREEDING";

export type ArtifactKind =
  | "CONTEXT"
  | "PROPOSAL"
  | "CHALLENGE"
  | "FALSIFICATION"
  | "SYNTHESIS"
  | "WATCHER";

/**
 * Memory scopes are disjoint by construction. `knowledge` is what the ecosystem
 * learned about the world and feeds agent context; `evolutionary` is what it
 * learned about itself and feeds only the mutation engine and the genome
 * recommender. The database CHECK constraint enforces the type/scope pairing.
 */
export type KnowledgeMemoryType = "FACT" | "HYPOTHESIS" | "FAILED_APPROACH" | "USER_PREFERENCE";
export type EvolutionaryMemoryType =
  | "STRUCTURAL_LEARNING"
  | "BENCHMARK_RESULT"
  | "MUTATION_OUTCOME";

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  created_at: Date;
}

export interface WorkspaceRow {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  created_at: Date;
}

export interface UserRow {
  id: string;
  external_id: string | null;
  email: string;
  name: string | null;
  created_at: Date;
}

export interface EcosystemRow {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  visibility: Visibility;
  current_genome_version_id: string | null;
  forked_from_ecosystem_id: string | null;
  forked_from_version_id: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface GenomeVersionRow {
  id: string;
  ecosystem_id: string;
  version: number;
  genome_hash: string;
  genome: unknown;
  parent_ids: string[];
  origin: GenomeOrigin;
  created_by: string | null;
  created_at: Date;
}

export interface RunRow {
  id: string;
  ecosystem_id: string;
  genome_version_id: string;
  objective: string;
  status: RunStatus;
  stage: string;
  iteration: number;
  seed: string;
  input_tokens: string;
  output_tokens: string;
  cost_usd: string;
  result: unknown;
  error: unknown;
  created_by: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface RunStepRow {
  id: string;
  run_id: string;
  step_key: string;
  iteration: number;
  stage: string;
  unit_id: string;
  status: StepStatus;
  input_hash: string;
  output: unknown;
  attempt: number;
  latency_ms: number | null;
  error: unknown;
  /** Worker holding this step. Only the holder may write its result. */
  owner_token: string | null;
  /** When the claim lapses and another worker may take over. */
  lease_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ApprovalRow {
  id: string;
  run_id: string;
  iteration: number;
  stage: string;
  payload: unknown;
  status: ApprovalStatus;
  note: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  created_at: Date;
}

export interface AgentArtifactRow {
  id: string;
  run_id: string;
  iteration: number;
  stage: string;
  agent_id: string | null;
  kind: ArtifactKind;
  content: unknown;
  model_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: string;
  latency_ms: number | null;
  parent_artifact_ids: string[];
  created_at: Date;
}

export interface MutationRow {
  id: string;
  ecosystem_id: string;
  run_id: string | null;
  from_version_id: string;
  to_version_id: string | null;
  patches: unknown;
  rationale: string | null;
  proposed_by: ProposedBy;
  status: MutationStatus;
  rejection_reason: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  created_at: Date;
}

export interface MemoryRow {
  id: string;
  ecosystem_id: string;
  scope: "knowledge" | "evolutionary";
  type: KnowledgeMemoryType | EvolutionaryMemoryType;
  content: string;
  importance: number;
  confidence: number;
  problem_class: string | null;
  genome_version_id: string | null;
  source_run_id: string | null;
  source_artifact_ids: string[];
  supersedes_id: string | null;
  contradicts_ids: string[];
  access_count: number;
  last_accessed_at: Date | null;
  created_at: Date;
  expires_at: Date | null;
}

export interface EvaluationRow {
  id: string;
  run_id: string;
  genome_version_id: string;
  iteration: number;
  scores: unknown;
  failure_modes: unknown;
  suggested_mutations: unknown;
  recommendation: "continue" | "mutate" | "human_review" | "stop";
  model_id: string | null;
  cost_usd: string;
  created_at: Date;
}

export interface BenchmarkResultRow {
  id: string;
  benchmark_id: string;
  ecosystem_id: string;
  genome_version_id: string;
  run_id: string | null;
  task_id: string;
  scores: unknown;
  overall_score: string;
  cost_usd: string;
  efficiency: string | null;
  total_tokens: string;
  created_at: Date;
}
