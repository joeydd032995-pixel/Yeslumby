import { genomes, runs } from "@meta/db";
import { parseGenome } from "@meta/genome";
import { createKnowledgeRecall } from "@meta/memory";
import { runEcosystem, type RunContext, type RunEvent } from "@meta/runtime";
import { randomIds, systemClock } from "@meta/shared";
import { db } from "@/lib/db";
import { gateway, embedder } from "@/lib/runtime";
import { getSession, assertEcosystemAccess, requireRole } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Execute a run and stream its stage and agent events.
 *
 * The run executes in this process. That is a real limitation and worth naming
 * rather than hiding: it makes the app single-node, and a long run holds a
 * connection open. What makes it defensible rather than reckless is the step
 * journal — if the connection drops, the process restarts, or a deploy lands
 * mid-run, re-entering replays every completed step and repeats no model call.
 * So the failure mode is a lost view of progress, not lost work or double spend.
 *
 * The production answer is a queue with workers, and the seam is already here:
 * `emit` is the only coupling between the runtime and this transport.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const { runId } = await context.params;

  const sql = db();
  const run = await runs.getRun(sql, runId);
  if (!run) return new Response("run not found", { status: 404 });

  // Starting a run spends money, so it is gated on OPERATOR rather than on
  // merely being able to see the ecosystem.
  try {
    const session = await assertEcosystemAccess(await getSession(), run.ecosystem_id);
    requireRole(session, "OPERATOR");
  } catch {
    return new Response("forbidden", { status: 403 });
  }

  if (run.status === "COMPLETED" || run.status === "FAILED") {
    return new Response("run already finished", { status: 409 });
  }

  const version = await genomes.getGenomeVersion(sql, run.genome_version_id);
  if (!version) return new Response("genome version missing", { status: 500 });
  const genome = parseGenome(version.genome);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };

      const ctx: RunContext = {
        sql,
        gateway: gateway(),
        clock: systemClock,
        ids: randomIds,
        genome,
        run: {
          id: run.id,
          ecosystemId: run.ecosystem_id,
          genomeVersionId: run.genome_version_id,
          objective: run.objective,
          seed: run.seed,
        },
        iteration: 0,
        attribution: { ecosystemId: run.ecosystem_id, runId: run.id },
        emit: (event: RunEvent) => send("run", event),
        recall: createKnowledgeRecall(sql, embedder(), run.ecosystem_id),
      };

      send("open", { runId: run.id, objective: run.objective });

      try {
        const result = await runEcosystem(ctx, {
          onIteration: (record) => void send("iteration", record),
        });
        send("done", {
          stoppedBecause: result.stoppedBecause,
          trajectory: result.trajectory,
          costUsd: result.totalCostUsd,
        });
      } catch (error) {
        send("error", {
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        closed = true;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Nginx and similar buffer by default, which would batch every event
      // into one delivery at the end and defeat streaming entirely.
      "x-accel-buffering": "no",
    },
  });
}
