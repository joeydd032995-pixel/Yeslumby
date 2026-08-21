/**
 * Objectives for validation.
 *
 * Two properties matter more than the specific questions. First, they are
 * *contested* — questions with a settled answer would be answered as well by a
 * single model, and would test nothing about an organization built to surface
 * disagreement. Second, the sets are disjoint: an architecture evolved against
 * `TRAINING` is measured on `HELD_OUT`, because an evolutionary loop scored on
 * the objectives it was tuned against will always look like it is improving.
 */

export interface ValidationTask {
  id: string;
  objective: string;
  problemClass: string;
}

/** Objectives evolution is allowed to see. */
export const TRAINING: ValidationTask[] = [
  {
    id: "t_replication",
    problemClass: "contested-empirical",
    objective:
      "A widely cited study reports a large effect that three replication attempts failed to " +
      "reproduce, while the original authors point to methodological differences. What should " +
      "we conclude, and what would settle it?",
  },
  {
    id: "t_minimum_wage",
    problemClass: "contested-empirical",
    objective:
      "Does raising a local minimum wage reduce employment? Studies disagree sharply. What does " +
      "the weight of evidence support, and what would distinguish the competing explanations?",
  },
  {
    id: "t_remote_productivity",
    problemClass: "contested-empirical",
    objective:
      "Is remote work more or less productive than in-office work for software teams? Identify " +
      "what the evidence actually establishes versus what is asserted.",
  },
  {
    id: "t_microplastics",
    problemClass: "risk-assessment",
    objective:
      "How concerned should a policymaker be about microplastics in drinking water, given the " +
      "current state of evidence on human health effects?",
  },
  {
    id: "t_nuclear",
    problemClass: "decision-under-uncertainty",
    objective:
      "Should a mid-sized country expand nuclear power to meet decarbonisation targets? Lay out " +
      "the strongest case each way and what evidence would move the decision.",
  },
  {
    id: "t_ai_jobs",
    problemClass: "forecasting",
    objective:
      "What does the evidence say about AI's effect on employment in knowledge work over the " +
      "next five years, and how confident can anyone reasonably be?",
  },
  {
    id: "t_supplements",
    problemClass: "contested-empirical",
    objective:
      "Do omega-3 supplements reduce cardiovascular risk? Trials and meta-analyses conflict. " +
      "What is the defensible conclusion?",
  },
  {
    id: "t_housing",
    problemClass: "contested-empirical",
    objective:
      "Does building more market-rate housing lower rents in a city? Separate what is " +
      "theoretically expected from what has been empirically shown.",
  },
];

/** Objectives evolution never sees. Every reported improvement is measured here. */
export const HELD_OUT: ValidationTask[] = [
  {
    id: "h_screen_time",
    problemClass: "contested-empirical",
    objective:
      "Is adolescent social media use a cause of rising mental health problems, or a correlate? " +
      "What would distinguish the two, and what does current evidence support?",
  },
  {
    id: "h_gut_microbiome",
    problemClass: "contested-empirical",
    objective:
      "How much of the gut microbiome's claimed influence on mood is established causally rather " +
      "than by association?",
  },
  {
    id: "h_congestion",
    problemClass: "policy-evaluation",
    objective:
      "Did congestion pricing work in the cities that adopted it? Define 'work' before answering, " +
      "and say what the data can and cannot show.",
  },
  {
    id: "h_lab_leak",
    problemClass: "contested-empirical",
    objective:
      "What can be said with confidence about competing explanations for the origin of a novel " +
      "pathogen when key evidence is unavailable?",
  },
  {
    id: "h_four_day_week",
    problemClass: "policy-evaluation",
    objective:
      "Do four-day work week trials demonstrate sustained productivity gains, or do their designs " +
      "limit what can be concluded?",
  },
  {
    id: "h_early_reading",
    problemClass: "contested-empirical",
    objective:
      "Does teaching reading earlier improve long-run literacy outcomes? Weigh the evidence and " +
      "name the strongest objection to your own conclusion.",
  },
  {
    id: "h_carbon_offsets",
    problemClass: "risk-assessment",
    objective:
      "Are forestry carbon offsets delivering the reductions they claim? Identify where the " +
      "uncertainty is irreducible versus merely unmeasured.",
  },
  {
    id: "h_statins",
    problemClass: "decision-under-uncertainty",
    objective:
      "Should statins be prescribed for primary prevention in low-risk patients? Present the " +
      "disagreement honestly rather than resolving it prematurely.",
  },
];

export const ALL_TASKS = [...TRAINING, ...HELD_OUT];
