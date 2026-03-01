/**
 * @dstorage/chain — browser-safe entry
 *
 * Exports only the mock chain adapters. MidnightChainAdapter is excluded
 * because its dependencies (testkit-js, wallet-sdk-facade, etc.) are
 * Node.js-only and cannot be bundled for the browser.
 *
 * For real Midnight chain integration in a browser dApp, the MidnightChainAdapter
 * must be imported dynamically and all Midnight wallet SDK packages need to be
 * resolved separately (e.g., via the Lace wallet connector).
 */
export * from './types.js';
export * from './adapters/mock.js';
export * from './adapters/mockMidnight.js';
export * from './mockProofServer.js';
