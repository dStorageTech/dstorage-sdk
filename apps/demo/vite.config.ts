import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
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
    // Midnight SDK packages contain WASM that can't be pre-bundled by esbuild.
    // They're only loaded at runtime via dynamic import when executing real
    // Midnight transactions, so excluding them from optimization is safe.
    exclude: [
      '@midnight-ntwrk/compact-runtime',
      '@midnight-ntwrk/onchain-runtime',
      '@midnight-ntwrk/onchain-runtime-v2',
      '@midnight-ntwrk/midnight-js-contracts',
      '@midnight-ntwrk/midnight-js-types',
      '@midnight-ntwrk/midnight-js-network-id',
    ],
  },
});
