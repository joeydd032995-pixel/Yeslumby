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
