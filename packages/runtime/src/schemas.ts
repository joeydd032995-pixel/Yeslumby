import { z } from "zod";
import { MutationPatchSchema } from "@meta/genome";

/**
 * Stage output contracts.
 *
 * These schemas are enforcement, not documentation. Where the spec says a
 * behaviour is required, the schema is shaped so violating it is
 * unrepresentable rather than merely discouraged.
 */

/** Where a claim came from. Provenance is mandatory, never optional. */
export const SourceRefSchema = z.object({
  kind: z.enum(["proposal", "challenge", "falsification", "memory", "tool"]),
  artifactId: z.string().min(1),
  agentId: z.string().optional(),
});
export type SourceRef = z.output<typeof SourceRefSchema>;

/**
 * A source reference restricted to artifacts that actually exist in this run.
 *
 * Narrowing the id to an enum makes fabricated citations *unrepresentable*
 * rather than merely detectable: the constraint travels into the JSON Schema
 * sent to the provider, so structured output enforces it at generation time.
 * Post-hoc validation still runs as a second line of defense for providers that
 * do not honour the schema, but by then the call has been paid for.
 */
export function makeSourceRefSchema(allowedArtifactIds: readonly string[]) {
  const artifactId =
    allowedArtifactIds.length > 0
      ? z.enum([...allowedArtifactIds] as [string, ...string[]])
      : z.string().min(1);
  return z.object({
    kind: z.enum(["proposal", "challenge", "falsification", "memory", "tool"]),
    artifactId,
    agentId: z.string().optional(),
  });
}

export const ClaimSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()).min(1),
});
export type Claim = z.output<typeof ClaimSchema>;

export const ProposalSchema = z.object({
  summary: z.string().min(1),
  claims: z.array(ClaimSchema).min(1),
  assumptions: z.array(z.string()),
  openQuestions: z.array(z.string()),
  /**
   * Set when the agent noticed fenced content trying to redirect it. The
   * system policy asks agents to report this rather than silently ignore it,
   * which turns an injection attempt into a visible signal instead of a
   * near-miss nobody sees.
   */
  injectionAttemptObserved: z.boolean().optional(),
});
export type Proposal = z.output<typeof ProposalSchema>;

/**
 * How much a disagreement matters.
 *
 * Declared once and shared by objections (the *measured* side of disagreement)
 * and contested claims (the *reported* side). `scoreDisagreement` compares those
 * two sides and treats `fatal` specially on both, which only means anything if
 * the vocabularies are literally the same — hence one enum rather than two that
 * happen to match today.
 */
export const ClaimSeveritySchema = z.enum(["minor", "substantive", "fatal"]);
export type ClaimSeverity = z.output<typeof ClaimSeveritySchema>;

export const ObjectionSchema = z.object({
  targetClaimId: z.string().min(1),
  objection: z.string().min(1),
  severity: ClaimSeveritySchema,
  reasoning: z.string().min(1),
});

export const ChallengeSchema = z.object({
  targetAgentId: z.string().min(1),
  objections: z.array(ObjectionSchema).min(1),
  /** What the challenger accepts. Forces engagement rather than blanket dissent. */
  concessions: z.array(z.string()),
  /** 0 = total disagreement, 1 = full agreement. Drives the disagreement metric. */
  agreementScore: z.number().min(0).max(1),
});
export type Challenge = z.output<typeof ChallengeSchema>;

export const FalsificationSchema = z.object({
  targetAgentId: z.string().min(1),
  /**
   * Each list requires at least one entry. "What observation would prove this
   * wrong?" is the whole point of the stage; an empty answer is a failed stage,
   * not a permissible result.
   */
  falsifiablePredictions: z.array(z.string()).min(1),
  disconfirmingEvidence: z.array(z.string()).min(1),
  concreteTests: z
    .array(z.object({ description: z.string().min(1), wouldFalsifyIf: z.string().min(1) }))
    .min(1),
  verdict: z.enum(["falsifiable", "unfalsifiable", "already-contradicted"]),
});
export type Falsification = z.output<typeof FalsificationSchema>;

export const SynthesisClaimSchema = z.object({
  text: z.string().min(1),
  confidence: z.number().min(0).max(1),
  sources: z.array(SourceRefSchema).min(1),
});

/**
 * A claim the organization could not settle.
 *
 * `positions` requires at least two entries, each naming who holds it and why.
 * A "contested" entry with one position is a consensus wearing a disguise, so
 * the schema refuses it.
 */
export const ContestedClaimSchema = z.object({
  question: z.string().min(1),
  positions: z
    .array(
      z.object({
        agentIds: z.array(z.string()).min(1),
        position: z.string().min(1),
        reasoning: z.string().min(1),
        sources: z.array(SourceRefSchema),
      }),
    )
    .min(2),
  whyUnresolved: z.string().min(1),
  /** What evidence would settle it. Turns a disagreement into an experiment. */
  resolvingEvidence: z.string().min(1),
  /**
   * How much this unresolved question matters, on the same scale objections use.
   *
   * Recorded, not scored: `scoreDisagreement` deliberately ignores it, for
   * reasons set out there. It is here so the information exists in artifacts and
   * in the synthesis contract at all.
   *
   * Defaulted rather than required so a caller parsing an older synthesis by
   * hand gets the neutral middle instead of a throw. **This does not make
   * journal replay safe**, which an earlier version of this comment claimed:
   * `durableStep` returns stored step output through a type assertion and never
   * parses it, so a synthesis recorded before this field existed replays with
   * `severity` genuinely absent, whatever the type says. Anything that comes to
   * read this field must tolerate `undefined` on replayed rounds, or the replay
   * path must start parsing — which would be a change to the journal, not to
   * this schema.
   */
  severity: ClaimSeveritySchema.default("substantive"),
});
export type ContestedClaim = z.output<typeof ContestedClaimSchema>;

/**
 * Synthesis output.
 *
 * Note what this schema does NOT contain: any single field holding "the
 * answer". There is deliberately nowhere to put a majority verdict. The
 * epistemic status of every conclusion has to be declared by choosing which
 * list it goes in, and a claim that some agents rejected has no home except
 * `contested`. Collapsing to a vote is not discouraged here; it is
 * unrepresentable.
 *
 * `summary` exists for display, but it cannot substitute for the structure —
 * the structured fields are what downstream stages, benchmarks, and the
 * provenance trace read.
 */
export const SynthesisSchema = z.object({
  summary: z.string().min(1).max(2000),
  highConfidence: z.array(SynthesisClaimSchema),
  workingHypotheses: z.array(SynthesisClaimSchema),
  contested: z.array(ContestedClaimSchema),
  unknowns: z.array(z.string()),
  recommendedExperiments: z.array(
    z.object({ description: z.string().min(1), resolves: z.string().min(1) }),
  ),
});
export type Synthesis = z.output<typeof SynthesisSchema>;

/**
 * The synthesis contract for one specific call, with citations restricted to
 * the artifacts that call was actually shown.
 */
export function makeSynthesisSchema(allowedArtifactIds: readonly string[]) {
  const sourceRef = makeSourceRefSchema(allowedArtifactIds);
  const claim = z.object({
    text: z.string().min(1),
    confidence: z.number().min(0).max(1),
    sources: z.array(sourceRef).min(1),
  });

  return z.object({
    summary: z.string().min(1).max(2000),
    highConfidence: z.array(claim),
    workingHypotheses: z.array(claim),
    contested: z.array(
      z.object({
        question: z.string().min(1),
        positions: z
          .array(
            z.object({
              agentIds: z.array(z.string()).min(1),
              position: z.string().min(1),
              reasoning: z.string().min(1),
              sources: z.array(sourceRef),
            }),
          )
          .min(2),
        whyUnresolved: z.string().min(1),
        resolvingEvidence: z.string().min(1),
        // Required here, unlike on ContestedClaimSchema. This is the contract a
        // live call is held to, so the synthesizer must state a severity rather
        // than inherit one — the default exists only to let stored history parse.
        severity: ClaimSeveritySchema,
      }),
    ),
    unknowns: z.array(z.string()),
    recommendedExperiments: z.array(
      z.object({ description: z.string().min(1), resolves: z.string().min(1) }),
    ),
  });
}

export const WatcherScoresSchema = z.object({
  diversity: z.number().min(0).max(1).optional(),
  challengeQuality: z.number().min(0).max(1).optional(),
  independence: z.number().min(0).max(1).optional(),
  evidenceQuality: z.number().min(0).max(1).optional(),
  efficiency: z.number().min(0).max(1).optional(),
  goalAlignment: z.number().min(0).max(1).optional(),
  overall: z.number().min(0).max(1),
});
export type WatcherScores = z.output<typeof WatcherScoresSchema>;

/**
 * Watcher output.
 *
 * The Watcher evaluates the organization, not the answer, and proposes changes
 * as typed patches rather than prose advice — which is what lets the mutation
 * engine act on them, and lets the policy layer reject them by type.
 */
export const WatcherEvaluationSchema = z.object({
  scores: WatcherScoresSchema,
  failureModes: z.array(
    z.object({
      mode: z.string().min(1),
      evidence: z.string().min(1),
      severity: z.enum(["low", "medium", "high"]),
    }),
  ),
  suggestedMutations: z.array(MutationPatchSchema).max(10),
  /** What is worth remembering, split by store. */
  memoryRetention: z.object({
    knowledge: z.array(
      z.object({
        content: z.string().min(1),
        type: z.enum(["FACT", "HYPOTHESIS", "FAILED_APPROACH", "USER_PREFERENCE"]),
        importance: z.number().min(0).max(1),
      }),
    ),
    structural: z.array(
      z.object({
        content: z.string().min(1),
        importance: z.number().min(0).max(1),
      }),
    ),
  }),
  recommendation: z.enum(["continue", "mutate", "human_review", "stop"]),
  rationale: z.string().min(1),
});
export type WatcherEvaluation = z.output<typeof WatcherEvaluationSchema>;

/** Context stage output: the framing every proposer receives. */
export const ContextSchema = z.object({
  restatedObjective: z.string().min(1),
  problemClass: z.string().min(1),
  keyTerms: z.array(z.string()),
  successCriteria: z.array(z.string()).min(1),
});
export type StageContext = z.output<typeof ContextSchema>;

/** JSON Schema for a stage contract, for structured-output requests. */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: "output" }) as Record<string, unknown>;
}
