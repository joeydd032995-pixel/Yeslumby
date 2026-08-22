/**
 * End-to-end demonstration.
 *
 * Runs the full loop against a real Postgres+pgvector database and the
 * deterministic model provider: recommend an architecture, execute a round,
 * evaluate the organization, mutate it into a new immutable version, benchmark
 * the two versions against each other, breed a third from two parents and
 * promote the winner, then evolve under a promotion rule that has to show its
 * evidence.
 *
 *   pnpm db:up && pnpm demo
 */
import { createSql, migrate, genomes, runs, tenancy, telemetry } from "@meta/db";
import { Gateway, SimulatorProvider } from "@meta/gateway";
import { hashGenome, exportArtifact, loadTemplate, parseGenome } from "@meta/genome";
import { DeterministicEmbedder, consolidateKnowledge, createKnowledgeRecall } from "@meta/memory";
import { executeRound, type RunContext } from "@meta/runtime";
import {
  crossover,
  evolveEcosystem,
  materializeChild,
  proposeAndApplyMutation,
  promoteVersion,
  recommendGenome,
  describeDiff,
} from "@meta/evolution";
import { STANDARD_SUITE, compareGenomes, createBenchmarkAssessor } from "@meta/bench";
import { DeterministicIds, FixedClock, randomIds } from "@meta/shared";

const OBJECTIVE =
  "A widely cited study reports a large effect that three replication attempts failed to " +
  "reproduce. What should we conclude, and what would settle it?";

const bold = (s: string) => `[1m${s}[0m`;
const dim = (s: string) => `[2m${s}[0m`;
const green = (s: string) => `[32m${s}[0m`;
const cyan = (s: string) => `[36m${s}[0m`;
const yellow = (s: string) => `[33m${s}[0m`;

function heading(text: string): void {
  console.log(`\n${bold(`── ${text} ${"─".repeat(Math.max(0, 68 - text.length))}`)}`);
}

async function main(): Promise<void> {
  const sql = createSql({
    url:
      process.env.DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5433/meta_ecosystem",
  });

  try {
    await migrate(sql, { silent: true });

    const ids = new DeterministicIds(`demo${Date.now().toString(36)}`);
    const clock = new FixedClock();
    const embedder = new DeterministicEmbedder();
    const simulator = new SimulatorProvider();
    const gateway = new Gateway({
      providers: [simulator],
      clock,
      sleep: async () => {},
      usageSink: {
        record: (event) =>
          telemetry.recordUsage(sql, {
            id: randomIds.next("usageEvent"),
            modelId: event.modelId,
            provider: event.provider,
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            costUsd: event.costUsd,
            unpriced: event.unpriced,
            latencyMs: event.latencyMs,
            ...event.attribution,
          }),
      },
    });

    // --- Tenancy -----------------------------------------------------------
    const orgId = ids.next("org");
    const workspaceId = ids.next("workspace");
    const userId = ids.next("user");
    await tenancy.createOrganization(sql, { id: orgId, name: "Demo Org", slug: orgId });
    await tenancy.createUser(sql, { id: userId, email: "demo@example.test", name: "Demo" });
    await tenancy.addMembership(sql, {
      id: ids.next("evaluation"),
      orgId,
      userId,
      role: "ARCHITECT",
    });
    await tenancy.createWorkspace(sql, {
      id: workspaceId,
      orgId,
      name: "Demo Workspace",
      slug: workspaceId,
    });

    // --- 1. Recommend an architecture from the objective --------------------
    heading("1. Describe an outcome, get an architecture");
    const recommendation = await recommendGenome({ sql, embedder }, { objective: OBJECTIVE });
    console.log(`objective     ${dim(OBJECTIVE.slice(0, 76))}…`);
    console.log(`problem class ${cyan(recommendation.problemClass)}`);
    console.log(
      `recommended   ${green(recommendation.templateKey)} ${dim(`(confidence ${recommendation.confidence})`)}`,
    );
    console.log(`why           ${dim(recommendation.rationale)}`);

    const genome = recommendation.genome;
    const ecosystemId = ids.next("ecosystem");
    await genomes.createEcosystem(sql, {
      id: ecosystemId,
      workspaceId,
      name: genome.name,
      slug: ecosystemId,
      description: genome.description,
      createdBy: userId,
    });

    const { version: v1 } = await genomes.createGenomeVersion(sql, {
      id: ids.next("genomeVersion"),
      ecosystemId,
      genome,
      origin: "SEED",
      createdBy: userId,
    });
    await promoteVersion(sql, ecosystemId, v1.id);
    console.log(
      `\ngenome v1     ${genome.agents.length} agents, ${genome.edges.length} edges, ` +
        `hash ${dim(hashGenome(genome).slice(0, 12))}`,
    );
    for (const agent of genome.agents) {
      console.log(
        `  ${agent.proposes ? "•" : "▸"} ${agent.id.padEnd(16)} ${dim(agent.cognitiveMode.padEnd(12))} ${dim(agent.model.primary)}`,
      );
    }

    // --- 2. Seed some prior knowledge --------------------------------------
    await consolidateKnowledge(
      { sql, embedder, ids, ecosystemId, policy: genome.memoryPolicy },
      [
        {
          content: "Replication rates in this subfield average roughly 40 percent.",
          type: "FACT",
          importance: 0.8,
        },
        {
          content: "Effect sizes typically shrink under preregistration.",
          type: "FACT",
          importance: 0.75,
        },
      ],
    );

    // --- 3. Execute a round -------------------------------------------------
    heading("2. Execute a round");
    const run = await runs.createRun(sql, {
      id: ids.next("run"),
      ecosystemId,
      genomeVersionId: v1.id,
      objective: OBJECTIVE,
      seed: "demo-seed-1",
      createdBy: userId,
    });

    const ctx: RunContext = {
      sql,
      gateway,
      clock,
      ids,
      genome,
      run: {
        id: run.id,
        ecosystemId,
        genomeVersionId: v1.id,
        objective: OBJECTIVE,
        seed: "demo-seed-1",
      },
      iteration: 0,
      attribution: { orgId, workspaceId, ecosystemId, runId: run.id },
      emit: (event) => {
        if (event.type === "stage.start") console.log(`  ${cyan(event.stage)}`);
        if (event.type === "agent.finish") {
          console.log(
            `    ${dim("↳")} ${event.agentId.padEnd(18)} ${dim(`$${event.costUsd.toFixed(6)}  ${event.latencyMs}ms`)}`,
          );
        }
      },
      recall: createKnowledgeRecall(sql, embedder, ecosystemId),
    };

    const round = await executeRound(ctx);
    await runs.finishRun(sql, run.id, {
      status: "COMPLETED",
      result: { synthesis: round.synthesis },
    });

    heading("3. What the organization concluded");
    console.log(`summary            ${dim(round.synthesis.summary.slice(0, 90))}`);
    console.log(`high confidence    ${round.synthesis.highConfidence.length}`);
    console.log(`working hypotheses ${round.synthesis.workingHypotheses.length}`);
    console.log(
      `contested          ${yellow(String(round.synthesis.contested.length))} ` +
        dim(`(measured disagreement ${round.disagreementLevel.toFixed(2)})`),
    );
    console.log(`unknowns           ${round.synthesis.unknowns.length}`);
    for (const contested of round.synthesis.contested.slice(0, 2)) {
      console.log(`\n  ${yellow("contested")} ${contested.question.slice(0, 76)}`);
      for (const position of contested.positions.slice(0, 2)) {
        console.log(`    ${dim(position.agentIds.join(", "))}: ${position.position.slice(0, 66)}`);
      }
    }

    // Provenance: walk a claim back to the evidence it rests on.
    const trace = await runs.traceProvenance(sql, round.synthesisArtifactId);
    console.log(
      `\nprovenance         ${trace.length} artifacts across ` +
        `${new Set(trace.map((a) => a.stage)).size} stages, no duplicates`,
    );

    // --- 4. Watcher ---------------------------------------------------------
    heading("4. The Watcher evaluates the organization, not the answer");
    if (round.evaluation) {
      for (const [dimension, score] of Object.entries(round.evaluation.scores)) {
        if (typeof score === "number") {
          const bar = "█".repeat(Math.round(score * 20)).padEnd(20, "·");
          console.log(`  ${dimension.padEnd(20)} ${bar} ${score.toFixed(2)}`);
        }
      }
      console.log(`  ${dim("recommendation")}       ${round.evaluation.recommendation}`);
      console.log(`  ${dim("suggested mutations")}  ${round.evaluation.suggestedMutations.length}`);
      if (round.rejectedMutations.length > 0) {
        console.log(
          `  ${yellow("blocked")}              ${round.rejectedMutations
            .map((m) => m.type)
            .join(", ")} ${dim("(would widen permissions)")}`,
        );
      }
    }

    const costByAgent = await telemetry.getRunCostByAgent(sql, run.id);
    console.log(`\n  ${dim("cost attribution")}`);
    for (const row of costByAgent) {
      console.log(
        `    ${(row.agentId ?? "—").padEnd(18)} $${Number(row.costUsd).toFixed(6)} ${dim(`${row.calls} calls`)}`,
      );
    }

    // --- 5. Mutate into a new immutable version -----------------------------
    heading("5. Mutate — a new version, never an edit");
    const mutation = await proposeAndApplyMutation(
      { sql, ids, memory: { sql, embedder, ecosystemId, policy: genome.memoryPolicy } },
      {
        ecosystemId,
        fromVersionId: v1.id,
        genome,
        patches: [
          {
            type: "UPDATE_PROMPT",
            agentId: genome.agents.find((a) => a.cognitiveMode === "adversarial")?.id ??
              genome.agents[0]!.id,
            systemPrompt:
              "Attack the load-bearing assumption first. Name the single observation that " +
              "would most change your view, and say why nobody has made it.",
          },
        ],
        actor: "HUMAN",
        runId: run.id,
        rationale: "sharpen the adversarial agent's focus on decisive evidence",
        createdBy: userId,
      },
    );

    if (mutation.status !== "applied") {
      console.log(`mutation ${mutation.status}`);
      return;
    }

    console.log(`v1 → v${mutation.version}   ${describeDiff(mutation.diff)}`);
    console.log(`v1 hash    ${dim(hashGenome(genome).slice(0, 12))} ${dim("(unchanged, immutable)")}`);
    console.log(`v2 hash    ${dim(hashGenome(mutation.genome).slice(0, 12))}`);

    // --- 6. Benchmark the two versions --------------------------------------
    heading("6. Benchmark v1 against v2 on a shared suite");
    const benchmarkId = ids.next("benchmark");
    await telemetry.createBenchmark(sql, {
      id: benchmarkId,
      workspaceId,
      name: STANDARD_SUITE.name,
      slug: STANDARD_SUITE.id,
      tasks: STANDARD_SUITE.tasks,
      scoring: { dimensions: [] },
    });

    const comparison = await compareGenomes(
      { sql, gateway, clock, ids, attribution: { orgId, workspaceId } },
      STANDARD_SUITE,
      [
        { ecosystemId, genomeVersionId: v1.id, genome, label: "v1 (seed)" },
        {
          ecosystemId,
          genomeVersionId: mutation.versionId,
          genome: mutation.genome,
          label: `v${mutation.version} (mutated)`,
        },
      ],
      { persist: { benchmarkId } },
    );

    console.log(
      `\n  ${"version".padEnd(22)}${"score".padEnd(10)}${"cost".padEnd(14)}${"score/$".padEnd(12)}tasks`,
    );
    for (const report of comparison.reports) {
      console.log(
        `  ${report.label.padEnd(22)}` +
          `${report.averageScore.toFixed(3).padEnd(10)}` +
          `$${report.totalCostUsd.toFixed(6).padEnd(13)}` +
          `${(report.efficiency?.toFixed(1) ?? "—").padEnd(12)}` +
          `${report.tasks.length}${report.failures.length ? yellow(` (${report.failures.length} failed)`) : ""}`,
      );
    }
    if (comparison.winner) {
      console.log(`\n  winner   ${green(comparison.winner.label)}`);
    }

    // --- 7. Breed -----------------------------------------------------------
    heading("7. Breed two architectures and promote the winner");
    const partner = loadTemplate("adversarial-research");
    const candidates = crossover(mutation.genome, partner, { seed: "demo-breed" });
    console.log(`${candidates.length} viable candidates from 2 parents:`);
    for (const candidate of candidates) {
      console.log(`  ${candidate.strategy.padEnd(18)} ${dim(candidate.summary)}`);
    }

    if (candidates.length > 0) {
      const { version: partnerVersion } = await genomes.createGenomeVersion(sql, {
        id: ids.next("genomeVersion"),
        ecosystemId,
        genome: partner,
        origin: "MANUAL",
      });

      const materialized = [];
      for (const candidate of candidates) {
        const child = await materializeChild(
          { sql, ids },
          {
            ecosystemId,
            genome: candidate.genome,
            parentVersionIds: [mutation.versionId, partnerVersion.id],
          },
        );
        materialized.push({ candidate, child });
      }

      const bredComparison = await compareGenomes(
        { sql, gateway, clock, ids, attribution: { orgId, workspaceId } },
        { ...STANDARD_SUITE, tasks: STANDARD_SUITE.tasks.slice(0, 2) },
        materialized.map((m) => ({
          ecosystemId,
          genomeVersionId: m.child.versionId,
          genome: m.candidate.genome,
          label: `v${m.child.version} ${m.candidate.strategy}`,
        })),
      );

      console.log("");
      for (const report of bredComparison.reports) {
        console.log(
          `  ${report.label.padEnd(28)}score ${report.averageScore.toFixed(3)}  ` +
            dim(`$${report.totalCostUsd.toFixed(6)}`),
        );
      }

      const champion = bredComparison.winner;
      if (champion) {
        await promoteVersion(sql, ecosystemId, champion.genomeVersionId);
        console.log(`\n  promoted ${green(champion.label)} as the ecosystem's current version`);
      }
    }

    // --- 8. Evolve under a statistical promotion rule ------------------------
    //
    // The default rule promotes when the Watcher's score for one run beats the
    // champion's by a fixed epsilon: one objective, one number, no way to ask
    // whether the difference is bigger than the noise. Supplying an assessor
    // replaces that with a benchmark suite and a paired bootstrap over per-task
    // differences, so a generation is promoted on evidence and "we cannot tell"
    // becomes an answer the loop is able to give.
    heading("8. Evolve with promotion gated on evidence");

    // Unattended evolution is only possible where the genome's own policy
    // permits it — the recommended template requires a human to approve a
    // Watcher mutation, and the loop halts at that gate rather than bypassing
    // it. So this section runs against an explicitly relaxed variant, which is
    // its own demonstration: the gate is a property of the genome, not a flag
    // on the runtime.
    const unattended = parseGenome({
      ...genome,
      mutationPolicy: {
        ...genome.mutationPolicy,
        humanApprovalRequired: false,
        // Everything except the two privilege-bearing types. Those can widen
        // what the organization is permitted to do, and a genome allowing them
        // unattended does not validate at all — the constraint is structural.
        allowed: [
          "ADD_AGENT",
          "REMOVE_AGENT",
          "UPDATE_PROMPT",
          "UPDATE_MODEL",
          "ADD_EDGE",
          "REMOVE_EDGE",
          "CHANGE_PROTOCOL",
          "CHANGE_MEMORY_POLICY",
          "CHANGE_STOP_CRITERIA",
        ],
        maxMutationsPerRun: 4,
      },
    });
    const { version: unattendedVersion } = await genomes.createGenomeVersion(sql, {
      id: ids.next("genomeVersion"),
      ecosystemId,
      genome: unattended,
      parentIds: [v1.id],
      origin: "MANUAL",
      createdBy: userId,
    });

    const assessor = createBenchmarkAssessor({
      deps: { sql, gateway, clock, ids, attribution: { orgId, workspaceId } },
      suite: STANDARD_SUITE,
      seed: "demo-assessor",
    });

    const evolution = await evolveEcosystem(
      { sql, gateway, clock, ids, embedder, assessor },
      {
        ecosystemId,
        fromVersionId: unattendedVersion.id,
        genome: unattended,
        objective: OBJECTIVE,
        seed: "demo-evolve",
        maxGenerations: 3,
        createdBy: userId,
        attribution: { orgId, workspaceId },
      },
    );

    console.log(`${STANDARD_SUITE.tasks.length} tasks per assessment, paired by task\n`);
    for (const gen of evolution.generations) {
      const verdict = gen.assessment?.verdict ?? gen.note;
      const mark =
        gen.outcome === "promoted" ? green("promoted") :
        gen.outcome === "rejected-regression" ? yellow("retained champion") :
        dim(gen.outcome);
      console.log(
        `  gen ${gen.generation + 1}  v${String(gen.version).padEnd(3)} ` +
          `${mark.padEnd(26)} ${dim(verdict)}`,
      );
    }
    console.log(`\n  stopped   ${evolution.stoppedBecause}`);
    console.log(
      `  ${dim("an interval containing zero means the suite cannot distinguish the two")}`,
    );

    // --- 9. Lineage and memory ----------------------------------------------
    heading("9. Evolutionary state");
    const allVersions = await genomes.listGenomeVersions(sql, ecosystemId);
    console.log(`versions        ${allVersions.length}`);
    for (const version of allVersions) {
      console.log(
        `  v${String(version.version).padEnd(3)} ${version.origin.padEnd(10)} ` +
          `${dim(version.genome_hash.slice(0, 10))} ${dim(`parents: ${version.parent_ids.length}`)}`,
      );
    }

    const [knowledgeCount] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM memories
      WHERE ecosystem_id = ${ecosystemId} AND scope = 'knowledge'
    `;
    const [structuralCount] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM memories
      WHERE ecosystem_id = ${ecosystemId} AND scope = 'evolutionary'
    `;
    const usage = await telemetry.getOrgUsage(sql, orgId, new Date(0));

    console.log(`\nknowledge memory    ${knowledgeCount?.count} ${dim("(about the world)")}`);
    console.log(`evolutionary memory ${structuralCount?.count} ${dim("(about itself)")}`);
    console.log(
      `\ntotal model calls   ${usage.calls}, ${usage.inputTokens} in / ${usage.outputTokens} out, ` +
        `$${Number(usage.costUsd).toFixed(6)}`,
    );

    const artifact = exportArtifact(mutation.genome, {
      version: mutation.version,
      parentIds: [v1.id],
      origin: "MUTATION",
      createdAt: new Date().toISOString(),
    });
    console.log(
      `\nportable export     ${artifact.format} v${artifact.formatVersion}, ` +
        `hash ${dim(artifact.hash.slice(0, 12))}`,
    );

    console.log(
      `\n${green("✓")} every model call was deterministic; re-running this demo with the same ` +
        `seed reproduces the same reasoning.\n`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error("\ndemo failed:", error);
  process.exitCode = 1;
});
