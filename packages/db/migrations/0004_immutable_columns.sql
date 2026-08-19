-- State precisely which columns are immutable.
--
-- The original trigger forbade every UPDATE on genome_versions, which is
-- stricter than the guarantee actually requires and had a consequence nobody
-- intended: `created_by` carries ON DELETE SET NULL, and SET NULL is an UPDATE,
-- so that referential action could never fire. Deleting a user who had authored
-- any genome version was therefore impossible — the FK was unsatisfiable.
--
-- What must never change is the *identity* of a version: its content, its
-- content hash, its position in the lineage. None of that includes who created
-- it. Attribution is metadata about the row, is not part of the hashed body,
-- and nulling it on user erasure cannot affect content addressing.
--
-- So the trigger now compares the columns that define identity and rejects any
-- update that touches one, while permitting an update that changes only
-- attribution. This is a tighter statement of the same guarantee, not a
-- weakening of it: the previous rule blocked strictly more, including things it
-- had no reason to block.

CREATE OR REPLACE FUNCTION forbid_row_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('meta.allow_purge', true), 'off') = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION '% is append-only; DELETE is forbidden', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation',
            HINT = 'To erase a tenant, run the delete inside a transaction that '
                   'has executed: SET LOCAL meta.allow_purge = ''on''';
  END IF;

  -- UPDATE: identity columns must be untouched.
  IF NEW.id             IS DISTINCT FROM OLD.id
     OR NEW.ecosystem_id IS DISTINCT FROM OLD.ecosystem_id
     OR NEW.version      IS DISTINCT FROM OLD.version
     OR NEW.genome_hash  IS DISTINCT FROM OLD.genome_hash
     OR NEW.genome       IS DISTINCT FROM OLD.genome
     OR NEW.parent_ids   IS DISTINCT FROM OLD.parent_ids
     OR NEW.origin       IS DISTINCT FROM OLD.origin
     OR NEW.created_at   IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'genome_versions is append-only; its content and lineage cannot change'
      USING ERRCODE = 'restrict_violation',
            HINT = 'Create a new version instead of modifying an existing one.';
  END IF;

  RETURN NEW;
END;
$$;
