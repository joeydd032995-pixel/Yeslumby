import { recommendGenome, classifyObjective } from "@meta/evolution";
import { TEMPLATES } from "@meta/genome";
import { db } from "@/lib/db";
import { embedder } from "@/lib/runtime";
import { getSession } from "@/lib/auth";
import { TopBar, Panel, Pill, ProviderBanner } from "@/components/shell";

export const dynamic = "force-dynamic";

/**
 * "Describe an outcome, get an architecture."
 *
 * The point of leading with this rather than a configuration form: an
 * Architecture Genome has agents, a topology, protocols, memory and mutation
 * policy, and stop criteria. Presenting that to someone who has not yet decided
 * what they want is how a powerful system reads as an unusable one.
 */
export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<{ objective?: string }>;
}) {
  const { objective } = await searchParams;
  const session = await getSession();

  // Only ecosystems this session may see contribute structural lessons.
  // Authorization is decided here and passed in, never inferred downstream.
  const visible = session
    ? (
        await db()<{ id: string }[]>`
          SELECT e.id FROM ecosystems e
          JOIN workspaces w ON w.id = e.workspace_id
          WHERE w.org_id = ${session.orgId}
        `
      ).map((r) => r.id)
    : [];

  const recommendation = objective
    ? await recommendGenome(
        { sql: db(), embedder: embedder() },
        { objective, visibleEcosystemIds: visible },
      )
    : undefined;

  const classified = objective ? classifyObjective(objective) : undefined;

  return (
    <>
      <TopBar current="/" />
      <main className="shell">
        <div className="page-head">
          <div className="grow">
            <h1>Describe an outcome</h1>
            <p className="sub">
              An architecture is recommended from the objective and from what prior runs
              learned about this class of problem — before you confront the full genome.
            </p>
          </div>
        </div>

        <ProviderBanner />

        <div className="stack">
          <Panel>
            <form method="GET" className="stack" style={{ gap: 12 }}>
              <textarea
                name="objective"
                placeholder="e.g. A widely cited study reports a large effect that three replication attempts failed to reproduce. What should we conclude, and what would settle it?"
                defaultValue={objective ?? ""}
                aria-label="Objective"
              />
              <div className="row">
                <button className="primary" type="submit">
                  Recommend an architecture
                </button>
                <span className="muted" style={{ fontSize: 12 }}>
                  Nothing is created until you start a run.
                </span>
              </div>
            </form>
          </Panel>

          {recommendation && classified && (
            <Panel
              title="Recommended"
              action={<Pill tone="info">confidence {recommendation.confidence}</Pill>}
            >
              <div className="stack">
                <div className="row" style={{ gap: 8 }}>
                  <Pill tone="good">{recommendation.templateKey}</Pill>
                  <Pill>{recommendation.problemClass}</Pill>
                  <span className="muted">
                    {recommendation.genome.agents.length} agents ·{" "}
                    {recommendation.genome.edges.length} edges
                  </span>
                </div>

                <p style={{ margin: 0, color: "var(--ink-2)" }}>{recommendation.rationale}</p>

                {recommendation.lessons.length > 0 && (
                  <div>
                    <h3 style={{ marginBottom: 6 }}>Prior structural lessons consulted</h3>
                    <div className="stack" style={{ gap: 6 }}>
                      {recommendation.lessons.map((l) => (
                        <div key={l.id} className="fence" style={{ maxHeight: "none" }}>
                          {l.content}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="divider" />

                <div>
                  <h3 style={{ marginBottom: 8 }}>Agents</h3>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Agent</th>
                          <th>Cognitive mode</th>
                          <th>Model</th>
                          <th>Role</th>
                        </tr>
                      </thead>
                      <tbody>
                        {recommendation.genome.agents.map((a) => (
                          <tr key={a.id}>
                            <td>
                              <code>{a.id}</code>{" "}
                              {a.id === recommendation.genome.synthesizerId && (
                                <Pill tone="info">synthesizer</Pill>
                              )}
                            </td>
                            <td>{a.cognitiveMode}</td>
                            <td className="mono">{a.model.primary}</td>
                            <td className="muted">{a.role}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {recommendation.alternatives.length > 0 && (
                  <>
                    <div className="divider" />
                    <div>
                      <h3 style={{ marginBottom: 8 }}>Alternatives</h3>
                      <div className="grid two">
                        {recommendation.alternatives.map((alt) => (
                          <div key={alt.templateKey} className="panel" style={{ padding: 12 }}>
                            <strong>{alt.title}</strong>
                            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                              {alt.why}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </Panel>
          )}

          {!recommendation && (
            <Panel title="Starter architectures">
              <div className="grid three">
                {TEMPLATES.map((t) => (
                  <div key={t.key} className="panel" style={{ padding: 14 }}>
                    <strong>{t.title}</strong>
                    <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                      {t.summary}
                    </div>
                    <div style={{ marginTop: 10 }}>
                      <Pill>{t.problemClass}</Pill>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          )}
        </div>
      </main>
    </>
  );
}
