# Meta-Ecosystem Runtime

A versioned runtime for executable AI organizations — a compiler and evolutionary
engine for **Architecture Genomes**.

Every execution runs against an **immutable genome version**. That single rule is
what buys reproducibility, rollback, comparison, breeding, benchmarking, and
lineage; most of the design here follows from taking it literally.

```bash
scripts/dev-db.sh up          # real Postgres 16 + pgvector, in-repo
pnpm install
pnpm typecheck && pnpm test   # 353 tests against the real database
pnpm demo                     # the whole loop, end to end

pnpm seed                     # a dev tenant with runs, versions, memory
pnpm dev                      # the UI at localhost:3100
pnpm verify:ui                # drive it with a real browser, capture screenshots
```

## What it does

`pnpm demo` runs the complete cycle: describe an outcome → get a recommended
architecture → execute a round → have the Watcher evaluate the *organization* →
mutate it into a new immutable version → benchmark the versions against each
other → breed a third from two parents → promote the winner.

```
── 7. Breed two architectures and promote the winner ───────────────
  v3 role-union               score 0.722  $0.323640
  v4 topology-graft           score 0.702  $0.291975
  v5 elite-roles              score 0.571  $0.133144

  promoted v3 role-union as the ecosystem's current version
```

## Two loops

Confusing these is what makes "iteration" ambiguous, so they are separate:

| Loop | Scope | Genome | What changes between steps |
|---|---|---|---|
| `runEcosystem` | iterations *within* one run | pinned to one version | accumulated context — the prior round's synthesis |
| `evolveEcosystem` | generations *across* runs | a new version per generation | the architecture itself |

A run carries a single `genome_version_id`, and the thesis is that an execution
is reproducible against a named version — so a run that swapped architectures
mid-flight would make "which version produced this?" unanswerable. Changing the
organization is therefore a new run, which is also what makes generations
comparable.

A generation is promoted **only if it is actually better**. Without that, a
mutation engine steered by a noisy evaluator wanders rather than climbs while
the lineage records drift as progress. A regression rolls back — but the losing
version stays in the graph, because "we tried this and it was worse" is exactly
the knowledge that stops it being retried.

## Three memories, kept apart

Most systems collapse these into one. The separation is the moat, so it is
structural rather than conventional — separate stores, separate retrieval paths,
separate consumers, enforced by a database `CHECK` constraint.

| Memory | What it holds | Who may read it |
|---|---|---|
| **Conversation state** | what happened in one run | that run only |
| **Knowledge memory** | what the ecosystem learned about the world | agent context builders |
| **Evolutionary memory** | which structures work for which problems | the mutation engine and genome recommender — **never** an agent |

An agent that could read which architectures score well would optimize for its
own evaluation rather than the user's question, and the outputs would still look
like good answers. A `RunContext` therefore has no handle to evolutionary memory
at all.

## Guarantees, and how they are enforced

Each of these is enforced by construction rather than by convention, and each has
a test that fails if the enforcement is removed.

**Genome versions are append-only.** A `BEFORE UPDATE OR DELETE` trigger rejects
both, so this holds against a direct `psql` session. Consequently nothing mutable
lives on the row — a version's benchmark standing is *derived* from results on
read. Rollback is selecting an older version, never undoing anything.

**The hash covers content, not identity.** Version number, parents, and
timestamps live in the version envelope, not the hashed body. A hash covering its
own version number could never detect that two versions are semantically
identical — which is the check that stops a no-op mutation forking the lineage.

**No agent sees a peer's proposal.** `ProposalInputs` has no field through which
peer output could travel, so introducing anchoring requires changing that type — a
reviewable act, not an accident.

**Synthesis cannot collapse to a vote.** The schema has nowhere to put a
flattened verdict and requires ≥2 positions per contested claim. Because a model
could still satisfy that by reporting nothing contested, the runtime measures
disagreement from the *challenge artifacts* and rejects a synthesis claiming
consensus when disagreement exceeded the genome's threshold. The synthesizer does
not get to decide whether disagreement happened.

**Every claim is traceable.** Citations are restricted to an enum of the
artifacts that call was actually shown, so the constraint travels into the JSON
Schema and a fabricated reference cannot be generated in the first place.

**The Watcher cannot escalate its own privileges.** Blocked at three
independent points: a genome allowing unattended privilege mutation fails
validation; watcher-proposed capability or watcher-config patches are stripped
before reaching the approval queue; and `applyPatches` refuses them regardless of
policy. None of it depends on the Watcher behaving well.

**Prompt injection is contained.** This system circulates each agent's output
into other agents' inputs and stores memories derived from it, so one poisoned
proposal would otherwise propagate through every stage and persist across runs.
Content is typed by channel, untrusted blocks are fenced with a per-call nonce
derived from the run seed, and anything fence-shaped is stripped from untrusted
content so a payload cannot close its own fence.

**Runs are durable and restartable.** Resuming is not a separate code path:
`executeRound` is re-entered and completed steps replay from the journal. A crash
and a human-approval pause are the same mechanism. Steps carry an owner token and
a lease, so two workers cannot both execute one step and a dead worker cannot
strand a run.

## Architecture

```
apps/web              Next.js surface (planned)
packages/shared       canonical JSON, hashing, seeded RNG, clock, cost model
packages/genome       Zod schema, invariants, patches, content addressing
packages/db           schema, migrations, repositories
packages/gateway      ModelGateway port, deterministic + AI Gateway + OpenRouter providers
packages/runtime      step journal, state machine, stage executors, prompt assembly
packages/memory       embeddings, three-way stores, consolidation
packages/evolution    mutation engine, breeding, forking, recommendation
packages/bench        benchmark harness, scoring, ablation
```

### The deterministic provider

Not a testing mock. Reproducibility against a fixed genome version is the product
thesis, and no hosted model offers it — so breeding, benchmark ranking, and
mutation attribution could only ever be tested for plausibility, not correctness.
Under this provider the same genome, seed, and objective produce identical
reasoning.

It satisfies arbitrary stage schemas by generating instances from the schema
itself, so stages can change shape without anyone maintaining fixtures, and it
reports usage against the *requested* model — a genome of Opus agents and one of
Haiku agents produce different simulated costs, keeping score-per-dollar
meaningful with no real spend.

Set `OPENROUTER_API_KEY` or `AI_GATEWAY_API_KEY` and hosted inference takes
over automatically, behind the same port — if both are set, OpenRouter takes
precedence. `AI_GATEWAY_BASE_URL` / `OPENROUTER_BASE_URL` override the
respective default endpoint, and `OPENROUTER_SITE_URL` / `OPENROUTER_APP_NAME`
add OpenRouter's optional attribution headers. Embeddings always go through
the AI Gateway (or the deterministic embedder) regardless of which chat
backend is active — OpenRouter has no embeddings endpoint.

### What benchmarks can honestly measure

Without labelled answers there is no way to score correctness, and pretending
otherwise produces a leaderboard that rewards confident wrong answers. What *is*
measurable from the artifacts is what this runtime claims to optimize: whether
claims were sourced, whether disagreement that actually occurred was preserved,
whether claims were made falsifiable, and what it cost.

Tasks supplying expected findings also produce a **coverage** figure, but the
default scoring does not weight it — it is recorded as a diagnostic. Coverage is
a literal keyword match over one or two terms per task, so it moves in steps of
0.5 while real differences between architectures run around 0.05; weighting it
would let a promotion turn on whether a single word happened to appear. It is
also the only measure here that gestures at whether an answer was *right*, which
is the thing this suite has no labels to judge. A suite may override the default
dimensions and weight it anyway; `DEFAULT_DIMENSIONS` records what that would
require first.

Per-agent marginal contribution is measured by ablation — removing an agent and
re-running. Citation counts and challenge survival are cheaper proxies, but both
can be gamed by an agent that talks a lot; ablation cannot.

## Requirements

Node 22+, pnpm 10+, PostgreSQL 16 with pgvector. `scripts/dev-db.sh` stands up a
cluster inside the repo — Postgres refuses to run as root, so server commands go
through `runuser`.
