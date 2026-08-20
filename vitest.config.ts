import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@meta/shared": r("./packages/shared/src/index.ts"),
      "@meta/genome": r("./packages/genome/src/index.ts"),
      "@meta/db": r("./packages/db/src/index.ts"),
      "@meta/gateway": r("./packages/gateway/src/index.ts"),
      "@meta/runtime": r("./packages/runtime/src/index.ts"),
      "@meta/memory": r("./packages/memory/src/index.ts"),
      "@meta/evolution": r("./packages/evolution/src/index.ts"),
      "@meta/bench": r("./packages/bench/src/index.ts"),
      "@meta/seed": r("./packages/seed/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    // Integration tests share one Postgres cluster; each suite namespaces its
    // own rows, but schema-level setup must not race.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
