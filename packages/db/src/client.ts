import postgres from "postgres";

export type Sql = postgres.Sql<Record<string, unknown>>;

export interface DbOptions {
  url?: string;
  /** Max pooled connections. Tests use 1 to keep failures deterministic. */
  max?: number;
  /**
   * Use named prepared statements. Defaults to off behind a transaction
   * pooler, which cannot support them — see `isTransactionPooler`.
   */
  prepare?: boolean;
}

/**
 * True when the URL points at a transaction-mode connection pooler.
 *
 * A transaction pooler assigns each transaction whichever backend is free, so
 * a statement prepared on one connection is absent on the next. That fails
 * intermittently and only under concurrency — the worst shape a bug can take —
 * so it is detected from the URL rather than left to a caller to remember.
 *
 * Supavisor serves transaction mode on 6543 and session mode on 5432; PgBouncer
 * advertises itself with the `pgbouncer=true` parameter.
 */
export function isTransactionPooler(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.port === "6543" || parsed.searchParams.get("pgbouncer") === "true";
  } catch {
    return false;
  }
}

export function resolveDatabaseUrl(explicit?: string): string {
  const url = explicit ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Run `pnpm db:up` and export the printed value.",
    );
  }
  return url;
}

/**
 * Open a connection pool.
 *
 * `numeric` columns are returned as strings by the driver to avoid silent
 * precision loss. Cost is money, and JS numbers cannot represent every
 * NUMERIC(20,10) exactly, so parsing is left to the caller at the point where
 * the precision requirement is known.
 */
export function createSql(options: DbOptions = {}): Sql {
  const url = resolveDatabaseUrl(options.url);
  const pooled = isTransactionPooler(url);

  return postgres(url, {
    // Behind a pooler the connection budget is shared with every other
    // serverless instance, so each process keeps a small share rather than
    // the generous default a single long-lived server can afford.
    max: options.max ?? (pooled ? 3 : 10),
    prepare: options.prepare ?? !pooled,
    onnotice: () => {},
    transform: { undefined: null },
  });
}

/** Parse a NUMERIC column returned as a string. */
export const num = (value: string | number | null | undefined): number =>
  value === null || value === undefined ? 0 : typeof value === "number" ? value : Number(value);
