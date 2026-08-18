import {
  parseGenome,
  hashGenome,
  validateGenome,
  type AgentSpec,
  type ArchitectureGenome,
  type EdgeSpec,
} from "@meta/genome";
import { createRng, type Rng } from "@meta/shared";

/**
 * Breeding: compose two parent genomes into candidate children.
 *
 * The hard part is not combining two organizations — it is that the obvious
 * combinations are invalid. Union the agents of two genomes and you exceed the
 * agent cap; take one parent's topology with the other's roster and every edge
 * dangles; inherit a synthesizer that was not carried over and the child cannot
 * produce a result at all. So each strategy composes freely and then hands the
 * result to {@link repair}, which restores the invariants before validation.
 *
 * Candidates are produced deterministically from a seed, so a breeding run can
 * be replayed and the resulting comparison is reproducible.
 */

export type CrossoverStrategy = "role-union" | "topology-graft" | "elite-roles";

export interface BreedOptions {
  seed?: string;
  /** Parent believed stronger; supplies protocols and wins role conflicts. */
  dominant?: "a" | "b";
  strategies?: CrossoverStrategy[];
}

export interface Candidate {
  strategy: CrossoverStrategy;
  genome: ArchitectureGenome;
  hash: string;
  /** What the strategy did, for the evolution graph. */
  summary: string;
}

export function crossover(
  parentA: ArchitectureGenome,
  parentB: ArchitectureGenome,
  options: BreedOptions = {},
): Candidate[] {
  const seed = options.seed ?? `${hashGenome(parentA)}:${hashGenome(parentB)}`;
  const dominantIsA = (options.dominant ?? "a") === "a";
  const dominant = dominantIsA ? parentA : parentB;
  const recessive = dominantIsA ? parentB : parentA;
  const strategies = options.strategies ?? ["role-union", "topology-graft", "elite-roles"];

  const candidates: Candidate[] = [];
  const seen = new Set<string>([hashGenome(parentA), hashGenome(parentB)]);

  for (const strategy of strategies) {
    const rng = createRng(`${seed}:${strategy}`);
    const composed = compose(strategy, dominant, recessive, rng);
    const repaired = repair(composed, rng);

    const result = validateGenome(repaired);
    if (!result.ok) continue;

    const hash = hashGenome(result.genome);
    // A child identical to a parent, or to an earlier candidate, teaches the
    // benchmark nothing — it would just re-measure a genome already ranked.
    if (seen.has(hash)) continue;
    seen.add(hash);

    candidates.push({
      strategy,
      genome: result.genome,
      hash,
      summary: summarize(strategy, result.genome, dominant, recessive),
    });
  }

  return candidates;
}

function compose(
  strategy: CrossoverStrategy,
  dominant: ArchitectureGenome,
  recessive: ArchitectureGenome,
  rng: Rng,
): ArchitectureGenome {
  const base = structuredClone(dominant) as ArchitectureGenome;

  switch (strategy) {
    case "role-union": {
      // Every distinct cognitive mode from both parents, one agent per mode.
      // Duplicated modes add cost without adding perspective, and the Watcher
      // scores diversity, not headcount.
      const byMode = new Map<string, AgentSpec>();
      for (const agent of [...dominant.agents, ...recessive.agents]) {
        const existing = byMode.get(agent.cognitiveMode);
        if (!existing || agent.weight > existing.weight) {
          byMode.set(agent.cognitiveMode, agent);
        }
      }
      base.agents = dedupeIds([...byMode.values()]);
      base.edges = [...dominant.edges, ...recessive.edges];
      base.name = `${dominant.name} × ${recessive.name}`;
      return base;
    }

    case "topology-graft": {
      // The dominant parent's agents wired with the recessive parent's
      // interaction pattern, mapped positionally onto the surviving roster.
      base.agents = structuredClone(dominant.agents);
      base.edges = graftEdges(recessive.edges, recessive.agents, base.agents);
      base.protocols = structuredClone(recessive.protocols);
      base.name = `${dominant.name} on ${recessive.name} topology`;
      return base;
    }

    case "elite-roles": {
      // The highest-weighted half of each parent.
      const pick = (g: ArchitectureGenome) =>
        [...g.agents]
          .sort((x, y) => y.weight - x.weight)
          .slice(0, Math.max(2, Math.ceil(g.agents.length / 2)));
      base.agents = dedupeIds(rng.shuffle([...pick(dominant), ...pick(recessive)]));
      base.edges = [...dominant.edges, ...recessive.edges];
      base.name = `Elite ${dominant.name} / ${recessive.name}`;
      return base;
    }
  }
}

/** Rename colliding ids rather than dropping an agent the strategy selected. */
function dedupeIds(agents: AgentSpec[]): AgentSpec[] {
  const seen = new Set<string>();
  return agents.map((agent) => {
    if (!seen.has(agent.id)) {
      seen.add(agent.id);
      return agent;
    }
    let n = 2;
    let candidate = `${agent.id}-${n}`;
    while (seen.has(candidate)) candidate = `${agent.id}-${++n}`;
    seen.add(candidate);
    return { ...agent, id: candidate };
  });
}

/** Map one genome's edges onto another roster by position. */
function graftEdges(
  edges: readonly EdgeSpec[],
  from: readonly AgentSpec[],
  onto: readonly AgentSpec[],
): EdgeSpec[] {
  if (onto.length === 0) return [];
  const index = new Map(from.map((a, i) => [a.id, i]));
  const mapped: EdgeSpec[] = [];

  for (const edge of edges) {
    const fromIdx = index.get(edge.from);
    const toIdx = index.get(edge.to);
    if (fromIdx === undefined || toIdx === undefined) continue;
    const a = onto[fromIdx % onto.length]!;
    const b = onto[toIdx % onto.length]!;
    if (a.id === b.id) continue;
    mapped.push({ ...edge, from: a.id, to: b.id });
  }
  return mapped;
}

/**
 * Restore the invariants a naive composition breaks.
 *
 * Runs before validation so a structurally sound child is not discarded over a
 * mechanical problem the composition introduced.
 */
export function repair(genome: ArchitectureGenome, rng: Rng): ArchitectureGenome {
  const draft = structuredClone(genome) as ArchitectureGenome;

  // Agent cap. Keep the highest-weighted, but never drop the synthesizer.
  const cap = draft.mutationPolicy.maxAgents;
  if (draft.agents.length > cap) {
    const synth = draft.agents.find((a) => a.id === draft.synthesizerId);
    const rest = draft.agents
      .filter((a) => a.id !== synth?.id)
      .sort((x, y) => y.weight - x.weight)
      .slice(0, cap - (synth ? 1 : 0));
    draft.agents = synth ? [synth, ...rest] : rest;
  }

  const ids = new Set(draft.agents.map((a) => a.id));

  // Drop dangling and self edges left by composition, and deduplicate.
  const seenEdges = new Set<string>();
  draft.edges = draft.edges.filter((e) => {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) return false;
    const key = `${e.from}->${e.to}:${e.interaction}`;
    if (seenEdges.has(key)) return false;
    seenEdges.add(key);
    return true;
  });

  // A synthesizer must exist. Prefer a synthetic-mode agent, then a
  // non-proposer, then anyone.
  if (!ids.has(draft.synthesizerId)) {
    const chosen =
      draft.agents.find((a) => a.cognitiveMode === "synthetic") ??
      draft.agents.find((a) => !a.proposes) ??
      draft.agents[0];
    if (chosen) {
      draft.synthesizerId = chosen.id;
      // A synthesizer that also proposes anchors on its own prior position.
      draft.agents = draft.agents.map((a) =>
        a.id === chosen.id ? { ...a, proposes: false } : a,
      );
    }
  }

  const proposers = draft.agents.filter((a) => a.proposes);

  // Cross-challenge needs at least two proposers. If the composition left one,
  // promote a non-synthesizer back to proposing rather than silently disabling
  // the protocol the parents were selected for.
  if (draft.protocols.crossChallenge && proposers.length < 2) {
    const promotable = draft.agents.filter((a) => a.id !== draft.synthesizerId && !a.proposes);
    for (const agent of promotable) {
      if (draft.agents.filter((a) => a.proposes).length >= 2) break;
      draft.agents = draft.agents.map((a) => (a.id === agent.id ? { ...a, proposes: true } : a));
    }
    if (draft.agents.filter((a) => a.proposes).length < 2) {
      draft.protocols = { ...draft.protocols, crossChallenge: false };
    }
  }

  // Cross-challenge is edge-driven, so it needs at least one challenge edge.
  if (
    draft.protocols.crossChallenge &&
    !draft.edges.some((e) => e.interaction === "challenge")
  ) {
    const current = draft.agents.filter((a) => a.proposes);
    const challenger =
      current.find((a) => a.cognitiveMode === "adversarial" || a.cognitiveMode === "critical") ??
      current[0];
    const target = current.find((a) => a.id !== challenger?.id);
    if (challenger && target) {
      draft.edges.push({
        from: challenger.id,
        to: target.id,
        interaction: "challenge",
        weight: 1,
      });
    } else {
      draft.protocols = { ...draft.protocols, crossChallenge: false };
    }
  }

  // Every proposer should reach the synthesizer, or its work is discarded.
  for (const agent of draft.agents.filter((a) => a.proposes)) {
    const linked = draft.edges.some(
      (e) => e.from === agent.id && e.to === draft.synthesizerId && e.interaction === "synthesize",
    );
    if (!linked) {
      draft.edges.push({
        from: agent.id,
        to: draft.synthesizerId,
        interaction: "synthesize",
        weight: rng.next() < 0.5 ? 1 : 0.8,
      });
    }
  }

  return parseGenome(draft);
}

function summarize(
  strategy: CrossoverStrategy,
  child: ArchitectureGenome,
  dominant: ArchitectureGenome,
  recessive: ArchitectureGenome,
): string {
  const modes = [...new Set(child.agents.map((a) => a.cognitiveMode))];
  return (
    `${strategy}: ${child.agents.length} agents (${modes.join(", ")}), ` +
    `${child.edges.length} edges, protocols from ` +
    `${strategy === "topology-graft" ? recessive.name : dominant.name}`
  );
}
