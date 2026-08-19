import { db } from "@/lib/db";
import { getSession, assertEcosystemAccess } from "@/lib/auth";
import { TopBar, Panel, Pill, Empty, EcosystemTabs, Stat } from "@/components/shell";

export const dynamic = "force-dynamic";

interface MemoryRow {
  id: string;
  scope: string;
  type: string;
  content: string;
  importance: number;
  confidence: number;
  problem_class: string | null;
  access_count: number;
  contradicts_ids: string[];
  created_at: Date;
}

/**
 * The three memories, shown as three distinct things.
 *
 * Conversation state lives with the run, so this page shows the two persistent
 * stores side by side and labels what each is for. Presenting them in one
 * merged list would undo in the UI the separation the schema enforces.
 */
export default async function MemoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await assertEcosystemAccess(await getSession(), id);

  const sql = db();
  const rows = await sql<MemoryRow[]>`
    SELECT id, scope, type, content, importance, confidence, problem_class,
           access_count, contradicts_ids, created_at
    FROM memories WHERE ecosystem_id = ${id}
    ORDER BY importance DESC, created_at DESC
    LIMIT 200
  `;
  const [runCount] = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM runs WHERE ecosystem_id = ${id}
  `;

  const knowledge = rows.filter((r) => r.scope === "knowledge");
  const evolutionary = rows.filter((r) => r.scope === "evolutionary");

  return (
    <>
      <TopBar />
      <main className="shell">
        <div className="page-head">
          <div className="grow">
            <h1>Memory</h1>
            <p className="sub">
              Three stores, kept apart by construction. An agent can read knowledge; only the
              mutation engine and the recommender read evolutionary.
            </p>
          </div>
        </div>

        <EcosystemTabs ecosystemId={id} current="memory" />

        <div className="grid three" style={{ marginBottom: 16 }}>
          <Stat label="Conversation state" value={runCount?.count ?? "0"} note="runs — scoped to their own execution" />
          <Stat label="Knowledge" value={knowledge.length} note="about the world" />
          <Stat label="Evolutionary" value={evolutionary.length} note="about itself" />
        </div>

        <div className="stack">
          <MemoryTable
            title="Knowledge memory"
            subtitle="Read by agent context builders during a run."
            rows={knowledge}
          />
          <MemoryTable
            title="Evolutionary memory"
            subtitle="Which structures work for which problems. Never reaches an agent's context."
            rows={evolutionary}
            showProblemClass
          />
        </div>
      </main>
    </>
  );
}

function MemoryTable({
  title,
  subtitle,
  rows,
  showProblemClass,
}: {
  title: string;
  subtitle: string;
  rows: MemoryRow[];
  showProblemClass?: boolean;
}) {
  return (
    <Panel title={title} tight>
      <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--line)" }}>
        <span className="muted" style={{ fontSize: 12 }}>
          {subtitle}
        </span>
      </div>
      {rows.length === 0 ? (
        <Empty>Nothing stored yet.</Empty>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Type</th>
                {showProblemClass && <th>Problem class</th>}
                <th>Content</th>
                <th className="num">Importance</th>
                <th className="num">Recalls</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td>
                    <Pill tone={m.type === "FAILED_APPROACH" ? "bad" : "neutral"}>{m.type}</Pill>
                    {m.contradicts_ids.length > 0 && (
                      <>
                        {" "}
                        <Pill tone="warn">contradiction</Pill>
                      </>
                    )}
                  </td>
                  {showProblemClass && <td className="mono">{m.problem_class ?? "—"}</td>}
                  <td style={{ fontSize: 13 }}>{m.content}</td>
                  <td className="num">{m.importance.toFixed(2)}</td>
                  <td className="num">{m.access_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
