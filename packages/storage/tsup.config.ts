import path from "node:path";
import { defineConfig } from "tsup";
import type { Plugin } from "esbuild";

// esbuild's `alias` option only accepts bare (non-relative) specifiers, so the
// browser/turbo-sdk swap below uses a plain onResolve plugin instead, scoped to
// just the browser build.
const turboFactoryWebPlugin: Plugin = {
  name: "turbo-factory-web",
  setup(build) {
    build.onResolve({ filter: /^\.\/turbo-factory\.js$/ }, (args) => ({
      path: path.resolve(args.resolveDir, "turbo-factory.web.ts"),
    }));
  },
};

export default defineConfig([
  // Node.js build: all adapters, ESM + CJS.
  {
    entry: {
      index: "src/index.ts",
      types: "src/types.ts",
      "adapters/mock": "src/adapters/mock.ts",
      errors: "src/errors.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    tsconfig: "tsconfig.json",
  },
  // Browser build: same public surface, but arweave-bundler's turbo-sdk loader is
  // swapped for the browser variant (./turbo-factory.web.ts) so the dist never
  // references turbo-sdk's Node build, which statically imports `fs` and breaks a
  // consumer's production bundler build even though we only ever call
  // TurboFactory.unauthenticated().
  {
    entry: { browser: "src/browser.ts" },
    format: ["esm"],
    platform: "browser",
    dts: true,
    tsconfig: "tsconfig.json",
    esbuildPlugins: [turboFactoryWebPlugin],
  },
]);
