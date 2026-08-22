export {
  proposeAndApplyMutation,
  applyApprovedMutation,
  promoteVersion,
  describeDiff,
  type MutationResult,
  type MutationDeps,
  type ProposeMutationInput,
} from "./mutate.js";

export {
  evolveEcosystem,
  type EvolveDeps,
  type EvolveOptions,
  type EvolveResult,
  type GenerationRecord,
} from "./evolve.js";

export {
  type GenerationAssessor,
  type GenerationAssessment,
  type PromotionVerdict,
  type AssessInput,
} from "./assess.js";

export {
  crossover,
  repair,
  type CrossoverStrategy,
  type BreedOptions,
  type Candidate,
} from "./breed.js";

export {
  forkEcosystem,
  materializeChild,
  type ForkInput,
  type ForkResult,
} from "./fork.js";

export {
  recommendGenome,
  classifyObjective,
  type Recommendation,
  type RecommendInput,
} from "./recommend.js";
