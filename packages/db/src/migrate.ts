import { createSql, type Sql } from "./client.js";
import { EMBEDDED_MIGRATIONS } from "./migrations.generated.js";
import { sha256 } from "@meta/shared";

/**
 * Forward-only SQL migrator.
 *
 * Each file runs inside a transaction and its checksum is recorded. An already
 * applied file whose contents changed is a hard error rather than a silent
 * no-op: editing a shipped migration produces divergent schemas across
 * environments, which is exactly the class of drift this system cannot tolerate.
 */
export async function migrate(sql: Sql, opts: { silent?: boolean } = {}): Promise<string[]> {
  const log = (m: string) => {
    if (!opts.silent) console.log(m);
  };

  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `;

  // Read from the embedded copy rather than the directory. A serverless bundle
  // ships the module graph, not sibling directories, so a `readdir` here found
  // nothing once deployed while working perfectly on a developer's machine.
  const migrations = [...EMBEDDED_MIGRATIONS].sort((a, b) => a.name.localeCompare(b.name));

  const appliedRows = await sql<{ name: string; checksum: string }[]>`
    SELECT name, checksum FROM schema_migrations
  `;
  const applied = new Map(appliedRows.map((r) => [r.name, r.checksum]));

  const ran: string[] = [];
  for (const { name, body } of migrations) {
    const checksum = sha256(body);
    const previous = applied.get(name);

    if (previous !== undefined) {
      if (previous !== checksum) {
        throw new Error(
          `migration ${name} was modified after being applied ` +
            `(recorded ${previous.slice(0, 12)}, found ${checksum.slice(0, 12)}). ` +
            `Add a new migration instead of editing a shipped one.`,
        );
      }
      continue;
    }

    log(`applying ${name}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`
        INSERT INTO schema_migrations (name, checksum) VALUES (${name}, ${checksum})
      `;
    });
    ran.push(name);
  }

  log(ran.length ? `applied ${ran.length} migration(s)` : "schema up to date");
  return ran;
}

/** Drop and recreate the public schema. Test-only; refuses non-test databases. */
export async function resetSchema(sql: Sql): Promise<void> {
  const [row] = await sql<{ db: string }[]>`SELECT current_database() AS db`;
  if (!row?.db.includes("test")) {
    throw new Error(`refusing to reset non-test database "${row?.db}"`);
  }
  await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sql = createSql();
  try {
    await migrate(sql);
  } finally {
    await sql.end();
  }
}
