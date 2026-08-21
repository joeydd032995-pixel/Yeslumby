import type { RoundResult } from "@meta/runtime";

/**
 * Turn a round into the prose a human will grade.
 *
 * Deliberately plain and uniform. If the organization's output arrived in a
 * richer format than a single model's, a grader would be scoring presentation
 * rather than reasoning, and the comparison would flatter the more elaborate
 * pipeline for reasons that have nothing to do with whether it thinks better.
 */
export function renderSynthesis(result: RoundResult): string {
  const s = result.synthesis;
  const lines: string[] = [];

  if (s.summary) lines.push(s.summary.trim(), "");

  if (s.highConfidence.length) {
    lines.push("**Findings**", "");
    for (const c of s.highConfidence) lines.push(`- ${c.text}`);
    lines.push("");
  }
  if (s.workingHypotheses.length) {
    lines.push("**Working hypotheses**", "");
    for (const c of s.workingHypotheses) lines.push(`- ${c.text}`);
    lines.push("");
  }
  if (s.contested.length) {
    lines.push("**Unresolved disagreement**", "");
    for (const c of s.contested) {
      lines.push(`- ${c.question}`);
      for (const p of c.positions) lines.push(`    - ${p.position}`);
    }
    lines.push("");
  }
  if (s.unknowns?.length) {
    lines.push("**Open questions**", "");
    for (const u of s.unknowns) lines.push(`- ${u}`);
    lines.push("");
  }
  return lines.join("\n").trim() || "(no content produced)";
}

/** The same shape for a single model's answer, so the two are indistinguishable. */
export function renderPlainAnswer(text: string): string {
  return text.trim() || "(no content produced)";
}
