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
} from '@dstorage/storage';

export {
  MockChainAdapter,
  MidnightChainAdapter,
} from '@dstorage/chain';

export {
  MockPaymentAdapter,
  ArweavePaymentAdapter,
  MidnightPaymentAdapter,
} from '@dstorage/payment';

export type { PaymentAdapter, PaymentQuote } from '@dstorage/payment';
