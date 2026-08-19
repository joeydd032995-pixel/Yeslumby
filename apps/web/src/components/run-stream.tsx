"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface StageEvent {
  type: string;
  stage?: string;
  agentId?: string;
  iteration?: number;
  costUsd?: number;
  latencyMs?: number;
  replayed?: boolean;
  status?: string;
}

interface IterationEvent {
  iteration: number;
  score: number | null;
  costUsd: number;
  disagreementLevel: number;
  contestedCount: number;
}

const STAGES = [
  "CONTEXT",
  "PROPOSALS",
  "CHALLENGES",
  "FALSIFICATION",
  "SYNTHESIS",
  "WATCHER",
] as const;

/**
 * Live view of a run.
 *
 * Shows the organization working rather than a spinner: which stage is active,
 * which agents have reported, what each one cost. Replayed steps are labelled,
 * because a step that came back from the journal costing nothing looks
 * identical to a fast one otherwise.
 */
export function RunStream({ runId, autoStart }: { runId: string; autoStart: boolean }) {
  const [events, setEvents] = useState<StageEvent[]>([]);
  const [iterations, setIterations] = useState<IterationEvent[]>([]);
  const [state, setState] = useState<"idle" | "running" | "done" | "error">(
    autoStart ? "running" : "idle",
  );
  const [message, setMessage] = useState<string>("");
  const sourceRef = useRef<EventSource | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (state !== "running" || sourceRef.current) return;

    const source = new EventSource(`/api/runs/${runId}/stream`);
    sourceRef.current = source;

    source.addEventListener("run", (e) => {
      setEvents((prev) => [...prev, JSON.parse((e as MessageEvent).data) as StageEvent]);
    });
    source.addEventListener("iteration", (e) => {
      setIterations((prev) => [...prev, JSON.parse((e as MessageEvent).data) as IterationEvent]);
    });
    source.addEventListener("done", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { stoppedBecause: string };
      setMessage(data.stoppedBecause);
      setState("done");
      source.close();
      sourceRef.current = null;
      // The surrounding page was server-rendered before the run executed, so
      // its status, artifact count, and totals are now stale — it would show
      // PENDING and $0 above a completed trajectory. Re-fetch the server
      // components so the whole page agrees with itself.
      router.refresh();
    });
    source.addEventListener("error", (e) => {
      const raw = (e as MessageEvent).data;
      setMessage(raw ? (JSON.parse(raw) as { message: string }).message : "stream interrupted");
      setState("error");
      source.close();
      sourceRef.current = null;
      router.refresh();
    });

    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [state, runId, router]);

  const activeStage = [...events].reverse().find((e) => e.type === "stage.start")?.stage;
  const finished = new Set(
    events.filter((e) => e.type === "stage.finish").map((e) => e.stage as string),
  );
  const agents = events.filter((e) => e.type === "agent.finish");
  const totalCost = agents.reduce((sum, a) => sum + (a.costUsd ?? 0), 0);

  return (
    <div className="stack">
      {state === "idle" && (
        <button className="primary" onClick={() => setState("running")} data-testid="start-run">
          Start run
        </button>
      )}

      <div className="row" data-testid="stage-track" style={{ gap: 6 }}>
        {STAGES.map((stage) => {
          const done = finished.has(stage);
          const active = activeStage === stage && !done;
          return (
            <span
              key={stage}
              className={`pill ${done ? "good" : active ? "info" : ""}`}
              data-stage={stage}
              data-state={done ? "done" : active ? "active" : "pending"}
            >
              {active && <span className="dot" />}
              {stage}
            </span>
          );
        })}
      </div>

      {state === "running" && (
        <div className="muted" style={{ fontSize: 12 }}>
          Running… {agents.length} agent call{agents.length === 1 ? "" : "s"} so far
        </div>
      )}
      {message && (
        <div className={state === "error" ? "banner" : "banner"} data-testid="run-message">
          {state === "error" ? "Failed: " : "Stopped: "}
          {message}
        </div>
      )}

      {iterations.length > 0 && (
        <div className="table-scroll">
          <table data-testid="trajectory">
            <thead>
              <tr>
                <th className="num">Round</th>
                <th className="num">Score</th>
                <th className="num">Disagreement</th>
                <th className="num">Contested</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {iterations.map((it) => (
                <tr key={it.iteration}>
                  <td className="num">{it.iteration + 1}</td>
                  <td className="num">{it.score === null ? "—" : it.score.toFixed(3)}</td>
                  <td className="num">{it.disagreementLevel.toFixed(2)}</td>
                  <td className="num">{it.contestedCount}</td>
                  <td className="num">${it.costUsd.toFixed(6)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {agents.length > 0 && (
        <div className="table-scroll">
          <table data-testid="agent-log">
            <thead>
              <tr>
                <th>Stage</th>
                <th>Agent</th>
                <th className="num">Latency</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a, i) => (
                <tr key={i}>
                  <td className="mono">{a.stage}</td>
                  <td>
                    <code>{a.agentId}</code>{" "}
                    {a.replayed && <span className="pill">replayed</span>}
                  </td>
                  <td className="num">{a.latencyMs ?? 0}ms</td>
                  <td className="num">${(a.costUsd ?? 0).toFixed(6)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={3}>
                  <strong>Total</strong>
                </td>
                <td className="num">
                  <strong>${totalCost.toFixed(6)}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
