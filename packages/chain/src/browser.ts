/**
 * @dstorage/chain — browser-safe entry
 *
 * Exports mock adapters plus MidnightChainAdapter in connector mode.
 * In connector mode, MidnightChainAdapter only uses browser-compatible packages.
 * Node.js-only facade-mode imports use @vite-ignore dynamic imports and are
 * never executed in connector mode, so they are safe to include in the browser bundle.
 */
export * from './types.js';
export * from './adapters/mock.js';
export * from './adapters/mockMidnight.js';
export * from './mockProofServer.js';
export { MidnightChainAdapter } from './adapters/midnight/src/midnight.js';
export type { MidnightChainAdapterConfig, WalletAddresses, WalletBalances } from './adapters/midnight/src/midnight.js';
