import postgres from "postgres";

export type Sql = postgres.Sql<Record<string, unknown>>;

export interface DbOptions {
  url?: string;
  /** Max pooled connections. Tests use 1 to keep failures deterministic. */
  max?: number;
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
  return postgres(resolveDatabaseUrl(options.url), {
    max: options.max ?? 10,
    onnotice: () => {},
    transform: { undefined: null },
  });
}

/** Parse a NUMERIC column returned as a string. */
export const num = (value: string | number | null | undefined): number =>
  value === null || value === undefined ? 0 : typeof value === "number" ? value : Number(value);
