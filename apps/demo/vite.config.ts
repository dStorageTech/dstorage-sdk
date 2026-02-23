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
      '@dstorage/core': resolve(__dirname, '../../packages/core/src/index.ts'),
    },
  },
});
