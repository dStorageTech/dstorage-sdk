export * from './types.js';
export * from './dStorage.js';
export * from './wallet.js';
export * from './payment.js';
export * from './metaTransaction.js';
export * from './contracts.js';
export * from './zkProof.js';

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
} from '@dstorage/storage';

export type {
  ArweaveLocalAdapterConfig,
  ArweaveLocalHelperConfig,
  ArweaveLocalInfo,
  ArweaveLocalBalance,
} from '@dstorage/storage';

export {
  MockChainAdapter,
  MockMidnightChainAdapter,
  MockProofServer,
  // MidnightChainAdapter is intentionally not re-exported here — it has Node.js-only
  // dependencies (testkit-js, wallet-sdk-facade, etc.) that cannot be bundled for browser.
  // Import it directly from '@dstorage/chain' in Node.js environments only.
} from '@dstorage/chain';

export type { ChainReference, CircuitCallResult } from '@dstorage/chain';

export {
  MockPaymentAdapter,
  ArweavePaymentAdapter,
  MidnightPaymentAdapter,
  WalletManagedPaymentAdapter,
} from '@dstorage/payment';

export type { PaymentAdapter, PaymentQuote } from '@dstorage/payment';
