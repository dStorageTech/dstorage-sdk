// Core SDK
export * from "./types.js";
export * from "./dStorage.js";
export { CHUNK_SIZE, isManifest } from "./chunked.js";
export type { ChunkManifest, ChunkEntry } from "./chunked.js";

// Crypto + encryption adapters (lightweight, no heavy deps)
export * from "@dstorage/crypto";
export * from "@dstorage/encryption";
// Explicit re-exports below: rollup-plugin-dts only inlines wildcard-exported
// symbols that are transitively referenced by type elsewhere in the bundled
// graph, so functions/classes with no other type reference get silently
// dropped from the built .d.ts unless listed explicitly.
export {
  CryptoErrorCode,
  DStorageError,
  isDStorageError,
  computeBlake3,
  computeBlake3Hex,
  base64urlToBytes,
  bytesToBase64url,
  KeyDeriver,
  hexToBytes,
  mlkemGenerateKeypair,
  mlkemGenerateKeypairFromSeed,
  mlkemWrapDek,
  mlkemUnwrapDek,
  generateDek,
  deriveKek,
  wrapKey,
  unwrapKey,
  deriveOwnerSecret,
  buildKeyEnvelope,
  serializeKeyEnvelope,
  parseKeyEnvelope,
  deriveSymmetricKeyFromSeed,
  encryptXChaCha,
  decryptXChaCha,
  encryptStorageIdXChaCha,
  decryptStorageIdXChaCha,
  serializeXChaChaPayload,
  deserializeXChaChaPayload,
} from "@dstorage/crypto";

// Core: own error codes and partial-failure recovery error
export {
  CoreErrorCode,
  StorePartialError,
  isStorePartialError,
} from "./errors.js";

// Storage: types + all adapters.
// Full package imports (not subpaths) so dts.resolve can inline type declarations.
export type {
  StorageAdapter,
  StorageAdapterLogger,
  StorageProviderName,
  StorageQuote,
  StorageUploadResult,
} from "@dstorage/storage";
export { MockStorageAdapter } from "@dstorage/storage";
export type { MockStorageAdapterConfig } from "@dstorage/storage";
export { StorageErrorCode } from "@dstorage/storage";
export { ArweaveStorageAdapter } from "@dstorage/storage";
export { ArweaveBundlerStorageAdapter } from "@dstorage/storage";
export type { ArweaveBundlerAdapterConfig } from "@dstorage/storage";
// ArweaveLocalStorageAdapter: no node:http dependency — uses fetch() throughout. Node-safe.
export {
  ArweaveLocalStorageAdapter,
  ArweaveLocalHelper,
  ARWEAVE_LOCAL,
  arlocalGateway,
  ArweaveLocalError,
} from "@dstorage/storage";
export type {
  ArweaveLocalAdapterConfig,
  ArweaveLocalHelperConfig,
  ArweaveLocalInfo,
  ArweaveLocalBalance,
} from "@dstorage/storage";

// Payment: types + all adapters
export type {
  PaymentAdapter,
  PaymentAdapterLogger,
  PaymentQuote,
  PaymentReceipt,
  NetworkType,
  TokenSymbol,
  Token,
  PaymentNetworkName,
  MidnightWalletProvider,
} from "@dstorage/payment";
export { MockPaymentAdapter, TOKENS } from "@dstorage/payment";
export { ArweavePaymentAdapter } from "@dstorage/payment";
export { ManagedPaymentAdapter } from "@dstorage/payment";

// Chain: types + mock + real Midnight adapter (Node.js provider mode).
// Heavy @midnight-ntwrk/* peer deps are lazy-loaded via dynamic import at
// call time, never at module load, so requiring this entry stays light.
export type {
  ChainAdapter,
  ChainProviderName,
  ChainReference,
  ChainReferenceUpdate,
  ChainWriteResult,
  ChainAdapterLogger,
  WalletBalances,
  DataReferenceSummary,
  ChainQuote,
} from "@dstorage/chain";
export {
  MockChainAdapter,
  MidnightSimulatorChainAdapter,
  MidnightChainAdapter,
  HttpGatewayChainAdapter,
  NETWORKS,
  waitForFacadeSync,
} from "@dstorage/chain";
export { ChainErrorCode } from "@dstorage/chain";
export type {
  MidnightChainAdapterConfig,
  WalletAddresses,
  AdapterWalletProvider,
  HttpGatewayChainAdapterConfig,
  NetworkId,
} from "@dstorage/chain";
