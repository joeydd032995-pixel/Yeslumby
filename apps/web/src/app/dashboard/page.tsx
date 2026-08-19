import { genomes, telemetry, num } from "@meta/db";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { TopBar, Panel, Stat, Empty, Pill, ProviderBanner, usd } from "@/components/shell";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const session = await getSession();
  if (!session) {
    return (
      <>
        <TopBar current="/dashboard" />
        <main className="shell">
          <div className="page-head">
            <div className="grow">
              <h1>Sign in</h1>
              <p className="sub">The dashboard is scoped to your organization.</p>
            </div>
          </div>
          <Panel>
            <a className="btn primary" href="/signin">
              Continue
            </a>
          </Panel>
        </main>
      </>
    );
  }

  const sql = db();
  const ecosystems = await genomes.listEcosystems(sql, session.workspaceId);
  const usage = await telemetry.getOrgUsage(sql, session.orgId, new Date(0));

  const recent = await sql<
    Array<{
      id: string;
      objective: string;
      status: string;
      stage: string;
      iteration: number;
      cost_usd: string;
      ecosystem_id: string;
      created_at: Date;
    }>
  >`
    SELECT r.id, r.objective, r.status, r.stage, r.iteration, r.cost_usd, r.ecosystem_id, r.created_at
    FROM runs r
    JOIN ecosystems e ON e.id = r.ecosystem_id
    WHERE e.workspace_id = ${session.workspaceId}
    ORDER BY r.created_at DESC
    LIMIT 12
  `;

  const versionCounts = await sql<Array<{ ecosystem_id: string; count: string }>>`
    SELECT ecosystem_id, count(*)::text AS count
    FROM genome_versions
    WHERE ecosystem_id = ANY(${ecosystems.map((e) => e.id)})
    GROUP BY ecosystem_id
  `;
  const versions = new Map(versionCounts.map((v) => [v.ecosystem_id, v.count]));

  return (
    <>
      <TopBar current="/dashboard" />
      <main className="shell">
        <div className="page-head">
          <div className="grow">
            <h1>Dashboard</h1>
            <p className="sub">
              {session.email} · <Pill>{session.role}</Pill>
            </p>
          </div>
        </div>

        <ProviderBanner />

        <div className="stack">
          <div className="grid four">
            <Stat label="Ecosystems" value={ecosystems.length} />
            <Stat label="Runs" value={recent.length} note="most recent 12" />
            <Stat label="Model calls" value={usage.calls} />
            <Stat
              label="Spend"
              value={usd(num(usage.costUsd))}
              note={`${usage.inputTokens} in / ${usage.outputTokens} out`}
            />
          </div>

          <Panel title="Ecosystems" tight>
            {ecosystems.length === 0 ? (
              <Empty>
                No ecosystems yet. Describe an outcome on the <a href="/">recommend</a> page.
              </Empty>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Visibility</th>
                      <th className="num">Versions</th>
                      <th>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ecosystems.map((e) => (
                      <tr key={e.id}>
                        <td>
                          <a href={`/e/${e.id}`}>
                            <strong>{e.name}</strong>
                          </a>
                          {e.forked_from_ecosystem_id && (
                            <>
                              {" "}
                              <Pill tone="info">fork</Pill>
                            </>
                          )}
                          <div className="muted" style={{ fontSize: 12 }}>
                            {e.description}
                          </div>
                        </td>
                        <td>
                          <Pill tone={e.visibility === "public" ? "good" : "neutral"}>
                            {e.visibility}
                          </Pill>
                        </td>
                        <td className="num">{versions.get(e.id) ?? "0"}</td>
                        <td className="muted mono">
                          {new Date(e.created_at).toISOString().slice(0, 10)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title="Recent runs" tight>
            {recent.length === 0 ? (
              <Empty>No runs yet.</Empty>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Objective</th>
                      <th>Status</th>
                      <th>Stage</th>
                      <th className="num">Iter</th>
                      <th className="num">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <a href={`/e/${r.ecosystem_id}/runs/${r.id}`}>
                            {r.objective.slice(0, 88)}
                            {r.objective.length > 88 ? "…" : ""}
                          </a>
                        </td>
                        <td>
                          <Pill
                            tone={
                              r.status === "COMPLETED"
                                ? "good"
                                : r.status === "FAILED"
                                  ? "bad"
                                  : r.status === "AWAITING_APPROVAL"
                                    ? "warn"
                                    : "info"
                            }
                          >
                            {r.status}
                          </Pill>
                        </td>
                        <td className="mono">{r.stage}</td>
                        <td className="num">{r.iteration + 1}</td>
                        <td className="num">{usd(num(r.cost_usd))}</td>
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
