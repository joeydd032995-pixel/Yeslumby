import { TEMPLATES, loadTemplate, type ArchitectureGenome } from "@meta/genome";
import { recallStructuralAcross, type EmbeddingProvider, type StructuralLesson } from "@meta/memory";
import type { Sql } from "@meta/db";

/**
 * "Describe an outcome, get an architecture."
 *
 * This is where evolutionary memory pays for itself. A new user has no history,
 * so the recommendation starts from a template — but every structural lesson
 * any visible ecosystem has learned about this class of problem is consulted
 * before answering, and lessons override the default. That is the difference
 * between a template picker and a system that gets better at picking.
 *
 * The caller supplies which ecosystems may be learned from. Deciding that is an
 * authorization question, and answering it in here would bury it somewhere
 * nobody audits.
 */

export interface Recommendation {
  templateKey: string;
  genome: ArchitectureGenome;
  problemClass: string;
  confidence: number;
  rationale: string;
  /** Prior structural lessons that informed this, for display. */
  lessons: StructuralLesson[];
  alternatives: Array<{ templateKey: string; title: string; why: string }>;
}

interface ClassSignal {
  problemClass: string;
  templateKey: string;
  keywords: string[];
}

/**
 * Keyword classification.
 *
 * Deliberately a heuristic, and cheap enough to run on every keystroke of the
 * landing page. A model call would classify better, but this path must answer
 * before the user has committed anything, and the recommendation is a starting
 * point the user can override rather than a decision they are stuck with.
 */
const SIGNALS: ClassSignal[] = [
  {
    problemClass: "empirical-research",
    templateKey: "adversarial-research",
    keywords: [
      "research", "evidence", "study", "studies", "replicate", "replication",
      "causal", "correlation", "hypothesis", "experiment", "literature",
      "prove", "disprove", "claim", "contested", "debate", "verify",
    ],
  },
  {
    problemClass: "triage",
    templateKey: "rapid-triage",
    keywords: [
      "triage", "quick", "quickly", "fast", "cheap", "bulk", "volume", "screen",
      "classify", "categorize", "route", "summarize", "draft", "simple",
    ],
  },
  {
    problemClass: "general-analysis",
    templateKey: "balanced-analysis",
    keywords: [
      "analyze", "analysis", "assess", "evaluate", "compare", "strategy",
      "decide", "decision", "tradeoff", "recommend", "should", "risk", "plan",
    ],
  },
];

/**
 * The confidence reported when the objective matched no keyword at all.
 *
 * At this value the returned `problemClass` and `templateKey` are the fallback
 * signal rather than a classification — nothing about the objective selected
 * them. Exported so a caller can say so to the user instead of presenting a
 * guess and a match identically, which is what the landing page did while this
 * number was a literal buried in here.
 */
export const UNCLASSIFIED_CONFIDENCE = 0.3;

export function classifyObjective(objective: string): {
  problemClass: string;
  templateKey: string;
  confidence: number;
} {
  const words = new Set(objective.toLowerCase().split(/[^a-z]+/).filter(Boolean));

  let best = { signal: SIGNALS[2]!, hits: 0 };
  for (const signal of SIGNALS) {
    const hits = signal.keywords.filter((k) => words.has(k)).length;
    if (hits > best.hits) best = { signal, hits };
  }

  // Confidence rises with evidence but never reaches certainty: this is a
  // keyword match, and presenting it as more would be dishonest to the user
  // deciding whether to accept the suggestion.
  const confidence =
    best.hits === 0 ? UNCLASSIFIED_CONFIDENCE : Math.min(0.85, 0.4 + best.hits * 0.15);

  return {
    problemClass: best.signal.problemClass,
    templateKey: best.signal.templateKey,
    confidence,
  };
}

export interface RecommendInput {
  objective: string;
  /** Ecosystems whose structural lessons this caller may learn from. */
  visibleEcosystemIds?: string[];
}

export async function recommendGenome(
  deps: { sql: Sql; embedder: EmbeddingProvider },
  input: RecommendInput,
): Promise<Recommendation> {
  const classified = classifyObjective(input.objective);

  const lessons =
    input.visibleEcosystemIds && input.visibleEcosystemIds.length > 0
      ? await recallStructuralAcross(deps.sql, deps.embedder, {
          ecosystemIds: input.visibleEcosystemIds,
          query: input.objective,
          problemClass: classified.problemClass,
          limit: 5,
        })
      : [];

  let templateKey = classified.templateKey;
  let confidence = classified.confidence;
  let rationale =
    `Classified as ${classified.problemClass} from the objective. ` +
    `${describeTemplate(templateKey)}`;

  // A lesson naming a template for this problem class is direct evidence from
  // a real run, and outranks the keyword guess.
  const decisive = lessons.find((l) => l.importance >= 0.7 && namedTemplate(l.content));
  if (decisive) {
    const named = namedTemplate(decisive.content)!;
    if (named !== templateKey) {
      templateKey = named;
      rationale =
        `Prior runs on ${classified.problemClass} problems favour this architecture: ` +
        `"${truncate(decisive.content, 160)}"`;
    } else {
      rationale += ` Prior runs on this problem class support that choice.`;
    }
    confidence = Math.min(0.95, confidence + 0.2);
  }

  return {
    templateKey,
    genome: loadTemplate(templateKey),
    problemClass: classified.problemClass,
    confidence: Math.round(confidence * 100) / 100,
    rationale,
    lessons,
    alternatives: TEMPLATES.filter((t) => t.key !== templateKey).map((t) => ({
      templateKey: t.key,
      title: t.title,
      why: t.summary,
    })),
  };
}

function namedTemplate(content: string): string | undefined {
  const lower = content.toLowerCase();
  return TEMPLATES.find((t) => lower.includes(t.key))?.key;
}

function describeTemplate(key: string): string {
  return TEMPLATES.find((t) => t.key === key)?.summary ?? "";
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
