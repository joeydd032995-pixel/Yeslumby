/**
 * Canonical JSON serialization.
 *
 * Content-addressed genome versioning depends on two different objects that are
 * semantically equal producing byte-identical output. `JSON.stringify` does not
 * guarantee that: key order follows insertion order, so `{a:1,b:2}` and
 * `{b:2,a:1}` hash differently. Every hash in this system flows through here.
 */

/** A value that can be canonically serialized. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export class CanonicalizationError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} (at ${path || "<root>"})`);
    this.name = "CanonicalizationError";
  }
}

/**
 * Serialize a value to canonical JSON: object keys sorted by UTF-16 code unit,
 * no insignificant whitespace, `undefined`-valued keys omitted.
 *
 * Throws on values that have no stable representation (NaN, Infinity, -0
 * ambiguity, functions, symbols, bigint, cycles) rather than silently coercing
 * them, because a silent coercion here becomes a wrong hash downstream.
 */
export function canonicalJson(value: unknown): string {
  return write(value, "", new Set());
}

function write(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";

    case "number": {
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(`non-finite number ${String(value)}`, path);
      }
      // Normalize -0 to 0 so the two cannot produce different hashes.
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    }

    case "string":
      return JSON.stringify(value);

    case "bigint":
      throw new CanonicalizationError("bigint has no canonical JSON form", path);

    case "function":
    case "symbol":
      throw new CanonicalizationError(`${typeof value} is not serializable`, path);

    case "undefined":
      // Only reachable at the root; object members are filtered before recursion.
      throw new CanonicalizationError("undefined is not serializable", path);

    case "object":
      break;
  }

  const obj = value as object;
  if (seen.has(obj)) {
    throw new CanonicalizationError("circular reference", path);
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const items = obj.map((item, i) =>
        item === undefined ? "null" : write(item, `${path}[${i}]`, seen),
      );
      return `[${items.join(",")}]`;
    }

    if (obj instanceof Date) {
      return JSON.stringify(obj.toISOString());
    }

    // Reject exotic objects that would stringify to "{}" and silently lose data.
    const proto = Object.getPrototypeOf(obj) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalizationError(
        `unsupported object type ${obj.constructor?.name ?? "unknown"}`,
        path,
      );
    }

    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();

    const parts = keys.map(
      (k) => `${JSON.stringify(k)}:${write(record[k], path ? `${path}.${k}` : k, seen)}`,
    );
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}
