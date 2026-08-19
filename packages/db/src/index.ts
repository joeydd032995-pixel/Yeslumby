export { createSql, resolveDatabaseUrl, num, type Sql, type DbOptions } from "./client.js";
export { migrate, resetSchema } from "./migrate.js";
export * from "./types.js";

export * as genomes from "./repositories/genomes.js";
export * as runs from "./repositories/runs.js";
export * as tenancy from "./repositories/tenancy.js";
export * as telemetry from "./repositories/telemetry.js";
export * as mutations from "./repositories/mutations.js";

/**
 * The two memory stores are exported under distinct namespaces and are never
 * re-exported into a combined surface. Reading self-knowledge from an agent
 * context builder requires importing `evolutionaryMemory` explicitly, which is
 * visible in review and in the import graph.
 */
export * as knowledgeMemory from "./repositories/memory-knowledge.js";
export * as evolutionaryMemory from "./repositories/memory-evolutionary.js";

export { EMBEDDING_DIMENSIONS, toVector, distanceToSimilarity } from "./repositories/vector.js";
