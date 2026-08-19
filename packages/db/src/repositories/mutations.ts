import type { Sql } from "../client.js";
import type { MutationRow, MutationStatus, ProposedBy } from "../types.js";

export async function proposeMutation(
  sql: Sql,
  input: {
    id: string;
    ecosystemId: string;
    runId?: string | null;
    fromVersionId: string;
    patches: unknown;
    rationale?: string | null;
    proposedBy: ProposedBy;
    /** Pre-approved proposals (e.g. policy allows unattended mutation). */
    status?: MutationStatus;
  },
): Promise<MutationRow> {
  const [row] = await sql<MutationRow[]>`
    INSERT INTO mutations
      (id, ecosystem_id, run_id, from_version_id, patches, rationale, proposed_by, status)
    VALUES (
      ${input.id}, ${input.ecosystemId}, ${input.runId ?? null}, ${input.fromVersionId},
      ${sql.json(input.patches as never)}, ${input.rationale ?? null},
      ${input.proposedBy}, ${input.status ?? "PROPOSED"}
    )
    RETURNING *
  `;
  if (!row) throw new Error("mutation insert returned no row");
  return row;
}

export async function markMutationApplied(
  sql: Sql,
  id: string,
  toVersionId: string,
): Promise<void> {
  await sql`
    UPDATE mutations SET status = 'APPLIED', to_version_id = ${toVersionId} WHERE id = ${id}
  `;
}

export async function rejectMutation(sql: Sql, id: string, reason: string): Promise<void> {
  await sql`
    UPDATE mutations SET status = 'REJECTED', rejection_reason = ${reason} WHERE id = ${id}
  `;
}

export async function approveMutation(
  sql: Sql,
  id: string,
  approvedBy: string | null,
): Promise<void> {
  await sql`
    UPDATE mutations
    SET status = 'APPROVED', approved_by = ${approvedBy}, approved_at = now()
    WHERE id = ${id} AND status = 'PROPOSED'
  `;
}

export async function getMutation(sql: Sql, id: string): Promise<MutationRow | undefined> {
  const [row] = await sql<MutationRow[]>`SELECT * FROM mutations WHERE id = ${id}`;
  return row;
}

export async function listMutations(
  sql: Sql,
  ecosystemId: string,
  limit = 100,
): Promise<MutationRow[]> {
  return sql<MutationRow[]>`
    SELECT * FROM mutations WHERE ecosystem_id = ${ecosystemId}
    ORDER BY created_at DESC LIMIT ${limit}
  `;
}
