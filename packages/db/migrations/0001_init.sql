-- Meta-Ecosystem core schema.
--
-- Two invariants from the product spec are enforced here, in the database,
-- rather than in application code that a future caller could bypass:
--
--   1. Genome versions are append-only. A trigger rejects UPDATE and DELETE, so
--      "never overwrite a genome version" holds even against a direct psql
--      session. Anything genuinely mutable (a benchmark score, the pointer to
--      an ecosystem's current version) therefore lives outside the row.
--
--   2. Knowledge memory and evolutionary memory cannot be confused. A CHECK
--      constraint ties each memory `scope` to the exact set of `type` values
--      legal within it, so a STRUCTURAL_LEARNING can never be filed where an
--      agent's context builder would read it.

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------

CREATE TABLE organizations (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id           text PRIMARY KEY,
  external_id  text UNIQUE,            -- subject id from the auth provider (e.g. Clerk)
  email        text NOT NULL,
  name         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  slug        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

CREATE TABLE memberships (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('OWNER','ADMIN','ARCHITECT','OPERATOR','VIEWER')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

CREATE INDEX memberships_user_idx ON memberships (user_id);

-- ---------------------------------------------------------------------------
-- Ecosystems and genome versions
-- ---------------------------------------------------------------------------

CREATE TABLE ecosystems (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  slug          text NOT NULL,
  description   text,
  visibility    text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  -- Set after the seed genome is written; mutable by design.
  current_genome_version_id text,
  -- Forking keeps permanent lineage to the source ecosystem.
  forked_from_ecosystem_id  text REFERENCES ecosystems(id) ON DELETE SET NULL,
  forked_from_version_id    text,
  created_by    text REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug)
);

CREATE INDEX ecosystems_public_idx ON ecosystems (visibility) WHERE visibility = 'public';

CREATE TABLE genome_versions (
  id            text PRIMARY KEY,
  ecosystem_id  text NOT NULL REFERENCES ecosystems(id) ON DELETE CASCADE,
  version       integer NOT NULL,
  -- sha256 over the canonical JSON of the genome body. Content address.
  genome_hash   text NOT NULL,
  genome        jsonb NOT NULL,
  -- Multiple parents represent breeding; one parent, a mutation; none, a seed.
  parent_ids    text[] NOT NULL DEFAULT '{}',
  origin        text NOT NULL CHECK (origin IN ('SEED','MUTATION','BREEDING','FORK','MANUAL')),
  created_by    text REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ecosystem_id, version),
  -- The same genome content is stored once per ecosystem; re-deriving it
  -- returns the existing version instead of forking the lineage.
  UNIQUE (ecosystem_id, genome_hash)
);

CREATE INDEX genome_versions_ecosystem_idx ON genome_versions (ecosystem_id, version DESC);

ALTER TABLE ecosystems
  ADD CONSTRAINT ecosystems_current_version_fk
  FOREIGN KEY (current_genome_version_id) REFERENCES genome_versions(id) ON DELETE SET NULL;

-- Append-only enforcement. See header note (1).
CREATE FUNCTION forbid_row_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is forbidden', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER genome_versions_append_only
  BEFORE UPDATE OR DELETE ON genome_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_row_mutation();

-- ---------------------------------------------------------------------------
-- Runs and the durable step journal
-- ---------------------------------------------------------------------------

CREATE TABLE runs (
  id                text PRIMARY KEY,
  ecosystem_id      text NOT NULL REFERENCES ecosystems(id) ON DELETE CASCADE,
  genome_version_id text NOT NULL REFERENCES genome_versions(id) ON DELETE RESTRICT,
  objective         text NOT NULL,
  status            text NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','RUNNING','AWAITING_APPROVAL','COMPLETED','FAILED','STOPPED')),
  stage             text NOT NULL DEFAULT 'CONTEXT',
  iteration         integer NOT NULL DEFAULT 0,
  -- Seed for all pseudo-randomness in this run. Replaying a run means reusing it.
  seed              text NOT NULL,
  input_tokens      bigint NOT NULL DEFAULT 0,
  output_tokens     bigint NOT NULL DEFAULT 0,
  cost_usd          numeric(20,10) NOT NULL DEFAULT 0,
  result            jsonb,
  error             jsonb,
  created_by        text REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz
);

CREATE INDEX runs_ecosystem_idx ON runs (ecosystem_id, created_at DESC);
CREATE INDEX runs_genome_version_idx ON runs (genome_version_id);
CREATE INDEX runs_active_idx ON runs (status) WHERE status IN ('RUNNING','AWAITING_APPROVAL');

-- One row per durable unit of work. `step_key` is derived deterministically
-- from (run, iteration, stage, unit), which is what makes replay idempotent.
CREATE TABLE run_steps (
  id          bigserial PRIMARY KEY,
  run_id      text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_key    text NOT NULL,
  iteration   integer NOT NULL,
  stage       text NOT NULL,
  unit_id     text NOT NULL DEFAULT 'stage',
  status      text NOT NULL DEFAULT 'RUNNING'
                CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  -- Hash of the step's inputs. A completed row whose input_hash no longer
  -- matches is stale and is recomputed rather than replayed.
  input_hash  text NOT NULL,
  output      jsonb,
  attempt     integer NOT NULL DEFAULT 1,
  latency_ms  integer,
  error       jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_key)
);

CREATE INDEX run_steps_run_idx ON run_steps (run_id, iteration, stage);

-- Human approval gates. The run parks here and resumes from the journal.
CREATE TABLE approvals (
  id          text PRIMARY KEY,
  run_id      text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  iteration   integer NOT NULL,
  stage       text NOT NULL,
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  note        text,
  decided_by  text REFERENCES users(id) ON DELETE SET NULL,
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, iteration, stage)
);

CREATE INDEX approvals_pending_idx ON approvals (status) WHERE status = 'PENDING';

-- ---------------------------------------------------------------------------
-- Agent artifacts (provenance backbone)
-- ---------------------------------------------------------------------------

CREATE TABLE agent_artifacts (
  id             text PRIMARY KEY,
  run_id         text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  iteration      integer NOT NULL,
  stage          text NOT NULL,
  agent_id       text,                 -- null for whole-stage artifacts
  kind           text NOT NULL CHECK (kind IN
                   ('CONTEXT','PROPOSAL','CHALLENGE','FALSIFICATION','SYNTHESIS','WATCHER')),
  content        jsonb NOT NULL,
  model_id       text,
  input_tokens   integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,
  cost_usd       numeric(20,10) NOT NULL DEFAULT 0,
  latency_ms     integer,
  -- Edges of the argument graph: which artifacts this one was derived from.
  -- traceClaim() walks these back to raw evidence.
  parent_artifact_ids text[] NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_artifacts_run_idx ON agent_artifacts (run_id, iteration, stage);
CREATE INDEX agent_artifacts_agent_idx ON agent_artifacts (run_id, agent_id);

-- ---------------------------------------------------------------------------
-- Mutations
-- ---------------------------------------------------------------------------

CREATE TABLE mutations (
  id                text PRIMARY KEY,
  ecosystem_id      text NOT NULL REFERENCES ecosystems(id) ON DELETE CASCADE,
  run_id            text REFERENCES runs(id) ON DELETE SET NULL,
  from_version_id   text NOT NULL REFERENCES genome_versions(id) ON DELETE RESTRICT,
  to_version_id     text REFERENCES genome_versions(id) ON DELETE SET NULL,
  patches           jsonb NOT NULL,
  rationale         text,
  proposed_by       text NOT NULL CHECK (proposed_by IN ('WATCHER','HUMAN','BREEDING')),
  status            text NOT NULL DEFAULT 'PROPOSED'
                      CHECK (status IN ('PROPOSED','APPROVED','REJECTED','APPLIED')),
  rejection_reason  text,
  approved_by       text REFERENCES users(id) ON DELETE SET NULL,
  approved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mutations_ecosystem_idx ON mutations (ecosystem_id, created_at DESC);
CREATE INDEX mutations_from_version_idx ON mutations (from_version_id);

-- ---------------------------------------------------------------------------
-- Memory: knowledge vs evolutionary. See header note (2).
-- ---------------------------------------------------------------------------

CREATE TABLE memories (
  id              text PRIMARY KEY,
  ecosystem_id    text NOT NULL REFERENCES ecosystems(id) ON DELETE CASCADE,
  scope           text NOT NULL CHECK (scope IN ('knowledge','evolutionary')),
  type            text NOT NULL,
  content         text NOT NULL,
  embedding       vector(1536),
  importance      real NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  confidence      real NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  -- Evolutionary memory answers "which structures work for which problems", so
  -- it is keyed by problem class and the genome version it was learned from.
  problem_class   text,
  genome_version_id text REFERENCES genome_versions(id) ON DELETE SET NULL,
  source_run_id   text REFERENCES runs(id) ON DELETE SET NULL,
  source_artifact_ids text[] NOT NULL DEFAULT '{}',
  supersedes_id   text REFERENCES memories(id) ON DELETE SET NULL,
  contradicts_ids text[] NOT NULL DEFAULT '{}',
  access_count    integer NOT NULL DEFAULT 0,
  last_accessed_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,

  -- The structural separation of the three memories, enforced by the database.
  CONSTRAINT memories_scope_type_valid CHECK (
    (scope = 'knowledge'
      AND type IN ('FACT','HYPOTHESIS','FAILED_APPROACH','USER_PREFERENCE'))
    OR
    (scope = 'evolutionary'
      AND type IN ('STRUCTURAL_LEARNING','BENCHMARK_RESULT','MUTATION_OUTCOME'))
  )
);

CREATE INDEX memories_lookup_idx ON memories (ecosystem_id, scope, type);
CREATE INDEX memories_problem_class_idx ON memories (problem_class) WHERE problem_class IS NOT NULL;

-- IVFFlat needs training data to be worth building; at low row counts Postgres
-- sequential-scans anyway. HNSW works from the first row, so prefer it.
CREATE INDEX memories_embedding_idx ON memories
  USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Evaluations (Watcher output), telemetry, benchmarks
-- ---------------------------------------------------------------------------

CREATE TABLE evaluations (
  id                 text PRIMARY KEY,
  run_id             text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  genome_version_id  text NOT NULL REFERENCES genome_versions(id) ON DELETE CASCADE,
  iteration          integer NOT NULL DEFAULT 0,
  -- {diversity, challengeQuality, independence, evidenceQuality, efficiency, overall}
  scores             jsonb NOT NULL,
  failure_modes      jsonb NOT NULL DEFAULT '[]',
  suggested_mutations jsonb NOT NULL DEFAULT '[]',
  recommendation     text NOT NULL
                       CHECK (recommendation IN ('continue','mutate','human_review','stop')),
  model_id           text,
  cost_usd           numeric(20,10) NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX evaluations_version_idx ON evaluations (genome_version_id);

CREATE TABLE usage_events (
  id                 text PRIMARY KEY,
  org_id             text REFERENCES organizations(id) ON DELETE SET NULL,
  workspace_id       text REFERENCES workspaces(id) ON DELETE SET NULL,
  ecosystem_id       text REFERENCES ecosystems(id) ON DELETE SET NULL,
  run_id             text REFERENCES runs(id) ON DELETE SET NULL,
  artifact_id        text,
  agent_id           text,
  stage              text,
  model_id           text NOT NULL,
  provider           text,
  input_tokens       integer NOT NULL DEFAULT 0,
  output_tokens      integer NOT NULL DEFAULT 0,
  cached_input_tokens integer NOT NULL DEFAULT 0,
  cost_usd           numeric(20,10) NOT NULL DEFAULT 0,
  unpriced           boolean NOT NULL DEFAULT false,
  latency_ms         integer,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX usage_events_billing_idx ON usage_events (org_id, created_at DESC);
CREATE INDEX usage_events_run_idx ON usage_events (run_id);

CREATE TABLE benchmarks (
  id            text PRIMARY KEY,
  workspace_id  text REFERENCES workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  slug          text NOT NULL,
  description   text,
  tasks         jsonb NOT NULL,     -- [{ id, objective, problemClass, rubric }]
  scoring       jsonb NOT NULL,     -- { dimensions: [{ key, weight }] }
  visibility    text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug)
);

CREATE TABLE benchmark_results (
  id                 text PRIMARY KEY,
  benchmark_id       text NOT NULL REFERENCES benchmarks(id) ON DELETE CASCADE,
  ecosystem_id       text NOT NULL REFERENCES ecosystems(id) ON DELETE CASCADE,
  genome_version_id  text NOT NULL REFERENCES genome_versions(id) ON DELETE CASCADE,
  run_id             text REFERENCES runs(id) ON DELETE SET NULL,
  task_id            text NOT NULL,
  scores             jsonb NOT NULL,
  overall_score      numeric(10,6) NOT NULL,
  cost_usd           numeric(20,10) NOT NULL DEFAULT 0,
  -- score / cost. NULL for free runs so they cannot dominate a leaderboard.
  efficiency         numeric(20,6),
  total_tokens       bigint NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX benchmark_results_version_idx ON benchmark_results (genome_version_id);
CREATE INDEX benchmark_results_ranking_idx
  ON benchmark_results (benchmark_id, task_id, overall_score DESC);

CREATE TABLE audit_log (
  id            text PRIMARY KEY,
  org_id        text REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  actor_kind    text NOT NULL DEFAULT 'user' CHECK (actor_kind IN ('user','system','watcher','api')),
  action        text NOT NULL,
  subject_type  text NOT NULL,
  subject_id    text,
  metadata      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_org_idx ON audit_log (org_id, created_at DESC);
CREATE INDEX audit_log_subject_idx ON audit_log (subject_type, subject_id);
