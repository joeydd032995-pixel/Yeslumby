import type { BenchmarkSuite } from "./harness.js";

/**
 * A default suite spanning the problem classes the starter genomes target.
 *
 * Tasks are deliberately open-ended. A benchmark of questions with single
 * correct answers would select for organizations that answer quickly and
 * confidently, which is the opposite of what this runtime is for — the
 * dimensions being scored are about how an organization handles a question it
 * cannot fully settle.
 *
 * **On the task count.** Twelve, not five, because this suite is now also the
 * evidence behind promotion decisions: `createBenchmarkAssessor` pairs per-task
 * scores between two genomes and bootstraps an interval around the difference,
 * and an interval built on five pairs is too wide to clear zero except for
 * enormous effects. More tasks buy power directly. Twelve is still modest — the
 * interval will decline to promote some genuinely better architectures — and
 * that is the intended direction of error, since the failure it replaces was
 * promoting noise.
 *
 * **On the suite id.** `standard-v1` is deliberately unchanged despite the added
 * tasks. Seeds are `contentHash({ suiteId, taskId, genomeHash })`, so holding the
 * id fixed means every task that already existed keeps its exact seed and every
 * `benchmark_results` row recorded against it stays comparable. Bumping to a
 * `-v2` would silently re-seed the original five and quietly invalidate the
 * history. Only the suite-level average moves, which is the point.
 *
 * `expectedFindings` feeds the **`coverage` diagnostic, not the score** — it is
 * deliberately outside `DEFAULT_DIMENSIONS`, for the reasons set out there. A
 * task gaining or losing an entry therefore cannot move a promotion decision,
 * which is why adding them is safe and why they are worth keeping accurate
 * anyway: they are the only read on whether an organization reached the ground
 * the question was about.
 *
 * Entries appear only where a specific term is genuinely load-bearing. Matching
 * is literal substring, so a vague entry produces a false negative and a generic
 * one ("cost", "analysis") matches any text and produces a false positive.
 * Entries are stems where the stem is itself a word — "confound" catches
 * "confounding" and "confounder" — and most tasks below carry none, which is the
 * honest default.
 */
export const STANDARD_SUITE: BenchmarkSuite = {
  id: "standard-v1",
  name: "Standard Reasoning Suite",
  tasks: [
    {
      id: "contested-evidence",
      problemClass: "empirical-research",
      objective:
        "A widely cited study reports a large effect that three replication attempts failed to " +
        "reproduce, while the original authors point to methodological differences. What should " +
        "we conclude, and what would settle it?",
      expectedFindings: ["replication", "method"],
    },
    {
      id: "causal-ambiguity",
      problemClass: "empirical-research",
      objective:
        "Teams that adopted the new deployment process ship 30% more frequently. Did the process " +
        "cause the improvement?",
      expectedFindings: ["confound", "selection"],
    },
    {
      id: "survivorship-sample",
      problemClass: "empirical-research",
      objective:
        "Every company in our dataset that adopted the practice went on to outperform its sector. " +
        "The dataset was assembled by surveying the current membership of an industry association. " +
        "What does the pattern support?",
      expectedFindings: ["survivor", "sample"],
    },
    {
      id: "effect-size",
      problemClass: "empirical-research",
      objective:
        "A trial with 40,000 participants reports an improvement significant at p < 0.001. The " +
        "absolute difference between arms is 0.3%. Should that change what we do?",
      expectedFindings: ["effect size"],
    },
    {
      id: "mechanism-unknown",
      problemClass: "empirical-research",
      objective:
        "Two independently collected datasets agree that the intervention works, and nobody can " +
        "explain why it would. Is an unexplained mechanism a reason to distrust the result or a " +
        "reason to deploy it and keep watching?",
    },
    {
      id: "tradeoff-decision",
      problemClass: "general-analysis",
      objective:
        "Should a small engineering team migrate a working monolith to microservices to prepare " +
        "for growth they expect but have not yet seen?",
    },
    {
      id: "underspecified-brief",
      problemClass: "general-analysis",
      objective: "Make our onboarding better.",
    },
    {
      id: "metric-gaming",
      problemClass: "general-analysis",
      objective:
        "Median support ticket resolution time fell 40% in the quarter after we made it a team " +
        "objective. Customer satisfaction scores are flat. Did support get better?",
      expectedFindings: ["proxy", "measure"],
    },
    {
      id: "irreversible-commitment",
      problemClass: "general-analysis",
      objective:
        "We can choose a vendor now on roughly 60% of the information we would like, or spend six " +
        "weeks evaluating to reach perhaps 85%. The contract runs two years and migrating away " +
        "mid-term is not realistic. What should govern the decision?",
    },
    {
      id: "conflicting-expert-advice",
      problemClass: "general-analysis",
      objective:
        "Two consultants we trust have given opposite recommendations on the same question, each " +
        "citing their own experience and neither citing data we can inspect. How should we proceed?",
    },
    {
      id: "cheap-triage",
      problemClass: "triage",
      objective:
        "Classify this support ticket and recommend the next action: 'Login worked yesterday, " +
        "now it loops back to the sign-in page after I enter my password.'",
    },
    {
      id: "escalation-triage",
      problemClass: "triage",
      objective:
        "Classify this report and recommend the next action: 'Our nightly export finished but the " +
        "row count is about 8% lower than usual. No errors in the log. Probably fine?'",
    },
  ],
};

/** A single-task suite for fast comparisons during development. */
export const SMOKE_SUITE: BenchmarkSuite = {
  id: "smoke-v1",
  name: "Smoke",
  tasks: [STANDARD_SUITE.tasks[0]!],
};
