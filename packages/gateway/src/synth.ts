import { createRng, type Rng } from "@meta/shared";
import type { JsonSchema } from "./types.js";

/**
 * Deterministic instance generation from a JSON Schema.
 *
 * The simulator must satisfy whatever output schema a stage declares, without
 * the stages having to hand-maintain fixtures for it. Given the same seed and
 * schema it always produces the same instance, which is what makes a simulated
 * run byte-reproducible.
 *
 * Generated prose is drawn from a vocabulary seeded with the caller's context,
 * so different agents produce visibly different text. That matters: a
 * simulator where every agent says the same thing would make the diversity and
 * independence checks vacuous.
 */

export interface SynthContext {
  /** Words drawn from the objective and the agent's role. */
  topic: string[];
  /** Distinguishes agents so their outputs differ. */
  voice: string;
}

const CLAUSES = [
  "the evidence supports this only under the stated assumptions",
  "the mechanism is plausible but the effect size is unverified",
  "a confounding variable would explain the same observation",
  "this holds in the reported sample but may not generalize",
  "the causal direction has not been established",
  "the measurement instrument is a known source of bias",
  "prior work reports a smaller effect under stricter controls",
  "the result is robust to the obvious alternative explanations",
  "replication would settle the remaining ambiguity",
  "the baseline used here differs from the one in the literature",
];

const HEDGES = [
  "on the available evidence",
  "with moderate confidence",
  "provisionally",
  "subject to replication",
  "as a working hypothesis",
];

const TESTS = [
  "run a held-out comparison against the reported baseline",
  "measure the effect with an independent instrument",
  "vary the confounder and observe whether the effect persists",
  "collect a second sample from a different population",
  "pre-register the analysis and repeat it",
];

function sentence(rng: Rng, ctx: SynthContext): string {
  const subject = ctx.topic.length > 0 ? rng.pick(ctx.topic) : "the question";
  return `On ${subject}: ${rng.pick(CLAUSES)} (${rng.pick(HEDGES)}, per ${ctx.voice}).`;
}

const WORDS = [
  "alpha", "beta", "gamma", "delta", "sigma", "theta", "kappa", "lambda",
  "vector", "signal", "cohort", "sample", "vertex", "cipher", "quanta",
];

/**
 * Generate a string satisfying a `pattern` constraint.
 *
 * Schemas here carry real patterns — agent ids must be slugs, model ids must be
 * `provider/model` — and a generator that ignores them produces output that
 * validates as a string and then fails the actual contract. Rather than
 * implement general regex inversion, candidates in the shapes these schemas
 * use are tested against the pattern and the first match wins.
 */
function stringMatchingPattern(pattern: string, rng: Rng, schema: JsonSchema): string {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return rng.pick(WORDS);
  }

  const a = rng.pick(WORDS);
  const b = rng.pick(WORDS);
  const n = rng.int(10, 9999);

  const candidates = [
    `${a}-${n}`,
    a,
    `${a}/${b}-${n}`,
    `${a}/${b}`,
    `${a}_${b}`,
    `${a}${n}`,
    String(n),
    `${a}@${b}.test`,
    `https://${a}.test/${b}`,
    "2025-01-01T00:00:00.000Z",
  ];

  const min = schema.minLength ?? 0;
  const max = schema.maxLength ?? Number.MAX_SAFE_INTEGER;

  for (const candidate of candidates) {
    if (candidate.length < min || candidate.length > max) continue;
    if (regex.test(candidate)) return candidate;
  }
  // No candidate matched. Returning a plain word keeps generation total; the
  // caller's schema validation will surface the mismatch rather than this
  // silently producing something that looks valid.
  return a;
}

function stringFor(key: string, rng: Rng, ctx: SynthContext, schema: JsonSchema): string {
  if (typeof schema.pattern === "string") {
    return stringMatchingPattern(schema.pattern, rng, schema);
  }
  if (schema.format === "date-time") return "2025-01-01T00:00:00.000Z";
  if (schema.format === "uri") return "https://example.test/source";

  const k = key.toLowerCase();
  let value: string;
  if (k.includes("test") || k.includes("experiment")) {
    value = rng.pick(TESTS);
  } else if (k.includes("id") && !k.includes("evidence")) {
    value = `${ctx.voice}-${rng.int(1000, 9999)}`;
  } else if (k.includes("agent")) {
    value = ctx.voice;
  } else {
    value = sentence(rng, ctx);
  }

  const min = schema.minLength ?? 0;
  const max = schema.maxLength ?? Number.MAX_SAFE_INTEGER;
  while (value.length < min) value += ` ${sentence(rng, ctx)}`;
  return value.length > max ? value.slice(0, max) : value;
}

function resolveRef(schema: JsonSchema, root: JsonSchema): JsonSchema {
  if (!schema.$ref) return schema;
  const path = schema.$ref.replace(/^#\//, "").split("/");
  let node: unknown = root;
  for (const segment of path) {
    node = (node as Record<string, unknown> | undefined)?.[segment];
  }
  return (node as JsonSchema | undefined) ?? {};
}

/** Generate a deterministic value satisfying `schema`. */
export function synthesize(
  schema: JsonSchema,
  seed: string,
  ctx: SynthContext,
): unknown {
  return build(schema, schema, createRng(seed), ctx, "value", 0);
}

function build(
  schemaIn: JsonSchema,
  root: JsonSchema,
  rng: Rng,
  ctx: SynthContext,
  key: string,
  depth: number,
): unknown {
  if (depth > 12) return null;
  const schema = resolveRef(schemaIn, root);

  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return rng.pick(schema.enum);

  const branches = schema.anyOf ?? schema.oneOf;
  if (branches && branches.length > 0) {
    // Pick deterministically rather than always taking the first, so unions are
    // actually exercised across a run.
    return build(rng.pick(branches), root, rng, ctx, key, depth + 1);
  }
  if (schema.allOf && schema.allOf.length > 0) {
    const merged = schema.allOf.reduce<JsonSchema>(
      (acc, part) => ({
        ...acc,
        ...resolveRef(part, root),
        properties: { ...acc.properties, ...resolveRef(part, root).properties },
        required: [...(acc.required ?? []), ...(resolveRef(part, root).required ?? [])],
      }),
      {},
    );
    return build(merged, root, rng, ctx, key, depth + 1);
  }

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      const props = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      for (const [name, propSchema] of Object.entries(props)) {
        // Optional fields are included about half the time, so consumers cannot
        // silently depend on a field the schema says may be absent.
        if (!required.has(name) && rng.next() < 0.5) continue;
        out[name] = build(propSchema, root, rng, ctx, name, depth + 1);
      }
      return out;
    }

    case "array": {
      const min = schema.minItems ?? 0;
      const max = schema.maxItems ?? Math.max(min + 2, 3);
      // At least two items where the schema permits: single-element arrays make
      // downstream aggregation logic look correct when it is not.
      const target = Math.min(Math.max(min, 2), max);
      const count = target === 0 ? 0 : rng.int(Math.max(min, 1), Math.max(target, min || 1));
      const items = schema.items ?? {};
      return Array.from({ length: count }, (_, i) =>
        build(items, root, rng.derive(`item-${i}`), ctx, key, depth + 1),
      );
    }

    case "integer": {
      const lo = Math.ceil(schema.minimum ?? 0);
      const hi = Math.floor(schema.maximum ?? lo + 10);
      return rng.int(lo, Math.max(lo, hi));
    }

    case "number": {
      const lo = schema.minimum ?? 0;
      const hi = schema.maximum ?? lo + 1;
      // Three decimals keeps output readable and stable across platforms.
      return Math.round((lo + rng.next() * (hi - lo)) * 1000) / 1000;
    }

    case "boolean":
      return rng.next() < 0.5;

    case "null":
      return null;

    case "string":
      return stringFor(key, rng, ctx, schema);

    default:
      // An untyped schema accepts anything; a string is the least surprising.
      return stringFor(key, rng, ctx, schema);
  }
}

/** Extract topic words from free text, for use as {@link SynthContext.topic}. */
export function topicWords(...sources: string[]): string[] {
  const stop = new Set([
    "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with",
    "is", "are", "was", "were", "be", "been", "that", "this", "it", "as", "by",
    "at", "from", "what", "which", "how", "why", "should", "would", "could",
  ]);
  const words = sources
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((w) => w.length > 3 && !stop.has(w));
  return [...new Set(words)].slice(0, 12);
}
