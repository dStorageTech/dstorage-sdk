export * from "./types.js";
export * from "./errors.js";
export * from "./adapters/mock.js";
export * from "./adapters/midnightSimulator.js";
export * from "./adapters/httpGateway.js";
export * from "./adapters/midnight/src/midnight.js";
export type { AdapterWalletProvider } from "./adapters/midnight/src/common-types.js";
export type { NetworkId } from "@midnight-ntwrk/midnight-js-network-id";

export { NETWORKS } from "./adapters/midnight/src/midnight.js";
export { waitForFacadeSync } from "./adapters/midnight/src/sync.js";
