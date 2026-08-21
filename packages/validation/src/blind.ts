import { createHash } from "node:crypto";

/**
 * Blinded grading.
 *
 * Every experiment here ends in a human judging output, and a human who can
 * tell which answer came from the evolved architecture will confirm whatever
 * they expect. The blinding is therefore not a formality: it is the only thing
 * standing between this harness and an elaborate way of agreeing with itself.
 *
 * An item's provenance is kept on the key, never on the sheet. The sheet
 * carries an opaque id, and the mapping back is held separately so it cannot
 * be read by accident while grading.
 */

export interface GradableItem<M> {
  /** Whatever identifies this item to the experiment — never shown to a grader. */
  provenance: M;
  /** The text a human will read and score. */
  content: string;
}

export interface BlindEntry {
  id: string;
  content: string;
}

export interface BlindKey<M> {
  id: string;
  provenance: M;
}

export interface BlindSet<M> {
  entries: BlindEntry[];
  key: BlindKey<M>[];
}

/**
 * Shuffle deterministically from a seed so a run is reproducible, while the
 * order still carries no information about condition.
 */
function shuffle<T>(items: readonly T[], seed: string): T[] {
  const out = [...items];
  let state = parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function blind<M>(items: readonly GradableItem<M>[], seed: string): BlindSet<M> {
  const shuffled = shuffle(items, seed);
  const entries: BlindEntry[] = [];
  const key: BlindKey<M>[] = [];

  shuffled.forEach((item, index) => {
    // Derived from the seed and position, not from the provenance — an id
    // computed from what it labels would leak through comparison.
    const id = createHash("sha256").update(`${seed}:${index}`).digest("hex").slice(0, 10);
    entries.push({ id, content: item.content });
    key.push({ id, provenance: item.provenance });
  });

  return { entries, key };
}

/** Join grades back to provenance. Unknown or ungraded ids are reported, not ignored. */
export function join<M>(
  set: BlindSet<M>,
  grades: Record<string, number | null>,
): { graded: Array<{ provenance: M; grade: number }>; missing: string[]; unknown: string[] } {
  const byId = new Map(set.key.map((k) => [k.id, k.provenance]));
  const graded: Array<{ provenance: M; grade: number }> = [];
  const missing: string[] = [];

  for (const entry of set.entries) {
    const grade = grades[entry.id];
    if (grade === undefined || grade === null) {
      missing.push(entry.id);
      continue;
    }
    graded.push({ provenance: byId.get(entry.id)!, grade });
  }

  const known = new Set(set.entries.map((e) => e.id));
  const unknown = Object.keys(grades).filter((id) => !known.has(id));
  return { graded, missing, unknown };
}

/** The sheet a human reads. Contains content and ids, and nothing else. */
export function renderSheet(set: BlindSet<unknown>, instructions: string): string {
  const lines = [
    "# Blind grading sheet",
    "",
    instructions,
    "",
    "Put your score in `grades.json` next to the matching id. Grade every item, or",
    "leave it null — a skipped item is reported rather than quietly dropped.",
    "",
  ];
  for (const entry of set.entries) {
    lines.push(`## ${entry.id}`, "", entry.content.trim(), "", "---", "");
  }
  return lines.join("\n");
}

/** The file a human edits: every id, awaiting a number. */
export function renderGradesTemplate(set: BlindSet<unknown>): string {
  const obj: Record<string, null> = {};
  for (const entry of set.entries) obj[entry.id] = null;
  return JSON.stringify(obj, null, 2) + "\n";
}
