import type { ArchitectureGenomeInput } from "./schema.js";
import { parseGenome } from "./validate.js";
import type { ArchitectureGenome } from "./schema.js";

/**
 * Starter organizations.
 *
 * These are what the landing experience offers when a user describes an outcome
 * rather than configuring a genome by hand. Each one is a real, valid genome —
 * not a stub — so "recommend me an architecture" produces something runnable on
 * the first click. Every template pairs a Watcher from a different model family
 * than its Synthesizer, so evaluation is not grading its own house style.
 */

const watcherModel = { primary: "openai/gpt-4o", fallbacks: ["openai/gpt-4o-mini"] };

export const BALANCED_ANALYSIS: ArchitectureGenomeInput = {
  name: "Balanced Analysis",
  description:
    "Three independent analysts with distinct cognitive modes, mutual challenge, " +
    "and a dedicated synthesizer that preserves unresolved disagreement.",
  problemClass: "general-analysis",
  tags: ["starter", "balanced"],
  agents: [
    {
      id: "empiricist",
      name: "Empiricist",
      role: "Ground claims in observable evidence and named sources",
      cognitiveMode: "empirical",
      systemPrompt:
        "You reason from evidence. State what is observed, cite where it came from, and " +
        "mark the boundary between what the evidence supports and what it does not. " +
        "Prefer an explicit unknown over a confident guess.",
      model: { primary: "anthropic/claude-sonnet-4" },
      weight: 1,
    },
    {
      id: "systems-thinker",
      name: "Systems Thinker",
      role: "Surface second-order effects, feedback loops, and structural causes",
      cognitiveMode: "systems",
      systemPrompt:
        "You reason about structure. Identify feedback loops, incentives, and downstream " +
        "effects that a first-order reading would miss. Name the mechanism, not just the " +
        "correlation.",
      model: { primary: "anthropic/claude-sonnet-4" },
      weight: 1,
    },
    {
      id: "skeptic",
      name: "Skeptic",
      role: "Attack the weakest link in every proposed account",
      cognitiveMode: "adversarial",
      systemPrompt:
        "You look for what breaks. Find the assumption that, if false, collapses the " +
        "argument. Prefer a specific counterexample to a general doubt.",
      model: { primary: "anthropic/claude-sonnet-4", temperature: 0.9 },
      weight: 1,
    },
    {
      id: "synthesizer",
      name: "Synthesizer",
      role: "Integrate the argument graph without flattening disagreement",
      cognitiveMode: "synthetic",
      systemPrompt:
        "You integrate. Separate what the evidence settles from what it does not. " +
        "Where agents disagree and the evidence does not adjudicate, report the " +
        "disagreement and what would resolve it. Never average positions into a bland middle.",
      model: { primary: "anthropic/claude-opus-4", temperature: 0.4 },
      proposes: false,
      weight: 1,
    },
  ],
  edges: [
    { from: "skeptic", to: "empiricist", interaction: "challenge" },
    { from: "skeptic", to: "systems-thinker", interaction: "challenge" },
    { from: "empiricist", to: "systems-thinker", interaction: "verify" },
    { from: "systems-thinker", to: "empiricist", interaction: "extend" },
    { from: "empiricist", to: "synthesizer", interaction: "synthesize" },
    { from: "systems-thinker", to: "synthesizer", interaction: "synthesize" },
    { from: "skeptic", to: "synthesizer", interaction: "synthesize" },
  ],
  synthesizerId: "synthesizer",
  watcher: { model: watcherModel },
};

export const ADVERSARIAL_RESEARCH: ArchitectureGenomeInput = {
  name: "Adversarial Research",
  description:
    "Evidence-heavy organization for contested empirical questions. Two proposers, " +
    "a dedicated falsifier, and a verifier that checks claims against sources.",
  problemClass: "empirical-research",
  tags: ["starter", "research", "high-rigor"],
  agents: [
    {
      id: "investigator",
      name: "Investigator",
      role: "Build the strongest evidence-backed account",
      cognitiveMode: "empirical",
      systemPrompt:
        "You build the best-supported account of the question. Every non-obvious claim " +
        "carries its source. Distinguish direct evidence from inference.",
      model: { primary: "anthropic/claude-sonnet-4" },
      capabilities: ["web_search"],
    },
    {
      id: "contrarian",
      name: "Contrarian",
      role: "Build the strongest opposing account",
      cognitiveMode: "critical",
      systemPrompt:
        "You build the strongest case against the leading account — not for its own sake, " +
        "but because an account that survives real opposition is worth more than one that " +
        "was never tested. Steelman the opposition.",
      model: { primary: "anthropic/claude-sonnet-4", temperature: 0.85 },
      capabilities: ["web_search"],
    },
    {
      id: "falsifier",
      name: "Falsifier",
      role: "Name the observation that would prove each claim wrong",
      cognitiveMode: "adversarial",
      systemPrompt:
        "For each claim you are given, state what observation would falsify it, what " +
        "evidence would disconfirm it, and a concrete test that could be run. A claim with " +
        "no falsifier is not a finding — say so.",
      model: { primary: "anthropic/claude-sonnet-4", temperature: 0.5 },
    },
    {
      id: "arbiter",
      name: "Arbiter",
      role: "Integrate competing accounts and report what remains contested",
      cognitiveMode: "synthetic",
      systemPrompt:
        "You adjudicate. Where the evidence settles a question, say so and cite it. Where " +
        "two accounts both survive scrutiny, report both, say what distinguishes them, and " +
        "name the experiment that would decide.",
      model: { primary: "anthropic/claude-opus-4", temperature: 0.3 },
      proposes: false,
    },
  ],
  edges: [
    { from: "contrarian", to: "investigator", interaction: "challenge" },
    { from: "investigator", to: "contrarian", interaction: "challenge" },
    { from: "falsifier", to: "investigator", interaction: "verify" },
    { from: "falsifier", to: "contrarian", interaction: "verify" },
    { from: "investigator", to: "arbiter", interaction: "synthesize" },
    { from: "contrarian", to: "arbiter", interaction: "synthesize" },
    { from: "falsifier", to: "arbiter", interaction: "synthesize" },
  ],
  synthesizerId: "arbiter",
  protocols: { maxRounds: 2, disagreementThreshold: 0.25 },
  watcher: {
    model: watcherModel,
    dimensions: ["diversity", "challengeQuality", "independence", "evidenceQuality", "efficiency"],
  },
  stopCriteria: { maxIterations: 3, targetScore: 0.9 },
};

export const RAPID_TRIAGE: ArchitectureGenomeInput = {
  name: "Rapid Triage",
  description:
    "Two cheap proposers and a light synthesizer, for high-volume questions where " +
    "cost per answer matters more than exhaustive rigor.",
  problemClass: "triage",
  tags: ["starter", "low-cost"],
  agents: [
    {
      id: "pragmatist",
      name: "Pragmatist",
      role: "Give the most useful actionable answer",
      cognitiveMode: "pragmatic",
      systemPrompt:
        "Answer the question as directly as the evidence allows. Lead with the " +
        "recommendation, then the reasoning. Flag anything you are guessing at.",
      model: { primary: "anthropic/claude-haiku-4" },
    },
    {
      id: "checker",
      name: "Checker",
      role: "Catch errors and unstated assumptions",
      cognitiveMode: "critical",
      systemPrompt:
        "Review for errors, unstated assumptions, and overconfidence. Be brief: name the " +
        "problem and the fix.",
      model: { primary: "anthropic/claude-haiku-4" },
    },
    {
      id: "closer",
      name: "Closer",
      role: "Produce the final answer",
      cognitiveMode: "synthetic",
      systemPrompt:
        "Produce the final answer. Keep what survived review, drop what did not, and state " +
        "any remaining uncertainty in one line.",
      model: { primary: "anthropic/claude-sonnet-4", temperature: 0.3 },
      proposes: false,
    },
  ],
  edges: [
    { from: "checker", to: "pragmatist", interaction: "challenge" },
    { from: "pragmatist", to: "closer", interaction: "synthesize" },
    { from: "checker", to: "closer", interaction: "synthesize" },
  ],
  synthesizerId: "closer",
  protocols: { falsificationRequired: false, maxRounds: 1 },
  watcher: { model: { primary: "openai/gpt-4o-mini" }, dimensions: ["efficiency", "diversity"] },
  stopCriteria: { maxIterations: 1, maxCostUsd: 0.5 },
  memoryPolicy: { recallLimit: 4 },
};

export interface GenomeTemplate {
  key: string;
  title: string;
  summary: string;
  problemClass: string;
  input: ArchitectureGenomeInput;
}

export const TEMPLATES: readonly GenomeTemplate[] = [
  {
    key: "balanced-analysis",
    title: "Balanced Analysis",
    summary: "Three cognitive modes, mutual challenge, disagreement preserved.",
    problemClass: "general-analysis",
    input: BALANCED_ANALYSIS,
  },
  {
    key: "adversarial-research",
    title: "Adversarial Research",
    summary: "Competing accounts plus a dedicated falsifier. Highest rigor, highest cost.",
    problemClass: "empirical-research",
    input: ADVERSARIAL_RESEARCH,
  },
  {
    key: "rapid-triage",
    title: "Rapid Triage",
    summary: "Two small models and a light synthesizer. Optimized for cost per answer.",
    problemClass: "triage",
    input: RAPID_TRIAGE,
  },
];

/** Parse a template by key. Throws if the key is unknown. */
export function loadTemplate(key: string): ArchitectureGenome {
  const template = TEMPLATES.find((t) => t.key === key);
  if (!template) {
    throw new Error(`unknown genome template "${key}"`);
  }
  return parseGenome(template.input);
}
