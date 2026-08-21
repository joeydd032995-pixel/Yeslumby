import { createHash, timingSafeEqual } from "node:crypto";
import { seedDevTenant } from "@meta/seed";
import { db } from "@/lib/db";

/**
 * Seed the demo tenant from inside the deployment.
 *
 * A hosted database is typically reachable only from the platform that owns
 * it, so `pnpm seed` from a laptop or a CI container is not an option. This
 * runs the identical `seedDevTenant` in a place that can actually open the
 * connection.
 *
 * It is guarded rather than merely obscure: seeding purges and rebuilds the
 * demo organization, so an unauthenticated caller could wipe the tenant
 * repeatedly. The guard is a shared token, which is proportionate to what is
 * behind it — synthetic demo data — and independent of the session cookie,
 * because seeding is what creates the users that sessions refer to.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/** Minimum entropy for the shared token, in characters. */
const MIN_TOKEN_LENGTH = 32;

function tokenMatches(provided: string, expected: string): boolean {
  // Hashing first gives both operands a fixed width. Comparing the raw strings
  // would mean bailing out on a length mismatch before `timingSafeEqual` ran,
  // which leaks the expected length through response timing and narrows a
  // brute-force search.
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const expected = process.env.SEED_TOKEN;

  // Without a usable token there is no safe way to serve this, and saying
  // "forbidden" would confirm the route exists. An unconfigured deployment
  // simply does not have this endpoint.
  //
  // A short token counts as unconfigured. The endpoint is unauthenticated by
  // design and rebuilds the tenant, so a guessable token is not a weaker
  // guard so much as no guard, and failing loudly at the first request beats
  // sitting open. There is deliberately no rate limit to lean on: shared
  // state across serverless instances would be needed to make one mean
  // anything, and 32 random characters are not brute-forced at request rate.
  if (!expected || expected.length < MIN_TOKEN_LENGTH) {
    if (expected) {
      console.error(
        `[seed] SEED_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters; ` +
          `refusing to serve the seed route. Generate one with \`openssl rand -hex 32\`.`,
      );
    }
    return new Response("not found", { status: 404 });
  }

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!tokenMatches(provided, expected)) {
    return new Response("not found", { status: 404 });
  }

  try {
    const summary = await seedDevTenant(db());
    return Response.json({ ok: true, ...summary });
  } catch (error) {
    console.error("[seed] failed", error);
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { ok: false, error: message, connection: describeConnection(message) },
      { status: 500 },
    );
  }
}

/**
 * A redacted description of `DATABASE_URL`, attached to connection failures.
 *
 * Diagnosing a rejected credential otherwise means asking someone to inspect a
 * value they cannot fully see: a leading space inside a password is invisible
 * in an input box, survives a copy-paste, and parses as a perfectly valid URL,
 * so the only symptom is an authentication failure indistinguishable from a
 * genuinely wrong password. This reports the shape of the value without ever
 * revealing the secret — every field is a length or a boolean.
 */
function describeConnection(message: string): Record<string, unknown> | undefined {
  if (!/password|authentication|ENOTFOUND|ECONNREFUSED|timeout|SASL/i.test(message)) {
    return undefined;
  }

  const raw = process.env.DATABASE_URL;
  if (!raw) return { present: false };

  const parsed = raw.match(/^(\w+):\/\/([^:]*):([\s\S]*)@([^:/?]+)(?::(\d+))?\/([^?]*)(\?.*)?$/);
  if (!parsed) {
    return { present: true, parses: false, length: raw.length };
  }

  // Regex groups are `string | undefined` under `noUncheckedIndexedAccess`;
  // every group here is non-optional in the pattern except the port and query.
  const [, scheme = "", user = "", password = "", host = "", port, database = "", query] = parsed;
  return {
    present: true,
    parses: true,
    scheme,
    user,
    host,
    port: port ?? "(none — defaults to 5432)",
    database,
    query: query ?? "(none)",
    sslmodeRequire: /sslmode=require/.test(query ?? ""),
    transactionPooler: port === "6543" || port === "6432" || host.includes("-pooler."),
    password: {
      length: password.length,
      leadingWhitespace: /^\s/.test(password),
      trailingWhitespace: /\s$/.test(password),
      containsWhitespace: /\s/.test(password),
      needsUrlEncoding: /[@:/?#%\[\]]/.test(password),
      nonAscii: /[^\x20-\x7e]/.test(password),
    },
    rawHasSurroundingWhitespace: raw !== raw.trim(),
  };
}
