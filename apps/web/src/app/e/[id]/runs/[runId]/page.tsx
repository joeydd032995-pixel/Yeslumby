import { runs, telemetry, num, type AgentArtifactRow } from "@meta/db";
import type { Synthesis } from "@meta/runtime";
import { db } from "@/lib/db";
import { getSession, assertEcosystemAccess } from "@/lib/auth";
import { TopBar, Panel, Pill, Stat, Empty, usd } from "@/components/shell";
import { RunStream } from "@/components/run-stream";

export const dynamic = "force-dynamic";

export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id, runId } = await params;
  await assertEcosystemAccess(await getSession(), id);

  const sql = db();
  const run = await runs.getRun(sql, runId);
  if (!run) return <Empty>Run not found.</Empty>;

  const artifacts = await runs.listArtifacts(sql, runId);
  const byAgent = await telemetry.getRunCostByAgent(sql, runId);
  const synthesisArtifact = artifacts.filter((a) => a.kind === "SYNTHESIS").at(-1);
  const synthesis = synthesisArtifact?.content as Synthesis | undefined;

  const pending = run.status === "PENDING" || run.status === "RUNNING";

  return (
    <>
      <TopBar />
      <main className="shell">
        <div className="page-head">
          <div className="grow">
            <h1>Run</h1>
            <p className="sub">{run.objective}</p>
          </div>
          <Pill
            tone={
              run.status === "COMPLETED"
                ? "good"
                : run.status === "FAILED"
                  ? "bad"
                  : run.status === "AWAITING_APPROVAL"
                    ? "warn"
                    : "info"
            }
          >
            {run.status}
          </Pill>
        </div>

        <div className="stack">
          <div className="grid four">
            <Stat label="Rounds" value={run.iteration + 1} />
            <Stat label="Artifacts" value={artifacts.length} />
            <Stat label="Cost" value={usd(num(run.cost_usd))} />
            <Stat
              label="Tokens"
              value={Number(run.input_tokens) + Number(run.output_tokens)}
              note={`${run.input_tokens} in / ${run.output_tokens} out`}
            />
          </div>

          <Panel title={pending ? "Live" : "Execution"}>
            <RunStream runId={runId} autoStart={pending} />
          </Panel>

          {synthesis && (
            <Panel title="Result" action={<Pill tone="info">disagreement preserved</Pill>}>
              <div className="stack">
                <p style={{ margin: 0 }}>{synthesis.summary}</p>

                <Section
                  title="High confidence"
                  count={synthesis.highConfidence.length}
                  tone="good"
                >
                  {synthesis.highConfidence.map((c, i) => (
                    <li key={i}>
                      {c.text}{" "}
                      <span className="muted mono">
                        ({c.confidence.toFixed(2)}, {c.sources.length} source
                        {c.sources.length === 1 ? "" : "s"})
                      </span>
                    </li>
                  ))}
                </Section>

                <Section
                  title="Working hypotheses"
                  count={synthesis.workingHypotheses.length}
                  tone="info"
                >
                  {synthesis.workingHypotheses.map((c, i) => (
                    <li key={i}>
                      {c.text}{" "}
                      <span className="muted mono">({c.confidence.toFixed(2)})</span>
                    </li>
                  ))}
                </Section>

                {/* The point of the whole synthesis contract: disagreement that
                    survived is reported, not averaged away. */}
                <div>
                  <h3 style={{ marginBottom: 8 }}>
                    Contested <Pill tone="warn">{synthesis.contested.length}</Pill>
                  </h3>
                  {synthesis.contested.length === 0 ? (
                    <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                      Nothing remained contested.
                    </p>
                  ) : (
                    <div className="stack" style={{ gap: 12 }}>
                      {synthesis.contested.map((c, i) => (
                        <div key={i} className="panel" style={{ padding: 12 }}>
                          <strong>{c.question}</strong>
                          <div className="stack" style={{ gap: 8, marginTop: 8 }}>
                            {c.positions.map((p, j) => (
                              <div key={j}>
                                <div className="row" style={{ gap: 6 }}>
                                  {p.agentIds.map((a) => (
                                    <Pill key={a}>{a}</Pill>
                                  ))}
                                </div>
                                <div style={{ fontSize: 13, marginTop: 3 }}>{p.position}</div>
                                <div className="muted" style={{ fontSize: 12 }}>
                                  {p.reasoning}
                                </div>
                              </div>
                            ))}
                          </div>
                          <div
                            className="muted"
                            style={{ fontSize: 12, marginTop: 8, borderTop: "1px solid var(--line)", paddingTop: 8 }}
                          >
                            Unresolved because: {c.whyUnresolved}
                            <br />
                            Would be settled by: {c.resolvingEvidence}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <Section title="Unknowns" count={synthesis.unknowns.length}>
                  {synthesis.unknowns.map((u, i) => (
                    <li key={i}>{u}</li>
                  ))}
                </Section>

                <Section
                  title="Recommended experiments"
                  count={synthesis.recommendedExperiments.length}
                >
                  {synthesis.recommendedExperiments.map((e, i) => (
                    <li key={i}>
                      {e.description} <span className="muted">— resolves: {e.resolves}</span>
                    </li>
                  ))}
                </Section>
              </div>
            </Panel>
          )}

          {byAgent.length > 0 && (
            <Panel title="Cost by agent" tight>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th className="num">Calls</th>
                      <th className="num">Avg latency</th>
                      <th className="num">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byAgent.map((r) => (
                      <tr key={r.agentId ?? "none"}>
                        <td>
                          <code>{r.agentId ?? "—"}</code>
                        </td>
                        <td className="num">{r.calls}</td>
                        <td className="num">{r.avgLatencyMs ?? 0}ms</td>
                        <td className="num">{usd(num(r.costUsd))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          <Panel title="Artifacts" tight>
            {artifacts.length === 0 ? (
              <Empty>No artifacts yet.</Empty>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th className="num">Round</th>
                      <th>Stage</th>
                      <th>Agent</th>
                      <th className="num">Parents</th>
                      <th className="num">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {artifacts.map((a: AgentArtifactRow) => (
                      <tr key={a.id}>
                        <td className="num">{a.iteration + 1}</td>
                        <td className="mono">{a.stage}</td>
                        <td>
                          <code>{a.agent_id ?? "—"}</code>
                        </td>
                        <td className="num">{a.parent_artifact_ids.length}</td>
                        <td className="num">{usd(num(a.cost_usd))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      </main>
    </>
  );
}

function Section({
  title,
  count,
  tone,
  children,
}: {
  title: string;
  count: number;
  tone?: "good" | "info" | "warn";
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 style={{ marginBottom: 6 }}>
        {title} <Pill tone={tone ?? "neutral"}>{count}</Pill>
      </h3>
      {count === 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          None.
        </p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>{children}</ul>
      )}
    </div>
  );
}
