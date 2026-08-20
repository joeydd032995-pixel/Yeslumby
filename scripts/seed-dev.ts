/**
 * Seed a development tenant against the local cluster.
 *
 *   pnpm seed
 *
 * The seeding itself lives in `@meta/seed`, because the hosted deployment
 * seeds itself through an admin route and the two must not drift.
 */
import { createSql } from "@meta/db";
import { seedDevTenant } from "@meta/seed";

async function main() {
  const sql = createSql({
    url: process.env.DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5433/meta_ecosystem",
  });

  try {
    await seedDevTenant(sql, { log: (line) => console.log(line) });
    console.log(`\nsign in at http://localhost:3100/signin`);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error("seed failed:", error);
  process.exitCode = 1;
});
