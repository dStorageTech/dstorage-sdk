import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { resolve } from "path";

export default defineConfig({
  plugins: [
    react(),
    wasm(),
    topLevelAwait({
      promiseExportName: "__tla",
      promiseImportName: (i) => `__tla_${i}`,
    }),
  ],
  resolve: {
    // Prefer browser-specific builds for packages that ship both Node.js and browser versions.
    mainFields: ["browser", "module", "main"],
    alias: {
      "@dstorage/crypto": resolve(
        __dirname,
        "../../packages/crypto/src/index.ts",
      ),
      "@dstorage/encryption": resolve(
        __dirname,
        "../../packages/encryption/src/index.ts",
      ),
      "@dstorage/storage": resolve(
        __dirname,
        "../../packages/storage/src/index.ts",
      ),
      // Browser-safe chain entry: mock adapters + MidnightChainAdapter (connector mode only).
      "@dstorage/chain": resolve(
        __dirname,
        "../../packages/chain/src/browser.ts",
      ),
      "@dstorage/payment": resolve(
        __dirname,
        "../../packages/payment/src/index.ts",
      ),
      "@dstorage-tech/dstorage": resolve(
        __dirname,
        "../../packages/core/src/index.ts",
      ),
      // Node.js built-ins — polyfill with empty stubs.
      // More-specific entries MUST come before less-specific ones (first-match wins).
      "node:fs/promises": resolve(__dirname, "src/polyfills/empty.js"),
      "node:fs": resolve(__dirname, "src/polyfills/empty.js"),
      "node:path": resolve(__dirname, "src/polyfills/empty.js"),
      "fs/promises": resolve(__dirname, "src/polyfills/empty.js"),
      fs: resolve(__dirname, "src/polyfills/empty.js"),
      path: resolve(__dirname, "src/polyfills/empty.js"),
      // turbo-sdk has no "browser" export condition — alias to its web entry explicitly.
      "@ardrive/turbo-sdk": resolve(
        __dirname,
        "../../node_modules/@ardrive/turbo-sdk/lib/esm/web/index.js",
      ),
    },
  },
  build: {
    target: "esnext",
    rollupOptions: {
      // Mark Node.js-only packages as external so Rollup never tries to bundle them.
      // These packages are only used in /* @vite-ignore */ dynamic imports that
      // never execute in connector (browser) mode.
      external: [
        // Midnight wallet SDK (Node.js / facade mode only)
        /^@midnight-ntwrk\/wallet-sdk/,
        /^@midnight-ntwrk\/midnight-js-node-zk-config-provider/,
        /^@midnight-ntwrk\/midnight-js-level-private-state-provider/,
        /^ssh2/,
        "leveldown",
        "level",
      ],
      output: {
        // Isolate the WASM runtime in its own chunk to avoid top-level await conflicts.
        manualChunks: {
          wasm: ["@midnight-ntwrk/onchain-runtime-v2"],
        },
      },
    },
  },
  // Inject a minimal process shim so Node.js CJS polyfills bundled transitively
  // from @subsquid/scale-codec → assert → util don't throw "process is not defined".
  // The only access that fires at module init time is `process.env.NODE_DEBUG`.
  define: {
    "process.env": "{}",
    "process.browser": "true",
    "process.version": '"v18.0.0"',
    "process.platform": '"browser"',
  },
  optimizeDeps: {
    esbuildOptions: {
      target: "esnext",
      supported: { "top-level-await": true },
      // Same shim for the esbuild pre-bundling phase (optimizeDeps).
      define: {
        global: "globalThis",
        "process.env": "{}",
        "process.browser": "true",
        "process.version": '"v18.0.0"',
        "process.platform": '"browser"',
      },
    },
    // Pre-bundle compact-runtime so esbuild converts its CJS/TLA to ESM.
    // Also pre-bundle other packages that need CJS→ESM conversion.
    include: [
      "@midnight-ntwrk/compact-runtime",
      "@midnight-ntwrk/midnight-js-contracts",
      "@midnight-ntwrk/midnight-js-indexer-public-data-provider",
      "@midnight-ntwrk/midnight-js-fetch-zk-config-provider",
      "@midnight-ntwrk/midnight-js-http-client-proof-provider",
      // object-inspect is CJS-only; compact-runtime imports it via default import.
      "object-inspect",
      "buffer",
    ],
    // Exclude the raw WASM runtime (must be a separate chunk loaded at runtime).
    // Also exclude Node.js-only Midnight packages so esbuild doesn't choke on them.
    exclude: [
      "@midnight-ntwrk/onchain-runtime-v2",
      "@midnight-ntwrk/midnight-js-node-zk-config-provider",
      "@midnight-ntwrk/midnight-js-level-private-state-provider",
      "@midnight-ntwrk/wallet-sdk-facade",
      "@midnight-ntwrk/wallet-sdk-shielded",
      "@midnight-ntwrk/wallet-sdk-unshielded-wallet",
      "@midnight-ntwrk/wallet-sdk-abstractions",
      "@midnight-ntwrk/wallet-sdk-dust-wallet",
    ],
  },
});
