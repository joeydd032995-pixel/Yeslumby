import type { Sql } from "../client.js";
import type { OrganizationRow, Role, UserRow, WorkspaceRow } from "../types.js";

export async function createOrganization(
  sql: Sql,
  input: { id: string; name: string; slug: string },
): Promise<OrganizationRow> {
  const [row] = await sql<OrganizationRow[]>`
    INSERT INTO organizations (id, name, slug)
    VALUES (${input.id}, ${input.name}, ${input.slug})
    RETURNING *
  `;
  if (!row) throw new Error("organization insert returned no row");
  return row;
}

export async function createUser(
  sql: Sql,
  input: { id: string; email: string; name?: string | null; externalId?: string | null },
): Promise<UserRow> {
  const [row] = await sql<UserRow[]>`
    INSERT INTO users (id, email, name, external_id)
    VALUES (${input.id}, ${input.email}, ${input.name ?? null}, ${input.externalId ?? null})
    RETURNING *
  `;
  if (!row) throw new Error("user insert returned no row");
  return row;
}

export async function findUserByExternalId(
  sql: Sql,
  externalId: string,
): Promise<UserRow | undefined> {
  const [row] = await sql<UserRow[]>`SELECT * FROM users WHERE external_id = ${externalId}`;
  return row;
}

export async function createWorkspace(
  sql: Sql,
  input: { id: string; orgId: string; name: string; slug: string },
): Promise<WorkspaceRow> {
  const [row] = await sql<WorkspaceRow[]>`
    INSERT INTO workspaces (id, org_id, name, slug)
    VALUES (${input.id}, ${input.orgId}, ${input.name}, ${input.slug})
    RETURNING *
  `;
  if (!row) throw new Error("workspace insert returned no row");
  return row;
}

export async function addMembership(
  sql: Sql,
  input: { id: string; orgId: string; userId: string; role: Role },
): Promise<void> {
  await sql`
    INSERT INTO memberships (id, org_id, user_id, role)
    VALUES (${input.id}, ${input.orgId}, ${input.userId}, ${input.role})
    ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role
  `;
}

export async function getRole(
  sql: Sql,
  orgId: string,
  userId: string,
): Promise<Role | undefined> {
  const [row] = await sql<{ role: Role }[]>`
    SELECT role FROM memberships WHERE org_id = ${orgId} AND user_id = ${userId}
  `;
  return row?.role;
}

/** Resolve the owning organization of a workspace-scoped resource. */
export async function getOrgIdForEcosystem(
  sql: Sql,
  ecosystemId: string,
): Promise<string | undefined> {
  const [row] = await sql<{ org_id: string }[]>`
    SELECT w.org_id FROM ecosystems e
    JOIN workspaces w ON w.id = e.workspace_id
    WHERE e.id = ${ecosystemId}
  `;
  return row?.org_id;
}

export async function writeAuditEntry(
  sql: Sql,
  input: {
    id: string;
    orgId: string | null;
    actorUserId?: string | null;
    actorKind?: "user" | "system" | "watcher" | "api";
    action: string;
    subjectType: string;
    subjectId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await sql`
    INSERT INTO audit_log
      (id, org_id, actor_user_id, actor_kind, action, subject_type, subject_id, metadata)
    VALUES (
      ${input.id}, ${input.orgId}, ${input.actorUserId ?? null},
      ${input.actorKind ?? "user"}, ${input.action}, ${input.subjectType},
      ${input.subjectId ?? null}, ${sql.json((input.metadata ?? {}) as never)}
    )
  `;
}

export async function listAuditEntries(
  sql: Sql,
  orgId: string,
  limit = 100,
): Promise<Array<Record<string, unknown>>> {
  return sql<Array<Record<string, unknown>>>`
    SELECT * FROM audit_log WHERE org_id = ${orgId}
    ORDER BY created_at DESC LIMIT ${limit}
  `;
}
