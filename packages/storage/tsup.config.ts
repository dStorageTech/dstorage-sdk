import { defineConfig } from "tsup";

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
  // Browser build: same public surface as the Node build above.
  {
    entry: { browser: "src/browser.ts" },
    format: ["esm"],
    platform: "browser",
    dts: true,
    tsconfig: "tsconfig.json",
  },
]);
