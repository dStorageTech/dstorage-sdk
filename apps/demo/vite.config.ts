import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react(), wasm()],
  resolve: {
    alias: {
      '@dstorage/crypto': resolve(__dirname, '../../packages/crypto/src/index.ts'),
      '@dstorage/storage': resolve(__dirname, '../../packages/storage/src/index.ts'),
      '@dstorage/chain': resolve(__dirname, '../../packages/chain/src/index.ts'),
      '@dstorage/payment': resolve(__dirname, '../../packages/payment/src/index.ts'),
      '@dstorage/core': resolve(__dirname, '../../packages/core/src/index.ts'),
    },
  },
  optimizeDeps: {
    // Midnight SDK packages contain WASM + mixed CJS/ESM that esbuild can't
    // pre-bundle. They're loaded at runtime via dynamic import; vite-plugin-wasm
    // handles the .wasm files when the browser requests them.
    exclude: [
      '@midnight-ntwrk/compact-runtime',
      '@midnight-ntwrk/onchain-runtime',
      '@midnight-ntwrk/onchain-runtime-v2',
      '@midnight-ntwrk/midnight-js-contracts',
      '@midnight-ntwrk/midnight-js-types',
      '@midnight-ntwrk/midnight-js-network-id',
      '@midnight-ntwrk/midnight-js-utils',
      '@midnight-ntwrk/compact-js',
      '@midnight-ntwrk/platform-js',
      '@midnight-ntwrk/ledger-v7',
    ],
  },
});
