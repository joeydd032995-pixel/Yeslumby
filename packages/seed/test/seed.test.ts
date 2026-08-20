import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { seedDevTenant } from "../src/index.js";
import { createSql, type Sql } from "@meta/db";

let sql: Sql;

beforeAll(async () => {
  sql = createSql({
    url: process.env.TEST_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5433/meta_ecosystem_test",
    max: 4,
  });
});

afterAll(async () => {
  await sql.end();
});

describe("seedDevTenant", () => {
  it(
    "leaves users outside the demo tenant alone",
    async () => {
      // Every user id in this system begins `usr_`, so a reseed that matched on
      // that prefix would delete real people in other organizations. The seed
      // route runs against a hosted database, so this is data loss rather than
      // an inconvenience — hence a test rather than a comment.
      const bystanderOrg = "org_bystander_seedtest";
      const bystander = "usr_bystander_seedtest";
      await sql`DELETE FROM users WHERE id = ${bystander}`;
      await sql`
        INSERT INTO organizations (id, name, slug)
        VALUES (${bystanderOrg}, 'Bystander', 'bystander-seedtest')
        ON CONFLICT (id) DO NOTHING
      `;
      await sql`
        INSERT INTO users (id, email)
        VALUES (${bystander}, 'bystander@example.test')
      `;

      await seedDevTenant(sql);

      const [survived] = await sql<Array<{ id: string }>>`
        SELECT id FROM users WHERE id = ${bystander}
      `;
      expect(survived?.id).toBe(bystander);

      // And the tenant it does own was rebuilt.
      const seeded = await sql<Array<{ id: string }>>`
        SELECT id FROM users WHERE id IN ('usr_owner', 'usr_architect', 'usr_operator', 'usr_viewer')
        ORDER BY id
      `;
      expect(seeded).toHaveLength(4);
    },
    120_000,
  );

  it("is idempotent — a second seed rebuilds rather than stacking", async () => {
    const first = await seedDevTenant(sql);
    const second = await seedDevTenant(sql);

    // The deterministic provider means a rebuild is not merely non-duplicating
    // but identical, which is the property the hosted demo depends on.
    expect(second.versions).toBe(first.versions);
    expect(second.modelCalls).toBe(first.modelCalls);
    expect(second.costUsd).toBe(first.costUsd);

    const rows = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM users WHERE id LIKE 'usr@_%' ESCAPE '@'
    `;
    expect(Number(rows[0]?.count ?? 0)).toBeGreaterThanOrEqual(4);
  }, 180_000);
});
