import { defineConfig } from "tsup";

const sharedNoExternal = [
  "@dstorage/crypto",
  "@dstorage/payment",
  "@dstorage/encryption",
  "@dstorage/storage",
  "@dstorage/chain",
];

// @noble/* and bip39 are kept external: esbuild resolves @noble/hashes/crypto
// to its CJS "default" sub-condition under "node" instead of the ESM "import"
// sub-condition, producing __commonJS + __require("crypto") wrappers that throw
// "Dynamic require of 'crypto' is not supported" at runtime in Node.js ESM.
// Keeping them external lets Node.js resolve them correctly via the "import" path.
const sharedExternal: (string | RegExp)[] = [
  /^@midnight-ntwrk\//,
  "arweave",
  /^@ardrive\//,
  /^@dha-team\//,
  /^@noble\//,
  "bip39",
];

// "node:fs" and "fs" are added to the browser build external list because
// MidnightChainAdapter uses a dynamic import("node:fs") inside its provider-mode
// code path. That path is never reached in connector (browser) mode, so leaving
// it as an external dynamic import is safe — bundlers (Vite, webpack) stub it,
// and the call is never executed at runtime in the browser.
const browserOnlyExternal: (string | RegExp)[] = ["node:fs", "fs"];

export default defineConfig([
  // Dependency-free error codes/types entry. Bundled from src/errors.public.ts,
  // which imports only pure "./errors" subpaths (chain, storage) and crypto's
  // lightweight index — never adapter code. Safe for any bundler/environment.
  {
    entry: { errors: "src/errors.public.ts" },
    format: ["esm", "cjs"],
    dts: {
      resolve: [/^@dstorage\/(crypto|storage|chain)/],
    },
    tsconfig: "tsconfig.build.json",
    noExternal: sharedNoExternal,
    external: sharedExternal,
  },
  // Node.js build: mocks only, ESM + CJS.
  {
    entry: { index: "src/index.publish.ts" },
    format: ["esm", "cjs"],
    dts: {
      resolve: [/^@dstorage\/(crypto|payment|encryption|storage|chain)/],
    },
    tsconfig: "tsconfig.build.json",
    // Bundle lightweight siblings inline.
    noExternal: sharedNoExternal,
    // Payment's full index pulls in ArweavePaymentAdapter → arweave and
    // ManagedPaymentAdapter → @midnight-ntwrk/midnight-js-protocol/ledger as dead code paths.
    // Keep these external so rollup doesn't bundle them — they're never reachable
    // from the exported mock adapters.
    external: sharedExternal,
    esbuildOptions(options) {
      // Chain's tsup build uses code-splitting, producing bare `import "./chunk.mjs"`
      // lines in its dist. esbuild correctly ignores them under sideEffects:false but
      // emits a warning each time. The tree-shaking is working as intended — silence it.
      options.logOverride = { "ignored-bare-import": "silent" };
    },
  },
  // Browser build: all browser-safe adapters, minified ESM only.
  // Heavy peer deps (arweave, @midnight-ntwrk/*, @noble/*, bip39) remain external
  // so users can resolve them via their bundler or a CDN import map.
  {
    entry: { browser: "src/browser.ts" },
    format: ["esm"],
    platform: "browser",
    minify: true,
    dts: {
      resolve: [/^@dstorage\/(crypto|payment|encryption|storage|chain)/],
    },
    tsconfig: "tsconfig.build.json",
    noExternal: sharedNoExternal,
    external: [...sharedExternal, ...browserOnlyExternal],
    esbuildOptions(options) {
      options.logOverride = { "ignored-bare-import": "silent" };
    },
  },
]);
