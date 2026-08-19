/**
 * Typed error taxonomy.
 *
 * Stages distinguish these classes to decide whether to retry, pause, or fail
 * the run, so the distinction is encoded in the type rather than in message
 * string matching.
 */

export abstract class MetaError extends Error {
  abstract readonly code: string;
  /** Whether re-attempting the same operation could plausibly succeed. */
  abstract readonly retryable: boolean;

  constructor(
    message: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      context: this.context,
    };
  }
}

/** A genome failed schema or graph-invariant validation. */
export class GenomeValidationError extends MetaError {
  readonly code = "GENOME_INVALID";
  readonly retryable = false;
}

/** An attempt to modify an already-materialized genome version. */
export class ImmutabilityError extends MetaError {
  readonly code = "IMMUTABLE_VIOLATION";
  readonly retryable = false;
}

/** A mutation patch was rejected by policy (disallowed type, or escalation). */
export class MutationPolicyError extends MetaError {
  readonly code = "MUTATION_FORBIDDEN";
  readonly retryable = false;
}

/** A model call failed. Transport failures are retryable; refusals are not. */
export class ModelCallError extends MetaError {
  readonly code = "MODEL_CALL_FAILED";
  constructor(
    message: string,
    readonly retryable: boolean,
    context: Record<string, unknown> = {},
  ) {
    super(message, context);
  }
}

/** A model returned output that does not satisfy the stage's output schema. */
export class StageOutputError extends MetaError {
  readonly code = "STAGE_OUTPUT_INVALID";
  readonly retryable = true;
}

/** A stage tried to exceed a capability granted by the genome. */
export class CapabilityError extends MetaError {
  readonly code = "CAPABILITY_DENIED";
  readonly retryable = false;
}

/** A stop criterion (cost, tokens, iterations, score) was reached. */
export class StopCriterionError extends MetaError {
  readonly code = "STOP_CRITERION_MET";
  readonly retryable = false;
}

/**
 * Not a failure: the run has suspended awaiting human approval. The state
 * machine catches this, parks the run, and resumes from the journal later.
 */
export class RunPaused extends MetaError {
  readonly code = "RUN_PAUSED";
  readonly retryable = false;
  constructor(
    readonly runId: string,
    readonly stage: string,
    context: Record<string, unknown> = {},
  ) {
    super(`run ${runId} paused at ${stage} awaiting approval`, context);
  }
}
