import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["./tests/integration/setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // These suites share one mutable local chain (arlocal) that every suite
    // independently mines blocks on (each ArweaveLocalStorageAdapter.store()
    // call, plus the bundler mock server's own relay). Running test files
    // concurrently races block-mining against in-flight transactions built
    // against a now-stale tx_anchor, causing sporadic arlocal rejections and
    // content-hash mismatches. Run files sequentially instead.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@dstorage/crypto": path.resolve(
        __dirname,
        "packages/crypto/src/index.ts",
      ),
      "@dstorage/encryption": path.resolve(
        __dirname,
        "packages/encryption/src/index.ts",
      ),
      "@dstorage/storage": path.resolve(
        __dirname,
        "packages/storage/src/index.ts",
      ),
      "@dstorage/chain": path.resolve(__dirname, "packages/chain/src/index.ts"),
      "@dstorage/payment": path.resolve(
        __dirname,
        "packages/payment/src/index.ts",
      ),
      "@dstorage/core": path.resolve(__dirname, "packages/core/src/index.ts"),
    },
  },
});
