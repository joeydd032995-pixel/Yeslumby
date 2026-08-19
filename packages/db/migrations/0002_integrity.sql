-- Integrity fixes surfaced in review of the initial schema.
--
-- Three distinct problems, all of which the first migration left to
-- application code that could not actually enforce them.

-- 1. A run could reference a genome version owned by a *different* ecosystem.
--    Two independent foreign keys constrain each column separately but say
--    nothing about the pair, so a mismatched write would execute one tenant's
--    genome under another tenant's run. The composite key makes the pairing
--    itself the constraint.
ALTER TABLE genome_versions
  ADD CONSTRAINT genome_versions_id_ecosystem_key UNIQUE (id, ecosystem_id);

ALTER TABLE runs
  ADD CONSTRAINT runs_version_belongs_to_ecosystem
  FOREIGN KEY (genome_version_id, ecosystem_id)
  REFERENCES genome_versions (id, ecosystem_id)
  ON DELETE RESTRICT;

-- 2. Replaying a completed round re-inserted its evaluation under a fresh id,
--    silently duplicating evaluation history and biasing any analysis over it.
--    One evaluation per (run, iteration) is the real logical key.
DELETE FROM evaluations e
USING evaluations keep
WHERE e.run_id = keep.run_id
  AND e.iteration = keep.iteration
  AND e.created_at > keep.created_at;

ALTER TABLE evaluations
  ADD CONSTRAINT evaluations_run_iteration_key UNIQUE (run_id, iteration);

-- 3. Step ownership. Without a lease, two workers entering the same unclaimed
--    step both saw a RUNNING row and both proceeded, so the "no model call is
--    repeated" guarantee held only for a single process. The owner token
--    identifies who holds the step; the lease lets a step whose worker died be
--    reclaimed rather than blocking the run forever.
ALTER TABLE run_steps
  ADD COLUMN owner_token text,
  ADD COLUMN lease_expires_at timestamptz;

CREATE INDEX run_steps_lease_idx ON run_steps (lease_expires_at)
  WHERE status = 'RUNNING';
