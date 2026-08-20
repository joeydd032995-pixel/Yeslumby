import { createSql, type Sql } from "@meta/db";

/**
 * One connection pool per process.
 *
 * Next's dev server re-evaluates modules on hot reload, so a plain
 * module-level pool would leak a new one on every edit until Postgres refuses
 * connections. Stashing it on globalThis survives HMR.
 */
const globalForDb = globalThis as unknown as { __metaSql?: Sql };

export function db(): Sql {
  // Pool size is left to `createSql`, which sizes it against the connection
  // budget the URL implies — a pooled serverless deployment and a local
  // cluster want very different numbers.
  globalForDb.__metaSql ??= createSql({
    url: process.env.DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5433/meta_ecosystem",
  });
  return globalForDb.__metaSql;
}
