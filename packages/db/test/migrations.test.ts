import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EMBEDDED_MIGRATIONS } from "../src/migrations.generated.js";
import { sha256 } from "@meta/shared";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/**
 * The `.sql` files are the source of truth and the embedded module is a mirror,
 * so the only thing that makes the mirror trustworthy is this test. Without it,
 * editing a migration and forgetting `pnpm gen:migrations` would silently ship
 * one schema locally and a different one everywhere else.
 */
describe("embedded migrations", () => {
  it("match the .sql files byte for byte", async () => {
    const names = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const embeddedNames = EMBEDDED_MIGRATIONS.map((m) => m.name).sort();

    expect(embeddedNames).toEqual(names);

    for (const name of names) {
      const onDisk = await readFile(join(MIGRATIONS_DIR, name), "utf8");
      const embedded = EMBEDDED_MIGRATIONS.find((m) => m.name === name);
      // Compared by checksum so a failure message stays readable rather than
      // dumping sixteen kilobytes of SQL into the terminal.
      expect(`${name}:${sha256(embedded?.body ?? "")}`).toBe(`${name}:${sha256(onDisk)}`);
    }
  });

  it("is not empty", () => {
    expect(EMBEDDED_MIGRATIONS.length).toBeGreaterThan(0);
  });
});
