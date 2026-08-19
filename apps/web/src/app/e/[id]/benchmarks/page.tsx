import { genomes } from "@meta/db";
import { db } from "@/lib/db";
import { getSession, assertEcosystemAccess } from "@/lib/auth";
import { TopBar, Panel, Pill, Empty, EcosystemTabs, Bar, usd } from "@/components/shell";

export const dynamic = "force-dynamic";

export default async function BenchmarksPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await assertEcosystemAccess(await getSession(), id);

  const sql = db();
  const ecosystem = await genomes.getEcosystem(sql, id);

  const rows = await sql<
    Array<{
      genome_version_id: string;
      version: number;
      tasks: string;
      avg_score: string;
      total_cost: string;
      efficiency: string | null;
    }>
  >`
    SELECT br.genome_version_id, gv.version,
           count(*)::text AS tasks,
           avg(br.overall_score)::text AS avg_score,
           sum(br.cost_usd)::text AS total_cost,
           CASE WHEN sum(br.cost_usd) > 0
                THEN (avg(br.overall_score) / sum(br.cost_usd))::text
                ELSE NULL END AS efficiency
    FROM benchmark_results br
    JOIN genome_versions gv ON gv.id = br.genome_version_id
    WHERE br.ecosystem_id = ${id}
    GROUP BY br.genome_version_id, gv.version
    ORDER BY avg(br.overall_score) DESC
  `;

  const best = rows.length > 0 ? Number(rows[0]!.avg_score) : 0;

  const perTask = await sql<
    Array<{ task_id: string; version: number; overall_score: string; scores: unknown }>
  >`
    SELECT br.task_id, gv.version, br.overall_score::text, br.scores
    FROM benchmark_results br
    JOIN genome_versions gv ON gv.id = br.genome_version_id
    WHERE br.ecosystem_id = ${id}
    ORDER BY br.task_id, gv.version
  `;

  return (
    <>
      <TopBar />
      <main className="shell">
        <div className="page-head">
          <div className="grow">
            <h1>Benchmarks</h1>
            <p className="sub">
              Versions run the same tasks with the same seed derivation, so differences are
              attributable to architecture rather than sampling.
            </p>
          </div>
        </div>

        <EcosystemTabs ecosystemId={id} current="benchmarks" />

        <div className="stack">
          <Panel title="Version comparison" tight>
            {rows.length === 0 ? (
              <Empty>
                No benchmark results yet. Run <code>pnpm demo</code> or trigger a comparison.
              </Empty>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Version</th>
                      <th style={{ width: 180 }}>Score</th>
                      <th className="num">Tasks</th>
                      <th className="num">Cost</th>
                      <th className="num">Score / $</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const score = Number(r.avg_score);
                      const isCurrent = r.genome_version_id === ecosystem?.current_genome_version_id;
                      return (
                        <tr key={r.genome_version_id}>
                          <td>
                            <strong>v{r.version}</strong>
                            {isCurrent && (
                              <>
                                {" "}
                                <Pill tone="good">current</Pill>
                              </>
                            )}
                            {score >= best && rows.length > 1 && (
                              <>
                                {" "}
                                <Pill tone="info">best</Pill>
                              </>
                            )}
                          </td>
                          <td>
                            <div className="row" style={{ gap: 8 }}>
                              <span className="mono">{score.toFixed(3)}</span>
                              <span style={{ flex: 1, minWidth: 70 }}>
                                <Bar value={score} />
                              </span>
                            </div>
                          </td>
                          <td className="num">{r.tasks}</td>
                          <td className="num">{usd(Number(r.total_cost))}</td>
                          <td className="num">
                            {r.efficiency ? Number(r.efficiency).toFixed(1) : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {perTask.length > 0 && (
            <Panel title="Per task" tight>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th className="num">Version</th>
                      <th className="num">Score</th>
                      <th>Dimensions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {perTask.map((t, i) => (
                      <tr key={i}>
                        <td className="mono">{t.task_id}</td>
                        <td className="num">v{t.version}</td>
                        <td className="num">{Number(t.overall_score).toFixed(3)}</td>
                        <td>
                          <div className="row" style={{ gap: 5 }}>
                            {Object.entries((t.scores ?? {}) as Record<string, number>).map(
                              ([k, v]) => (
                                <Pill key={k}>
                                  {k} {typeof v === "number" ? v.toFixed(2) : String(v)}
                                </Pill>
                              ),
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </div>
      </main>
    </>
  );
}
