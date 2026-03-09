export * from "./types.js"; // includes Logger
export * from "./dStorage.js";
export * from "./wallet.js";
export * from "./payment.js";
export * from "./metaTransaction.js";
export * from "./contracts.js";
export * from "./zkProof.js";

// Re-export adapters for convenience — developers only need to import @dstorage/core
export {
  MockStorageAdapter,
  ArweaveStorageAdapter,
  AutonomiStorageAdapter,
  // Local / testnet
  ArweaveLocalStorageAdapter,
  ArweaveLocalHelper,
  ArweaveLocalError,
  ARWEAVE_MAINNET,
  ARWEAVE_LOCAL,
  arlocalGateway,
} from "@dstorage/storage";

export type {
  ArweaveLocalAdapterConfig,
  ArweaveLocalHelperConfig,
  ArweaveLocalInfo,
  ArweaveLocalBalance,
} from "@dstorage/storage";

export {
  MockChainAdapter,
  MockMidnightChainAdapter,
  MockProofServer,
  // MidnightChainAdapter connector mode is browser-compatible (Node.js-only facade imports
  // are dynamic with /* @vite-ignore */ and are never executed in connector mode).
  MidnightChainAdapter,
} from "@dstorage/chain";

export type {
  DataReferenceSummary,
  ChainReference,
  MidnightChainAdapterConfig,
} from "@dstorage/chain";

export {
  MockPaymentAdapter,
  ArweavePaymentAdapter,
  MidnightPaymentAdapter,
  WalletManagedPaymentAdapter,
} from "@dstorage/payment";

export type { PaymentAdapter, PaymentQuote } from "@dstorage/payment";
