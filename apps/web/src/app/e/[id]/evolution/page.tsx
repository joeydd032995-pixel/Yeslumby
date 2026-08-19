import { genomes, mutations, type GenomeVersionRow } from "@meta/db";
import { parseGenome, diffGenomes } from "@meta/genome";
import { db } from "@/lib/db";
import { getSession, assertEcosystemAccess } from "@/lib/auth";
import { TopBar, Panel, Pill, Empty, EcosystemTabs } from "@/components/shell";

export const dynamic = "force-dynamic";

const ORIGIN_TONE: Record<string, "good" | "info" | "warn" | "neutral"> = {
  SEED: "neutral",
  MUTATION: "info",
  BREEDING: "good",
  FORK: "warn",
  MANUAL: "neutral",
};

/**
 * The version graph, drawn as a git-like DAG.
 *
 * Versions are laid out by version number down the page with parent links
 * drawn between them. Breeding gives a version two parents, which is exactly
 * why this is a graph and not a list.
 */
function VersionGraph({ versions }: { versions: GenomeVersionRow[] }) {
  const rowHeight = 54;
  const laneWidth = 26;
  const height = Math.max(versions.length * rowHeight + 20, 80);

  // Assign lanes so sibling branches do not overlap.
  const lanes = new Map<string, number>();
  let nextLane = 0;
  for (const v of versions) {
    const parentLane = v.parent_ids.length > 0 ? lanes.get(v.parent_ids[0]!) : undefined;
    const taken = new Set([...lanes.entries()].filter(([, l]) => l !== undefined).map(([, l]) => l));
    if (parentLane !== undefined && !hasSiblingInLane(versions, lanes, v, parentLane)) {
      lanes.set(v.id, parentLane);
    } else {
      while (taken.has(nextLane)) nextLane++;
      lanes.set(v.id, parentLane === undefined ? 0 : ++nextLane);
    }
  }
  const maxLane = Math.max(0, ...[...lanes.values()]);
  const width = (maxLane + 1) * laneWidth + 30;

  const y = (i: number) => 22 + i * rowHeight;
  const x = (id: string) => 16 + (lanes.get(id) ?? 0) * laneWidth;
  const indexOf = new Map(versions.map((v, i) => [v.id, i]));

  return (
    <svg width={width} height={height} role="img" aria-label="Version graph" style={{ flexShrink: 0 }}>
      {versions.map((v, i) =>
        v.parent_ids.map((parentId) => {
          const pi = indexOf.get(parentId);
          if (pi === undefined) return null;
          return (
            <path
              key={`${v.id}-${parentId}`}
              d={`M ${x(v.id)} ${y(i)} C ${x(v.id)} ${y(i) - 20}, ${x(parentId)} ${y(pi) + 20}, ${x(parentId)} ${y(pi)}`}
              stroke="var(--line-2)"
              strokeWidth="1.5"
              fill="none"
            />
          );
        }),
      )}
      {versions.map((v, i) => (
        <circle
          key={v.id}
          cx={x(v.id)}
          cy={y(i)}
          r="5"
          fill={v.origin === "SEED" ? "var(--panel)" : "var(--accent)"}
          stroke="var(--accent)"
          strokeWidth="2"
        />
      ))}
    </svg>
  );
}

function hasSiblingInLane(
  versions: GenomeVersionRow[],
  lanes: Map<string, number>,
  current: GenomeVersionRow,
  lane: number,
): boolean {
  return versions.some(
    (other) =>
      other.id !== current.id &&
      lanes.get(other.id) === lane &&
      other.parent_ids.some((p) => current.parent_ids.includes(p)),
  );
}

export default async function EvolutionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await assertEcosystemAccess(await getSession(), id);

  const sql = db();
  const ecosystem = await genomes.getEcosystem(sql, id);
  const versions = await genomes.listGenomeVersions(sql, id);
  const mutationRows = await mutations.listMutations(sql, id, 50);

  const scores = await sql<Array<{ genome_version_id: string; avg: string; cost: string }>>`
    SELECT genome_version_id, avg(overall_score)::text AS avg, sum(cost_usd)::text AS cost
    FROM benchmark_results WHERE ecosystem_id = ${id}
    GROUP BY genome_version_id
  `;
  const scoreByVersion = new Map(scores.map((s) => [s.genome_version_id, s]));

  return (
    <>
      <TopBar />
      <main className="shell">
        <div className="page-head">
          <div className="grow">
            <h1>Evolution</h1>
            <p className="sub">
              Every version is immutable. Rollback is selecting an older one, never undoing.
            </p>
          </div>
        </div>

        <EcosystemTabs ecosystemId={id} current="evolution" />

        <Panel title={`${versions.length} version${versions.length === 1 ? "" : "s"}`} tight>
          {versions.length === 0 ? (
            <Empty>No versions.</Empty>
          ) : (
            <div style={{ display: "flex", overflowX: "auto" }}>
              <VersionGraph versions={versions} />
              <div style={{ flex: 1, minWidth: 480 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Version</th>
                      <th>Origin</th>
                      <th>Change from parent</th>
                      <th className="num">Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {versions.map((v) => {
                      const parent = versions.find((p) => p.id === v.parent_ids[0]);
                      const diff = parent
                        ? diffGenomes(parseGenome(parent.genome), parseGenome(v.genome))
                        : undefined;
                      const score = scoreByVersion.get(v.id);
                      const isCurrent = v.id === ecosystem?.current_genome_version_id;
                      return (
                        <tr key={v.id} style={{ height: 54 }}>
                          <td>
                            <strong>v{v.version}</strong>
                            {isCurrent && (
                              <>
                                {" "}
                                <Pill tone="good">current</Pill>
                              </>
                            )}
                            <div className="muted mono" style={{ fontSize: 11 }}>
                              {v.genome_hash.slice(0, 10)}
                            </div>
                          </td>
                          <td>
                            <Pill tone={ORIGIN_TONE[v.origin] ?? "neutral"}>{v.origin}</Pill>
                            {v.parent_ids.length > 1 && (
                              <div className="muted" style={{ fontSize: 11 }}>
                                {v.parent_ids.length} parents
                              </div>
                            )}
                          </td>
                          <td style={{ fontSize: 12 }}>
                            {!diff ? (
                              <span className="muted">seed</span>
                            ) : (
                              <div className="row" style={{ gap: 5 }}>
                                {diff.agentsAdded.map((a) => (
                                  <Pill key={`a${a}`} tone="good">
                                    +{a}
                                  </Pill>
                                ))}
                                {diff.agentsRemoved.map((a) => (
                                  <Pill key={`r${a}`} tone="bad">
                                    −{a}
                                  </Pill>
                                ))}
                                {diff.agentsChanged.map((c) => (
                                  <Pill key={`c${c.id}`} tone="info">
                                    {c.id}: {c.fields.join(", ")}
                                  </Pill>
                                ))}
                                {diff.edgesAdded.length > 0 && (
                                  <Pill tone="good">+{diff.edgesAdded.length} edges</Pill>
                                )}
                                {diff.edgesRemoved.length > 0 && (
                                  <Pill tone="bad">−{diff.edgesRemoved.length} edges</Pill>
                                )}
                                {diff.protocolChanges.map((p) => (
                                  <Pill key={p.key} tone="warn">
                                    {p.key}: {String(p.from)} → {String(p.to)}
                                  </Pill>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="num">
                            {score ? Number(score.avg).toFixed(3) : <span className="muted">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Panel>

        <div style={{ height: 16 }} />

        <Panel title="Mutations" tight>
          {mutationRows.length === 0 ? (
            <Empty>No mutations proposed yet.</Empty>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Proposed by</th>
                    <th>Status</th>
                    <th className="num">Patches</th>
                    <th>Rationale</th>
                  </tr>
                </thead>
                <tbody>
                  {mutationRows.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <Pill tone={m.proposed_by === "WATCHER" ? "info" : "neutral"}>
                          {m.proposed_by}
                        </Pill>
                      </td>
                      <td>
                        <Pill
                          tone={
                            m.status === "APPLIED"
                              ? "good"
                              : m.status === "REJECTED"
                                ? "bad"
                                : "warn"
                          }
                        >
                          {m.status}
                        </Pill>
                        {m.rejection_reason && (
                          <div className="muted" style={{ fontSize: 11 }}>
                            {m.rejection_reason}
                          </div>
                        )}
                      </td>
                      <td className="num">{(m.patches as unknown[]).length}</td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {m.rationale ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </main>
    </>
  );
}
