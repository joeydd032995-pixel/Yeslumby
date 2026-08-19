import type { ArchitectureGenome } from "@meta/genome";

/**
 * The agent graph, drawn directly as SVG.
 *
 * Hand-rolled rather than pulled from a library: these graphs are small (the
 * schema caps agents at 24) and a layout dependency would earn nothing while
 * adding a build surface. Agents sit on a circle with the synthesizer centred,
 * which makes the shape that actually matters — who challenges whom, and what
 * converges on the synthesizer — readable at a glance.
 */

const INTERACTION_COLOR: Record<string, string> = {
  challenge: "var(--bad)",
  critique: "var(--warn)",
  verify: "var(--info)",
  extend: "var(--accent)",
  synthesize: "var(--ink-3)",
  observe: "var(--ink-3)",
};

export function TopologyGraph({ genome }: { genome: ArchitectureGenome }) {
  const size = 420;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 148;

  const peers = genome.agents.filter((a) => a.id !== genome.synthesizerId);
  const positions = new Map<string, { x: number; y: number }>();

  peers.forEach((agent, i) => {
    // Start at the top and go clockwise.
    const angle = (i / peers.length) * Math.PI * 2 - Math.PI / 2;
    positions.set(agent.id, {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    });
  });
  positions.set(genome.synthesizerId, { x: cx, y: cy });

  const seen = new Set<string>();
  const edges = genome.edges.filter((e) => {
    const key = `${e.from}->${e.to}:${e.interaction}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return positions.has(e.from) && positions.has(e.to);
  });

  return (
    <div style={{ overflowX: "auto" }}>
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        role="img"
        aria-label="Agent topology"
        style={{ maxWidth: "100%", height: "auto", display: "block", margin: "0 auto" }}
      >
        <defs>
          {Object.entries(INTERACTION_COLOR).map(([kind, color]) => (
            <marker
              key={kind}
              id={`arrow-${kind}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
            </marker>
          ))}
        </defs>

        {edges.map((e) => {
          const from = positions.get(e.from)!;
          const to = positions.get(e.to)!;
          // Shorten the line so the arrowhead lands outside the node circle.
          const dx = to.x - from.x;
          const dy = to.y - from.y;
          const len = Math.hypot(dx, dy) || 1;
          const pad = 34;
          const color = INTERACTION_COLOR[e.interaction] ?? "var(--ink-3)";
          const isSynth = e.interaction === "synthesize";
          return (
            <line
              key={`${e.from}-${e.to}-${e.interaction}`}
              x1={from.x + (dx / len) * pad}
              y1={from.y + (dy / len) * pad}
              x2={to.x - (dx / len) * pad}
              y2={to.y - (dy / len) * pad}
              stroke={color}
              strokeWidth={isSynth ? 1 : 1.6}
              strokeDasharray={isSynth ? "3 3" : undefined}
              markerEnd={`url(#arrow-${e.interaction})`}
              opacity={isSynth ? 0.45 : 0.85}
            />
          );
        })}

        {genome.agents.map((agent) => {
          const pos = positions.get(agent.id)!;
          const isSynth = agent.id === genome.synthesizerId;
          return (
            <g key={agent.id}>
              <circle
                cx={pos.x}
                cy={pos.y}
                r={isSynth ? 32 : 28}
                fill={isSynth ? "var(--accent-soft)" : "var(--panel)"}
                stroke={isSynth ? "var(--accent)" : "var(--line-2)"}
                strokeWidth={isSynth ? 2 : 1.4}
              />
              <text
                x={pos.x}
                y={pos.y + 1}
                textAnchor="middle"
                fontSize="9"
                fontWeight="600"
                fill="var(--ink)"
              >
                {agent.id.length > 9 ? `${agent.id.slice(0, 8)}…` : agent.id}
              </text>
              <text
                x={pos.x}
                y={pos.y + 12}
                textAnchor="middle"
                fontSize="7.5"
                fill="var(--ink-3)"
              >
                {agent.cognitiveMode}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="row" style={{ justifyContent: "center", gap: 12, marginTop: 8 }}>
        {[...new Set(edges.map((e) => e.interaction))].map((kind) => (
          <span key={kind} className="row" style={{ gap: 5, fontSize: 11 }}>
            <span
              style={{
                width: 14,
                height: 2,
                background: INTERACTION_COLOR[kind] ?? "var(--ink-3)",
                display: "inline-block",
              }}
            />
            <span className="muted">{kind}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
