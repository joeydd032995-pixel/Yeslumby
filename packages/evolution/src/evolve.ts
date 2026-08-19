import { genomes, runs, type Sql } from "@meta/db";
import { hashGenome, type ArchitectureGenome, type MutationPatchInput } from "@meta/genome";
import type { ModelGateway } from "@meta/gateway";
import { runEcosystem, type RunContext, type EcosystemRunResult } from "@meta/runtime";
import type { Clock, IdGenerator } from "@meta/shared";
import type { EmbeddingProvider } from "@meta/memory";
import { consolidateStructural } from "@meta/memory";
import { proposeAndApplyMutation, promoteVersion, describeDiff } from "./mutate.js";

/**
 * The generational loop.
 *
 * This is what "discover, over successive generations, the architecture of
 * intelligence appropriate to a task" actually means, and it is a different loop
 * from `runEcosystem`. There, iterations refine an answer under a *fixed*
 * architecture. Here, each generation produces a new immutable genome version:
 * the architecture itself is what changes.
 *
 * The separation is forced by the thesis rather than chosen for tidiness. A run
 * is pinned to one `genome_version_id`, so a generation is necessarily a new
 * run — which is also what makes generations comparable, since each one is a
 * complete, reproducible execution against a named version.
 *
 * The critical rule is that **a generation is promoted only if it is actually
 * better**. Without that, a mutation engine steered by a noisy evaluator wanders
 * rather than climbs, and the lineage records drift as if it were progress. A
 * regression is not discarded, though: the version stays in the graph and the
 * fact that it lost is written to evolutionary memory, because "we tried this
 * and it was worse" is exactly the knowledge that stops it being retried.
 */

export interface EvolveDeps {
  sql: Sql;
  gateway: ModelGateway;
  clock: Clock;
  ids: IdGenerator;
  embedder: EmbeddingProvider;
}

export interface GenerationRecord {
  generation: number;
  genomeVersionId: string;
  version: number;
  genomeHash: string;
  runId: string;
  /** Watcher score for the best iteration of this generation's run. */
  score: number | null;
  costUsd: number;
  /** Set from generation 2 onward. */
  mutation?: {
    mutationId: string;
    patches: number;
    summary: string;
  };
  outcome: "seed" | "promoted" | "rejected-regression" | "no-mutation" | "awaiting-approval";
  note: string;
}

export interface EvolveResult {
  generations: GenerationRecord[];
  /** The version that ended up current — the best found, not the last tried. */
  championVersionId: string;
  championScore: number | null;
  stoppedBecause: string;
  totalCostUsd: number;
}

export interface EvolveOptions {
  ecosystemId: string;
  /** Starting version. Must belong to `ecosystemId`. */
  fromVersionId: string;
  genome: ArchitectureGenome;
  objective: string;
  /** Deterministic base seed; each generation derives from it. */
  seed: string;
  maxGenerations?: number;
  /** Stop after this many consecutive generations without improvement. */
  patience?: number;
  /** Total spend ceiling across all generations. */
  maxCostUsd?: number;
  /** A score must beat the champion by at least this to count as improvement. */
  minImprovement?: number;
  createdBy?: string | null;
  attribution?: { orgId?: string | null; workspaceId?: string | null };
  onGeneration?: (record: GenerationRecord) => void | Promise<void>;
}

const DEFAULT_PATIENCE = 2;
const DEFAULT_MIN_IMPROVEMENT = 0.01;

export async function evolveEcosystem(
  deps: EvolveDeps,
  options: EvolveOptions,
): Promise<EvolveResult> {
  const maxGenerations = Math.min(options.maxGenerations ?? 3, 10);
  const patience = options.patience ?? DEFAULT_PATIENCE;
  const minImprovement = options.minImprovement ?? DEFAULT_MIN_IMPROVEMENT;
  const budget = options.maxCostUsd ?? Number.POSITIVE_INFINITY;

  const generations: GenerationRecord[] = [];
  let totalCostUsd = 0;
  let stoppedBecause = "reached generation limit";

  let currentGenome = options.genome;
  let currentVersionId = options.fromVersionId;

  let championVersionId = options.fromVersionId;
  let championGenome = options.genome;
  let championScore: number | null = null;
  let sinceImprovement = 0;

  for (let generation = 0; generation < maxGenerations; generation++) {
    const outcome = await runGeneration(deps, options, {
      generation,
      genome: currentGenome,
      versionId: currentVersionId,
    });

    totalCostUsd += outcome.result.totalCostUsd;
    const score = bestScore(outcome.result);

    const record: GenerationRecord = {
      generation,
      genomeVersionId: currentVersionId,
      version: outcome.versionNumber,
      genomeHash: hashGenome(currentGenome),
      runId: outcome.runId,
      score,
      costUsd: outcome.result.totalCostUsd,
      outcome: generation === 0 ? "seed" : "promoted",
      note: outcome.result.stoppedBecause,
    };

    // Generation 0 establishes the baseline; there is nothing to compare to yet.
    if (generation === 0) {
      championScore = score;
      championVersionId = currentVersionId;
      championGenome = currentGenome;
    } else {
      const improved =
        score !== null && (championScore === null || score >= championScore + minImprovement);

      if (improved) {
        championScore = score;
        championVersionId = currentVersionId;
        championGenome = currentGenome;
        sinceImprovement = 0;
        record.outcome = "promoted";
        record.note = `improved to ${score!.toFixed(3)}`;
      } else {
        sinceImprovement += 1;
        record.outcome = "rejected-regression";
        record.note =
          score === null
            ? "no score produced; champion retained"
            : `scored ${score.toFixed(3)} against champion ${championScore?.toFixed(3) ?? "n/a"}; champion retained`;

        // The losing version stays in the lineage — it is a real thing that was
        // tried — but the ecosystem is pointed back at what actually works.
        await promoteVersion(deps.sql, options.ecosystemId, championVersionId);
        currentGenome = championGenome;
        currentVersionId = championVersionId;
      }

      await recordGenerationLesson(deps, options, record, currentGenome);
    }

    generations.push(record);
    await options.onGeneration?.(record);

    if (totalCostUsd >= budget) {
      stoppedBecause = "reached evolution budget";
      break;
    }
    if (sinceImprovement >= patience) {
      stoppedBecause = `no improvement for ${sinceImprovement} generation(s)`;
      break;
    }
    if (generation + 1 >= maxGenerations) {
      stoppedBecause = "reached generation limit";
      break;
    }

    // Mutate for the next generation.
    const patches = collectPatches(outcome.result);
    if (patches.length === 0) {
      stoppedBecause = "watcher proposed no structural change";
      record.outcome = record.outcome === "seed" ? "no-mutation" : record.outcome;
      break;
    }

    const mutation = await proposeAndApplyMutation(
      {
        sql: deps.sql,
        ids: deps.ids,
        memory: {
          sql: deps.sql,
          embedder: deps.embedder,
          ecosystemId: options.ecosystemId,
          policy: currentGenome.memoryPolicy,
        },
      },
      {
        ecosystemId: options.ecosystemId,
        fromVersionId: currentVersionId,
        genome: currentGenome,
        patches,
        actor: "WATCHER",
        runId: outcome.runId,
        rationale: `generation ${generation + 1} → ${generation + 2}`,
        // Unattended evolution is only possible where the genome's own policy
        // permits it; where approval is required the loop stops and says so
        // rather than quietly bypassing the gate.
        humanApproved: false,
        createdBy: options.createdBy ?? null,
      },
    );

    if (mutation.status === "awaiting_approval") {
      record.outcome = "awaiting-approval";
      stoppedBecause = "mutation requires human approval";
      break;
    }
    if (mutation.status !== "applied") {
      stoppedBecause = `mutation ${mutation.status}: ${"reason" in mutation ? mutation.reason : ""}`;
      break;
    }

    record.mutation = {
      mutationId: mutation.mutationId,
      patches: patches.length,
      summary: describeDiff(mutation.diff),
    };

    currentGenome = mutation.genome;
    currentVersionId = mutation.versionId;
    await promoteVersion(deps.sql, options.ecosystemId, currentVersionId);
  }

  // Always leave the ecosystem pointed at the best version found.
  await promoteVersion(deps.sql, options.ecosystemId, championVersionId);

  return {
    generations,
    championVersionId,
    championScore,
    stoppedBecause,
    totalCostUsd,
  };
}

async function runGeneration(
  deps: EvolveDeps,
  options: EvolveOptions,
  gen: { generation: number; genome: ArchitectureGenome; versionId: string },
): Promise<{ result: EcosystemRunResult; runId: string; versionNumber: number }> {
  // Seeds derive from the generation index, so a replay of the whole evolution
  // reproduces every generation exactly.
  const seed = `${options.seed}:gen${gen.generation}`;

  const run = await runs.createRun(deps.sql, {
    id: deps.ids.next("run"),
    ecosystemId: options.ecosystemId,
    genomeVersionId: gen.versionId,
    objective: options.objective,
    seed,
    createdBy: options.createdBy ?? null,
  });

  const ctx: RunContext = {
    sql: deps.sql,
    gateway: deps.gateway,
    clock: deps.clock,
    ids: deps.ids,
    genome: gen.genome,
    run: {
      id: run.id,
      ecosystemId: options.ecosystemId,
      genomeVersionId: gen.versionId,
      objective: options.objective,
      seed,
    },
    iteration: 0,
    attribution: {
      orgId: options.attribution?.orgId ?? null,
      workspaceId: options.attribution?.workspaceId ?? null,
      ecosystemId: options.ecosystemId,
      runId: run.id,
    },
    emit: () => {},
  };

  const result = await runEcosystem(ctx);
  const version = await genomes.getGenomeVersion(deps.sql, gen.versionId);

  return { result, runId: run.id, versionNumber: version?.version ?? 0 };
}

/** Best watcher score across the generation's iterations. */
function bestScore(result: EcosystemRunResult): number | null {
  const scored = result.trajectory.map((t) => t.score).filter((s): s is number => s !== null);
  return scored.length === 0 ? null : Math.max(...scored);
}

/** Patches the Watcher proposed in the generation's final round. */
function collectPatches(result: EcosystemRunResult): MutationPatchInput[] {
  return (result.final.evaluation?.suggestedMutations ?? []) as MutationPatchInput[];
}

/**
 * Write what this generation taught the ecosystem about its own structure.
 *
 * This is the highest-value record the system produces: a promoted generation
 * says a structural change helped on this problem class, and a rejected one says
 * it did not. Both steer future mutation and the genome recommender.
 */
async function recordGenerationLesson(
  deps: EvolveDeps,
  options: EvolveOptions,
  record: GenerationRecord,
  genome: ArchitectureGenome,
): Promise<void> {
  const verdict =
    record.outcome === "promoted"
      ? "improved the result"
      : record.outcome === "rejected-regression"
        ? "did not improve and was rolled back"
        : record.outcome;

  await consolidateStructural(
    {
      sql: deps.sql,
      embedder: deps.embedder,
      ids: deps.ids,
      ecosystemId: options.ecosystemId,
      // Structural lessons outlive the run that produced them, so retention is
      // forced to permanent even under an ephemeral memory policy: an
      // ecosystem that forgets which architectures failed will retry them.
      policy: { ...genome.memoryPolicy, retention: "permanent" },
    },
    [
      {
        content:
          `Generation ${record.generation + 1} on ${genome.problemClass}: ` +
          `${record.mutation?.summary ?? "no structural change"} — ${verdict} ` +
          `(score ${record.score?.toFixed(3) ?? "n/a"}).`,
        type: "STRUCTURAL_LEARNING",
        problemClass: genome.problemClass,
        importance: record.outcome === "promoted" ? 0.9 : 0.8,
        genomeVersionId: record.genomeVersionId,
        sourceRunId: record.runId,
      },
    ],
  );
}
