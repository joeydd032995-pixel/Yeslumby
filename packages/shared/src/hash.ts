import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.js";

/** sha256 of a UTF-8 string, hex encoded. */
export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Content address for any serializable value. Two semantically equal values
 * always produce the same digest — the property immutable genome versioning and
 * the durable step journal both rely on.
 */
export function contentHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** Short, human-facing form of a content hash. Never use for equality checks. */
export function shortHash(hash: string, length = 12): string {
  return hash.slice(0, length);
}
