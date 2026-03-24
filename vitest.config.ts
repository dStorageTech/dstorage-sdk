import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "packages/*/src/__tests__/**/*.test.ts",
      "packages/chain/src/adapters/midnight/contracts/src/test/**/*.test.ts",
    ],
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "packages/*/src/__tests__/**",
        "packages/*/src/index.ts",
        "packages/*/src/contracts/**", // compiled contract artifacts (generated)
      ],
      reporter: ["text", "lcov", "html"],
    },
  },
  resolve: {
    alias: {
      "@dstorage/crypto": path.resolve(
        __dirname,
        "packages/crypto/src/index.ts",
      ),
      "@dstorage/seed-providers": path.resolve(
        __dirname,
        "packages/seed-providers/src/index.ts",
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
