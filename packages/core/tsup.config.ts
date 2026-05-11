import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.publish.ts" },
  format: ["esm", "cjs"],
  dts: {
    resolve: [/^@dstorage\/(crypto|payment|encryption|storage|chain)/],
  },
  tsconfig: "tsconfig.build.json",
  // Bundle lightweight siblings inline.
  noExternal: [
    "@dstorage/crypto",
    "@dstorage/payment",
    "@dstorage/encryption",
    "@dstorage/storage",
    "@dstorage/chain",
  ],
  // Payment's full index pulls in ArweavePaymentAdapter → arweave and
  // ManagedPaymentAdapter → @midnight-ntwrk/ledger-v8 as dead code paths.
  // Keep these external so rollup doesn't bundle them — they're never reachable
  // from the exported mock adapters.
  external: [/^@midnight-ntwrk\//, "arweave", /^@ardrive\//, /^@dha-team\//],
  esbuildOptions(options) {
    // Chain's tsup build uses code-splitting, producing bare `import "./chunk.mjs"`
    // lines in its dist. esbuild correctly ignores them under sideEffects:false but
    // emits a warning each time. The tree-shaking is working as intended — silence it.
    options.logOverride = { "ignored-bare-import": "silent" };
  },
});
