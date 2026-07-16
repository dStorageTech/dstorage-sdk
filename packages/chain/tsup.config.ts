import { defineConfig } from "tsup";

// @dstorage/crypto and @dstorage/payment are real (published) dependencies,
// not workspace-bundled siblings — keep them external so consumers resolve
// them via their own package manager, matching tsup's default behavior for
// package.json-listed deps. @midnight-ntwrk/ledger-v8 is never listed here
// (it's only reached transitively through @midnight-ntwrk/midnight-js-protocol),
// so it needs an explicit external entry — without it, esbuild bundles it
// fully, defaulting to its Node-only "exports" condition (fs.readFileSync-based
// WASM loader) even in the browser build below.
const external: (string | RegExp)[] = [
  /^@midnight-ntwrk\//,
  "@dstorage/crypto",
  "@dstorage/payment",
];

export default defineConfig([
  // Node.js build: ESM + CJS.
  // Array form (not a named-entry object) preserves each file's source
  // directory under dist/ — e.g. src/adapters/mock.ts -> dist/adapters/mock.js
  // — matching the "./mock" export subpath in package.json.
  {
    entry: [
      "src/index.ts",
      "src/types.ts",
      "src/adapters/mock.ts",
      "src/errors.ts",
    ],
    format: ["esm", "cjs"],
    dts: true,
    external,
    esbuildOptions(options) {
      options.logOverride = { "ignored-bare-import": "silent" };
    },
  },
  // Browser build: platform: "browser" so ledger-v8's package.json "exports"
  // resolves its "browser" condition (WASM fetch/instantiate) instead of the
  // default Node condition (fs.readFileSync).
  {
    entry: ["src/browser.ts"],
    format: ["esm", "cjs"],
    platform: "browser",
    dts: true,
    external,
    esbuildOptions(options) {
      options.logOverride = { "ignored-bare-import": "silent" };
    },
  },
]);
