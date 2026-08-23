import type { ReactNode } from "react";
import { isDeterministic } from "@/lib/runtime";

export function TopBar({ current }: { current?: string }) {
  const links = [
    { href: "/", label: "Recommend" },
    { href: "/dashboard", label: "Dashboard" },
  ];
  return (
    <div className="topbar">
      <div className="topbar-inner">
        <a href="/" className="brand">
          <span className="brand-mark" aria-hidden />
          Meta-Ecosystem
        </a>
        <nav className="topnav">
          {links.map((l) => (
            <a key={l.href} href={l.href} data-active={current === l.href}>
              {l.label}
            </a>
          ))}
        </nav>
      </div>
    </div>
  );
}

/**
 * States plainly which model layer is serving.
 *
 * Cost figures and scores read very differently depending on whether they came
 * from hosted inference or the deterministic provider, and a UI that hid the
 * difference would be presenting simulated numbers as measurements.
 */
export function ProviderBanner() {
  if (!isDeterministic()) return null;
  return (
    <div className="banner" style={{ marginBottom: 16 }}>
      <span className="dot" />
      Deterministic provider — runs are reproducible and costs are modelled from
      published rates, not billed. Set <code>OPENROUTER_API_KEY</code> or{" "}
      <code>AI_GATEWAY_API_KEY</code> for hosted inference (OpenRouter takes
      precedence if both are set).
    </div>
  );
}

export function Panel({
  title,
  action,
  children,
  tight,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  tight?: boolean;
}) {
  return (
    <section className="panel">
      {title && (
        <header className="panel-head">
          <h2>{title}</h2>
          <div style={{ marginLeft: "auto" }}>{action}</div>
        </header>
      )}
      <div className={tight ? "panel-body tight" : "panel-body"}>{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="panel stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Pill({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "good" | "warn" | "bad" | "info";
  children: ReactNode;
}) {
  return <span className={tone === "neutral" ? "pill" : `pill ${tone}`}>{children}</span>;
}

export function Bar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="bar" role="img" aria-label={`${pct.toFixed(0)}%`}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function EcosystemTabs({
  ecosystemId,
  current,
}: {
  ecosystemId: string;
  current: string;
}) {
  const tabs = [
    { key: "genome", label: "Genome", href: `/e/${ecosystemId}` },
    { key: "evolution", label: "Evolution", href: `/e/${ecosystemId}/evolution` },
    { key: "memory", label: "Memory", href: `/e/${ecosystemId}/memory` },
    { key: "benchmarks", label: "Benchmarks", href: `/e/${ecosystemId}/benchmarks` },
  ];
  return (
    <nav className="row" style={{ gap: 6, marginBottom: 16 }}>
      {tabs.map((t) => (
        <a
          key={t.key}
          href={t.href}
          className="btn"
          style={
            current === t.key
              ? { background: "var(--panel-2)", borderColor: "var(--line-2)", fontWeight: 600 }
              : undefined
          }
        >
          {t.label}
        </a>
      ))}
    </nav>
  );
}

export const usd = (n: number | string | null | undefined): string => {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  if (!Number.isFinite(v)) return "—";
  return v === 0 ? "$0" : v < 0.01 ? `$${v.toFixed(6)}` : `$${v.toFixed(4)}`;
};

export const pct = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : n.toFixed(3);
