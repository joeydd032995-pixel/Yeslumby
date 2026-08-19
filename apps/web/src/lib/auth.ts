import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { tenancy, type Role } from "@meta/db";
import { db } from "./db.js";

/**
 * Authentication, behind a port.
 *
 * The multi-tenant model — organizations, workspaces, memberships, five roles —
 * is real, tested, and enforced. What is provisional is only *who says you are
 * you*: this development provider issues a signed cookie over the seeded users
 * table, and a Clerk adapter implementing the same `resolveIdentity` contract
 * takes over when credentials exist. Nothing downstream of `getSession` knows
 * or cares which one answered.
 *
 * The session cookie is signed, not encrypted. It carries a user id and no
 * secrets, and the signature is what stops a client editing it to become
 * someone else.
 */

const COOKIE = "meta_session";

function secret(): string {
  const value = process.env.SESSION_SECRET ?? "dev-only-insecure-secret";
  if (process.env.NODE_ENV === "production" && value === "dev-only-insecure-secret") {
    throw new Error("SESSION_SECRET must be set outside development");
  }
  return value;
}

function sign(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("hex");
}

export function encodeSession(userId: string): string {
  return `${userId}.${sign(userId)}`;
}

/** Constant-time verification, so the signature cannot be probed byte by byte. */
export function decodeSession(token: string | undefined): string | undefined {
  if (!token) return undefined;
  const index = token.lastIndexOf(".");
  if (index <= 0) return undefined;

  const userId = token.slice(0, index);
  const provided = Buffer.from(token.slice(index + 1), "utf8");
  const expected = Buffer.from(sign(userId), "utf8");
  if (provided.length !== expected.length) return undefined;
  return timingSafeEqual(provided, expected) ? userId : undefined;
}

export interface Session {
  userId: string;
  email: string;
  name: string | null;
  orgId: string;
  workspaceId: string;
  role: Role;
}

/** The current session, or undefined when signed out. */
export async function getSession(): Promise<Session | undefined> {
  const store = await cookies();
  const userId = decodeSession(store.get(COOKIE)?.value);
  if (!userId) return undefined;

  const sql = db();
  const [row] = await sql<
    Array<{
      id: string;
      email: string;
      name: string | null;
      org_id: string;
      role: Role;
      workspace_id: string;
    }>
  >`
    SELECT u.id, u.email, u.name, m.org_id, m.role, w.id AS workspace_id
    FROM users u
    JOIN memberships m ON m.user_id = u.id
    JOIN workspaces w ON w.org_id = m.org_id
    WHERE u.id = ${userId}
    ORDER BY w.created_at ASC
    LIMIT 1
  `;
  if (!row) return undefined;

  return {
    userId: row.id,
    email: row.email,
    name: row.name,
    orgId: row.org_id,
    workspaceId: row.workspace_id,
    role: row.role,
  };
}

export const COOKIE_NAME = COOKIE;

/**
 * Role ordering, most privileged first.
 *
 * VIEWER can read. OPERATOR can start runs. ARCHITECT can change genomes and
 * approve mutations. ADMIN and OWNER add tenancy management. Each level
 * includes everything below it.
 */
const RANK: Record<Role, number> = {
  OWNER: 5,
  ADMIN: 4,
  ARCHITECT: 3,
  OPERATOR: 2,
  VIEWER: 1,
};

export function hasRole(actual: Role, required: Role): boolean {
  return RANK[actual] >= RANK[required];
}

export class AccessDenied extends Error {
  constructor(readonly required: Role) {
    super(`requires ${required}`);
    this.name = "AccessDenied";
  }
}

/** Assert the session may act at `required`, else throw. */
export function requireRole(session: Session | undefined, required: Role): Session {
  if (!session) throw new AccessDenied(required);
  if (!hasRole(session.role, required)) throw new AccessDenied(required);
  return session;
}

/**
 * Confirm an ecosystem belongs to the session's organization.
 *
 * Route params are user input: without this an id from another tenant would be
 * read straight out of the database. Membership is re-checked against the
 * ecosystem's own org rather than trusted from the session alone.
 */
export async function assertEcosystemAccess(
  session: Session | undefined,
  ecosystemId: string,
): Promise<Session> {
  // Signed out is not the same as forbidden. Sending an anonymous visitor to
  // sign in is the useful response; telling them the resource exists but is off
  // limits would leak that it exists at all.
  if (!session) redirect("/signin");

  const orgId = await tenancy.getOrgIdForEcosystem(db(), ecosystemId);
  if (!orgId || orgId !== session.orgId) throw new AccessDenied("VIEWER");
  return session;
}
