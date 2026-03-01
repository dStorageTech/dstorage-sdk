import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react(), wasm()],
  resolve: {
    // Prefer browser-specific builds for packages that ship both Node.js and browser versions.
    mainFields: ['browser', 'module', 'main'],
    alias: {
      '@dstorage/crypto': resolve(__dirname, '../../packages/crypto/src/index.ts'),
      '@dstorage/storage': resolve(__dirname, '../../packages/storage/src/index.ts'),
      // Browser-safe chain entry: mock adapters only.
      // MidnightChainAdapter is excluded (its deps are Node.js-only).
      '@dstorage/chain': resolve(__dirname, '../../packages/chain/src/browser.ts'),
      '@dstorage/payment': resolve(__dirname, '../../packages/payment/src/index.ts'),
      '@dstorage/core': resolve(__dirname, '../../packages/core/src/index.ts'),
      // Node.js built-ins imported by Midnight SDK packages.
      // More-specific entries MUST come before less-specific ones (first-match wins).
      'node:fs/promises': resolve(__dirname, 'src/polyfills/empty.js'),
      'node:fs': resolve(__dirname, 'src/polyfills/empty.js'),
      'node:path': resolve(__dirname, 'src/polyfills/empty.js'),
      'fs/promises': resolve(__dirname, 'src/polyfills/empty.js'),
      'fs': resolve(__dirname, 'src/polyfills/empty.js'),
      'path': resolve(__dirname, 'src/polyfills/empty.js'),
    },
  },
  optimizeDeps: {
    // Force Vite to pre-bundle these so esbuild converts their CJS exports to
    // ESM named exports (e.g. `buffer` exports Buffer only via module.exports).
    include: [
      '@midnight-ntwrk/midnight-js-contracts',
      '@midnight-ntwrk/midnight-js-indexer-public-data-provider',
      '@midnight-ntwrk/midnight-js-fetch-zk-config-provider',
      // object-inspect is CJS-only (module.exports = fn). compact-runtime imports it
      // via `import inspect from 'object-inspect'` — pre-bundle so esbuild synthesises
      // `export default` from the CJS module.exports.
      'object-inspect',
      'buffer',
    ],
    // Midnight SDK packages that contain WASM or mixed CJS/ESM that esbuild
    // can't pre-bundle. Loaded at runtime via dynamic import; vite-plugin-wasm
    // handles the .wasm files when the browser requests them.
    // Also exclude Node.js-only Midnight packages so esbuild doesn't choke on them.
    exclude: [
      '@midnight-ntwrk/compact-runtime',
      '@midnight-ntwrk/onchain-runtime',
      '@midnight-ntwrk/onchain-runtime-v2',
      '@midnight-ntwrk/midnight-js-types',
      '@midnight-ntwrk/midnight-js-network-id',
      '@midnight-ntwrk/midnight-js-utils',
      '@midnight-ntwrk/compact-js',
      '@midnight-ntwrk/platform-js',
      '@midnight-ntwrk/ledger-v7',
      '@midnight-ntwrk/midnight-js-node-zk-config-provider',
      '@midnight-ntwrk/midnight-js-level-private-state-provider',
      '@midnight-ntwrk/testkit-js',
      '@midnight-ntwrk/wallet-sdk-facade',
      '@midnight-ntwrk/wallet-sdk-shielded',
      '@midnight-ntwrk/wallet-sdk-unshielded-wallet',
      '@midnight-ntwrk/wallet-sdk-abstractions',
      '@midnight-ntwrk/wallet-sdk-dust-wallet',
    ],
  },
});
