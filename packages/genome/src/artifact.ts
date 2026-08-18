import { contentHash, GenomeValidationError } from "@meta/shared";
import {
  GenomeArtifactSchema,
  type ArchitectureGenome,
  type GenomeArtifact,
} from "./schema.js";
import { parseGenome } from "./validate.js";

/**
 * Content addressing and the portable export format.
 *
 * The hash covers the normalized genome body only. Normalization happens first
 * so that a genome which omits a defaulted field and one that states it
 * explicitly are the same genome — otherwise every re-serialization risks
 * forking the lineage.
 */
export function hashGenome(genome: ArchitectureGenome): string {
  return contentHash(genome);
}

/** True when two genomes are semantically identical. */
export function sameGenome(a: ArchitectureGenome, b: ArchitectureGenome): boolean {
  return hashGenome(a) === hashGenome(b);
}

export interface LineageInfo {
  version: number;
  parentIds?: string[];
  parentHashes?: string[];
  origin: "SEED" | "MUTATION" | "BREEDING" | "FORK" | "MANUAL";
  createdAt: string;
  ecosystem?: string;
}

export function exportArtifact(
  genome: ArchitectureGenome,
  lineage: LineageInfo,
): GenomeArtifact {
  return {
    format: "meta-ecosystem/genome",
    formatVersion: 1,
    hash: hashGenome(genome),
    lineage: {
      version: lineage.version,
      parentIds: lineage.parentIds ?? [],
      parentHashes: lineage.parentHashes ?? [],
      origin: lineage.origin,
      createdAt: lineage.createdAt,
      ...(lineage.ecosystem ? { ecosystem: lineage.ecosystem } : {}),
    },
    genome,
  };
}

export function serializeArtifact(artifact: GenomeArtifact): string {
  return JSON.stringify(artifact, null, 2);
}

/**
 * Import an artifact, verifying its declared hash against its own contents.
 *
 * An artifact is untrusted input — it may have been edited by hand or come from
 * another installation. A mismatch means the declared identity does not
 * describe the payload, so it is rejected rather than silently re-hashed.
 */
export function importArtifact(input: unknown): {
  genome: ArchitectureGenome;
  lineage: GenomeArtifact["lineage"];
} {
  const parsed = GenomeArtifactSchema.safeParse(input);
  if (!parsed.success) {
    throw new GenomeValidationError("not a valid meta-ecosystem/genome artifact", {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }

  const genome = parseGenome(parsed.data.genome);
  const actual = hashGenome(genome);
  if (actual !== parsed.data.hash) {
    throw new GenomeValidationError("artifact hash does not match its genome body", {
      declared: parsed.data.hash,
      actual,
    });
  }

  return { genome, lineage: parsed.data.lineage };
}
