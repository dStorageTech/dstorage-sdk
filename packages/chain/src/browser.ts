/**
 * @dstorage/chain — browser-safe entry
 *
 * Exports mock adapters, HttpGatewayChainAdapter, and MidnightChainAdapter
 * in connector mode. In connector mode, MidnightChainAdapter only uses
 * browser-compatible packages. Node.js-only facade-mode imports use @vite-ignore
 * dynamic imports and are never executed in connector mode, so they are safe to
 * include in the browser bundle.
 */
export * from "./types.js";
export * from "./errors.js";
export * from "./adapters/mock.js";
export * from "./adapters/midnightSimulator.js";
export * from "./adapters/httpGateway.js";
export {
  MidnightChainAdapter,
  NETWORKS,
  PROVER_MODE,
} from "./adapters/midnight/src/midnight.js";
export type {
  MidnightChainAdapterConfig,
  ProverMode,
  WalletAddresses,
} from "./adapters/midnight/src/midnight.js";
export type { NetworkId } from "@midnight-ntwrk/midnight-js-network-id";
