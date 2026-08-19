-- Tenant erasure without weakening immutability.
--
-- The append-only trigger on genome_versions blocks DELETE as well as UPDATE,
-- which is correct for its purpose and also makes deleting an organization
-- impossible: the cascade from organizations → workspaces → ecosystems →
-- genome_versions is refused. That is a data-retention problem, not a feature —
-- an operator must be able to erase a tenant on request.
--
-- The fix keeps the guarantee and adds a deliberate, auditable escape hatch.
-- UPDATE remains unconditionally forbidden: a genome version's content can
-- never change, which is the property content addressing depends on. DELETE is
-- permitted only inside a transaction that has explicitly opted in by setting
-- `meta.allow_purge`, so an accidental or careless delete still fails, and the
-- opt-in is visible in the code path performing it.

CREATE OR REPLACE FUNCTION forbid_row_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND coalesce(current_setting('meta.allow_purge', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION '% is append-only; % is forbidden', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'To erase a tenant, run the delete inside a transaction that '
                 'has executed: SET LOCAL meta.allow_purge = ''on''';
END;
$$;
