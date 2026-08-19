export {
  buildPrompt,
  sanitizeUntrusted,
  deriveNonce,
  systemPolicy,
  type Channel,
  type ChannelKind,
  type ChannelItem,
  type BuiltPrompt,
  type BuildPromptInput,
} from "./prompt.js";

export {
  durableStep,
  stepKey,
  serializeError,
  type JournalContext,
  type StepSpec,
  type StepResult,
} from "./journal.js";

export {
  SourceRefSchema,
  ClaimSchema,
  ProposalSchema,
  ChallengeSchema,
  FalsificationSchema,
  SynthesisSchema,
  ContestedClaimSchema,
  WatcherEvaluationSchema,
  WatcherScoresSchema,
  ContextSchema,
  jsonSchemaFor,
  type SourceRef,
  type Claim,
  type Proposal,
  type Challenge,
  type Falsification,
  type Synthesis,
  type ContestedClaim,
  type WatcherEvaluation,
  type WatcherScores,
  type StageContext,
} from "./schemas.js";

export type {
  RunContext,
  RunEvent,
  KnowledgeRecall,
  RecalledKnowledge,
  StageCost,
} from "./context.js";

export { runContextStage, type ContextResult, type PriorRound } from "./stages/context.js";
export {
  runProposals,
  buildProposalChannels,
  type ProposalInputs,
  type ProposalOutcome,
  type ProposalsResult,
} from "./stages/proposals.js";
export {
  runChallenges,
  computeDisagreement,
  type ChallengeOutcome,
  type ChallengesResult,
} from "./stages/challenges.js";
export {
  runFalsification,
  selectFalsifier,
  type FalsificationOutcome,
  type FalsificationResult,
} from "./stages/falsification.js";
export {
  runSynthesis,
  checkDisagreementPreserved,
  type SynthesisResult,
  type SynthesisInputs,
} from "./stages/synthesis.js";
export {
  runWatcher,
  filterPrivilegedMutations,
  groundEfficiency,
  type WatcherResult,
  type WatcherInputs,
} from "./stages/watcher.js";
export { callAgent, summarizeProposal, type AgentCallResult } from "./stages/shared.js";

export {
  runEcosystem,
  summarizeRound,
  isStagnant,
  type IterationRecord,
  type EcosystemRunResult,
  type RunEcosystemOptions,
} from "./orchestrator.js";

export {
  executeRound,
  shouldContinue,
  requiresApproval,
  STAGES,
  type Stage,
  type RoundResult,
  type RoundOptions,
} from "./machine.js";
