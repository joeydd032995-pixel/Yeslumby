import { timingSafeEqual } from "node:crypto";
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

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length, so the lengths are compared first and the result folded in.
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const expected = process.env.SEED_TOKEN;

  // Without a configured token there is no safe way to serve this, and saying
  // "forbidden" would confirm the route exists. An unconfigured deployment
  // simply does not have this endpoint.
  if (!expected) return new Response("not found", { status: 404 });

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
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
