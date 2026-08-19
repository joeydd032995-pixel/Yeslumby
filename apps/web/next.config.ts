import type { NextConfig } from "next";

const config: NextConfig = {
  // Workspace packages ship TypeScript source with no build step, so Next
  // compiles them alongside the app rather than resolving built output.
  transpilePackages: [
    "@meta/shared",
    "@meta/genome",
    "@meta/db",
    "@meta/gateway",
    "@meta/runtime",
    "@meta/memory",
    "@meta/evolution",
    "@meta/bench",
  ],
  experimental: {
    // The runtime opens real Postgres connections from server components.
    serverActions: { bodySizeLimit: "2mb" },
  },

  // Webpack rather than Turbopack (see the `--webpack` flag in package.json):
  // Turbopack has no equivalent of `extensionAlias`, and without it the `.js`
  // specifiers below cannot be resolved back to TypeScript source.
  //
  // The workspace packages are ESM TypeScript and import each other with
  // explicit `.js` specifiers, which is correct for Node's resolver but leaves
  // the bundler looking for files that were never emitted. Mapping the
  // extension back to source is what lets Next compile them in place.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
  turbopack: {
    resolveExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"],
  },
};

export default config;
