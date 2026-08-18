import type { BenchmarkSuite } from "./harness.js";

/**
 * A default suite spanning the problem classes the starter genomes target.
 *
 * Tasks are deliberately open-ended. A benchmark of questions with single
 * correct answers would select for organizations that answer quickly and
 * confidently, which is the opposite of what this runtime is for — the
 * dimensions being scored are about how an organization handles a question it
 * cannot fully settle.
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
      id: "cheap-triage",
      problemClass: "triage",
      objective:
        "Classify this support ticket and recommend the next action: 'Login worked yesterday, " +
        "now it loops back to the sign-in page after I enter my password.'",
    },
  ],
};

/** A single-task suite for fast comparisons during development. */
export const SMOKE_SUITE: BenchmarkSuite = {
  id: "smoke-v1",
  name: "Smoke",
  tasks: [STANDARD_SUITE.tasks[0]!],
};
