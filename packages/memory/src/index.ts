export {
  DeterministicEmbedder,
  GatewayEmbedder,
  resolveEmbedder,
  cosineSimilarity,
  type EmbeddingProvider,
  type GatewayEmbedderOptions,
} from "./embedding.js";

export {
  consolidateKnowledge,
  consolidateStructural,
  heuristicContradiction,
  type KnowledgeCandidate,
  type StructuralCandidate,
  type ConsolidationOutcome,
  type ConsolidationDeps,
  type ContradictionDetector,
} from "./consolidate.js";

export {
  createKnowledgeRecall,
  recallStructural,
  recallStructuralAcross,
  type KnowledgeRecallOptions,
  type RecalledKnowledgeItem,
  type StructuralLesson,
} from "./recall.js";
