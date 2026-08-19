import { redirect } from "next/navigation";
import { genomes, runs, type GenomeVersionRow } from "@meta/db";
import { parseGenome, hashGenome } from "@meta/genome";
import { db } from "@/lib/db";
import { getSession, assertEcosystemAccess, requireRole } from "@/lib/auth";
import { randomIds } from "@meta/shared";
import {
  TopBar,
  Panel,
  Pill,
  Stat,
  Empty,
  EcosystemTabs,
  ProviderBanner,
  usd,
} from "@/components/shell";
import { TopologyGraph } from "@/components/topology";
import { num } from "@meta/db";

export const dynamic = "force-dynamic";

export default async function EcosystemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await assertEcosystemAccess(await getSession(), id);

  const sql = db();
  const ecosystem = await genomes.getEcosystem(sql, id);
  if (!ecosystem) return <Empty>Ecosystem not found.</Empty>;

  const versions = await genomes.listGenomeVersions(sql, id);
  const current: GenomeVersionRow | undefined =
    versions.find((v) => v.id === ecosystem.current_genome_version_id) ?? versions.at(-1);
  if (!current) return <Empty>This ecosystem has no genome version.</Empty>;

  const genome = parseGenome(current.genome);
  const recentRuns = await runs.listRuns(sql, id, 8);

  /** Start a run. Requires OPERATOR — reading is not the same as spending. */
  async function startRun(formData: FormData) {
    "use server";
    const active = await getSession();
    const checked = requireRole(await assertEcosystemAccess(active, id), "OPERATOR");
    const objective = String(formData.get("objective") ?? "").trim();
    if (!objective) return;

    const run = await runs.createRun(db(), {
      id: randomIds.next("run"),
      ecosystemId: id,
      genomeVersionId: current!.id,
      objective,
      // Random per run: the seed is what makes fence nonces unguessable, so it
      // must not be derived from anything an attacker could see.
      seed: randomIds.next("run"),
      createdBy: checked.userId,
    });
    redirect(`/e/${id}/runs/${run.id}`);
  }

  return (
    <>
      <TopBar />
      <main className="shell">
        <div className="page-head">
          <div className="grow">
            <h1>{ecosystem.name}</h1>
            <p className="sub">{ecosystem.description || genome.description}</p>
          </div>
          <div className="row">
            <Pill tone="info">v{current.version}</Pill>
            <Pill>{genome.problemClass}</Pill>
          </div>
        </div>

        <EcosystemTabs ecosystemId={id} current="genome" />
        <ProviderBanner />

        <div className="stack">
          <div className="grid four">
            <Stat label="Agents" value={genome.agents.length} />
            <Stat label="Edges" value={genome.edges.length} />
            <Stat label="Versions" value={versions.length} />
            <Stat
              label="Genome hash"
              value={<span style={{ fontSize: 13 }}>{hashGenome(genome).slice(0, 10)}</span>}
              note="content address"
            />
          </div>

          <div className="grid two">
            <Panel title="Topology">
              <TopologyGraph genome={genome} />
            </Panel>

            <Panel title="Protocols">
              <dl className="kv">
                <dt>Independent proposal</dt>
                <dd>{String(genome.protocols.independentProposal)}</dd>
                <dt>Cross challenge</dt>
                <dd>{String(genome.protocols.crossChallenge)}</dd>
                <dt>Falsification</dt>
                <dd>{String(genome.protocols.falsificationRequired)}</dd>
                <dt>Preserve minority</dt>
                <dd>{String(genome.protocols.preserveMinorityViews)}</dd>
                <dt>Human approval</dt>
                <dd>{genome.protocols.humanApproval}</dd>
                <dt>Max rounds</dt>
                <dd>{genome.protocols.maxRounds}</dd>
                <dt>Consensus ≥</dt>
                <dd>{genome.protocols.consensusThreshold}</dd>
                <dt>Disagreement ≥</dt>
                <dd>{genome.protocols.disagreementThreshold}</dd>
              </dl>

              <div className="divider" style={{ margin: "14px 0" }} />

              <h3 style={{ marginBottom: 6 }}>Watcher</h3>
              <dl className="kv">
                <dt>Enabled</dt>
                <dd>{String(genome.watcher.enabled)}</dd>
                <dt>Model</dt>
                <dd>{genome.watcher.model.primary}</dd>
                <dt>Dimensions</dt>
                <dd>{genome.watcher.dimensions.join(", ")}</dd>
              </dl>

              <div className="divider" style={{ margin: "14px 0" }} />

              <h3 style={{ marginBottom: 6 }}>Stop criteria</h3>
              <dl className="kv">
                <dt>Max iterations</dt>
                <dd>{genome.stopCriteria.maxIterations}</dd>
                <dt>Target score</dt>
                <dd>{genome.stopCriteria.targetScore}</dd>
                <dt>Max cost</dt>
                <dd>${genome.stopCriteria.maxCostUsd}</dd>
              </dl>
            </Panel>
          </div>

          <Panel title="Agents" tight>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Mode</th>
                    <th>Model</th>
                    <th>Capabilities</th>
                    <th className="num">Temp</th>
                    <th>Proposes</th>
                  </tr>
                </thead>
                <tbody>
                  {genome.agents.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <code>{a.id}</code>
                        {a.id === genome.synthesizerId && (
                          <>
                            {" "}
                            <Pill tone="info">synthesizer</Pill>
                          </>
                        )}
                        <div className="muted" style={{ fontSize: 12 }}>
                          {a.role}
                        </div>
                      </td>
                      <td>{a.cognitiveMode}</td>
                      <td className="mono">{a.model.primary}</td>
                      <td>
                        {a.capabilities.length === 0 ? (
                          <span className="muted">none</span>
                        ) : (
                          a.capabilities.map((c) => <Pill key={c}>{c}</Pill>)
                        )}
                      </td>
                      <td className="num">{a.model.temperature}</td>
                      <td>{a.proposes ? "yes" : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="Start a run">
            <form action={startRun} className="stack" style={{ gap: 12 }}>
              <textarea
                name="objective"
                placeholder="What should this organization work on?"
                aria-label="Run objective"
              />
              <div className="row">
                <button className="primary" type="submit">
                  Run against v{current.version}
                </button>
                <span className="muted" style={{ fontSize: 12 }}>
                  Pinned to this immutable version for its whole life.
                </span>
              </div>
            </form>
          </Panel>

          <Panel title="Runs" tight>
            {recentRuns.length === 0 ? (
              <Empty>No runs yet.</Empty>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Objective</th>
                      <th>Status</th>
                      <th className="num">Iterations</th>
                      <th className="num">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentRuns.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <a href={`/e/${id}/runs/${r.id}`}>{r.objective.slice(0, 80)}</a>
                        </td>
                        <td>
                          <Pill
                            tone={
                              r.status === "COMPLETED"
                                ? "good"
                                : r.status === "FAILED"
                                  ? "bad"
                                  : "info"
                            }
                          >
                            {r.status}
                          </Pill>
                        </td>
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
