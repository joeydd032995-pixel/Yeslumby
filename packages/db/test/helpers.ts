import { createSql, migrate, type Sql } from "../src/index.js";
import { DeterministicIds } from "@meta/shared";
import { EMBEDDING_DIMENSIONS } from "../src/repositories/vector.js";

const DEFAULT_TEST_URL = "postgresql://postgres@127.0.0.1:5433/meta_ecosystem_test";

export function testSql(): Sql {
  return createSql({
    url: process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_URL,
    max: 4,
  });
}

/** Migrations are idempotent, so suites can each call this without coordinating. */
export async function ensureSchema(sql: Sql): Promise<void> {
  await migrate(sql, { silent: true });
}

let namespaceCounter = 0;

/**
 * A fresh org → workspace → ecosystem chain per suite.
 *
 * Suites share one database, so every fixture is namespaced rather than the
 * schema being dropped between files. That keeps runs fast and surfaces any
 * accidental cross-tenant leakage as a test failure instead of hiding it.
 */
export async function seedTenant(sql: Sql, label?: string) {
  const ns = `${label ?? "t"}${++namespaceCounter}_${process.pid}`;
  const ids = new DeterministicIds(ns);

  const orgId = ids.next("org");
  const userId = ids.next("user");
  const workspaceId = ids.next("workspace");
  const ecosystemId = ids.next("ecosystem");

  await sql`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, ${`Org ${ns}`}, ${`org-${ns}`})`;
  await sql`INSERT INTO users (id, email) VALUES (${userId}, ${`${ns}@example.test`})`;
  await sql`
    INSERT INTO workspaces (id, org_id, name, slug)
    VALUES (${workspaceId}, ${orgId}, ${`WS ${ns}`}, ${`ws-${ns}`})
  `;
  await sql`
    INSERT INTO ecosystems (id, workspace_id, name, slug, created_by)
    VALUES (${ecosystemId}, ${workspaceId}, ${`Eco ${ns}`}, ${`eco-${ns}`}, ${userId})
  `;

  return { ns, ids, orgId, userId, workspaceId, ecosystemId };
}

/**
 * A deterministic unit-ish embedding derived from text.
 *
 * Real embeddings need a provider key that this environment does not have. What
 * the persistence tests actually need is a stable vector where similar inputs
 * land near each other, which this provides: shared tokens contribute to the
 * same dimensions.
 */
export function fakeEmbedding(text: string, dims = EMBEDDING_DIMENSIONS): number[] {
  const vec = new Array<number>(dims).fill(0);
  const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
  for (const token of tokens) {
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = Math.abs(h) % dims;
    vec[idx] = (vec[idx] ?? 0) + 1;
  }
  const norm = Math.hypot(...vec) || 1;
  return vec.map((v) => v / norm);
}
