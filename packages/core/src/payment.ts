/**
 * @dstorage/core — payment.ts
 *
 * Payment abstraction layer.
 *
 * In this MVP sprint, payments are SIMULATED — the SDK calculates real cost
 * estimates and mimics the payment UX (wallet prompt, signing, confirmation)
 * but no actual token transfer occurs.
 *
 * Real payment integration is planned for Sprint 2:
 *   - Storage payments: AR (Arweave), ANT (Autonomi)
 *   - Chain tx fees:    DUST (Midnight), ETH/gas (EVM)
 *   - Token conversion gateway for cross-token payments
 */

// ── Token definitions ─────────────────────────────────────────────────────────

export type TokenSymbol = 'AR' | 'ANT' | 'DUST' | 'ETH' | 'MATIC' | 'MOCK';

export interface Token {
  symbol: TokenSymbol;
  name: string;
  decimals: number;
  /** Approximate USD price — used for display only in simulated mode */
  approxUsdPrice: number;
}

export const TOKENS: Record<TokenSymbol, Token> = {
  AR:   { symbol: 'AR',   name: 'Arweave',     decimals: 12, approxUsdPrice: 22.50 },
  ANT:  { symbol: 'ANT',  name: 'Autonomi',    decimals: 9,  approxUsdPrice: 0.08  },
  DUST: { symbol: 'DUST', name: 'Midnight',    decimals: 6,  approxUsdPrice: 0.15  },
  ETH:  { symbol: 'ETH',  name: 'Ethereum',    decimals: 18, approxUsdPrice: 3200  },
  MATIC:{ symbol: 'MATIC',name: 'Polygon',     decimals: 18, approxUsdPrice: 0.95  },
  MOCK: { symbol: 'MOCK', name: 'Mock Token',  decimals: 6,  approxUsdPrice: 1.00  },
};

// ── Cost estimate ─────────────────────────────────────────────────────────────

export interface CostEstimate {
  /** Cost in the storage network's native token */
  storageCost: {
    amount: string;
    token: TokenSymbol;
    usd: string;
  };
  /** Cost of writing the on-chain reference */
  chainCost: {
    amount: string;
    token: TokenSymbol;
    usd: string;
  };
  /** Combined total in USD (approximate) */
  totalUsd: string;
  /** File size in bytes */
  fileSizeBytes: number;
  /** Human-readable file size */
  fileSizeDisplay: string;
}

// ── Payment receipt ───────────────────────────────────────────────────────────

export interface PaymentReceipt {
  /** Simulated transaction hash */
  txHash: string;
  /** Token used */
  token: TokenSymbol;
  /** Amount paid */
  amount: string;
  /** USD equivalent */
  usd: string;
  /** Payment type */
  type: 'storage' | 'chain';
  /** Whether this was a real or simulated payment */
  simulated: true;
  /** Timestamp */
  paidAt: number;
}

// ── Cost calculator ───────────────────────────────────────────────────────────

/**
 * Calculate the estimated cost for storing a file.
 *
 * Arweave pricing model: ~$0.004 per MB permanently (as of early 2025).
 * Autonomi pricing model: ~$0.001 per MB permanently (estimated).
 * Chain reference: flat fee per transaction.
 */
export function estimateCost(
  fileSizeBytes: number,
  storageToken: TokenSymbol,
  chainToken: TokenSymbol
): CostEstimate {
  const fileSizeMB = fileSizeBytes / (1024 * 1024);
  const fileSizeDisplay = fileSizeMB < 1
    ? `${(fileSizeBytes / 1024).toFixed(1)} KB`
    : `${fileSizeMB.toFixed(2)} MB`;

  // Storage cost calculation
  let storageUsd: number;
  let storageAmount: string;

  switch (storageToken) {
    case 'AR': {
      // Arweave: ~$0.004/MB for permanent storage
      storageUsd = Math.max(0.0001, fileSizeMB * 0.004);
      const arPrice = TOKENS['AR'].approxUsdPrice;
      storageAmount = (storageUsd / arPrice).toFixed(8);
      break;
    }
    case 'ANT': {
      // Autonomi: ~$0.001/MB permanent
      storageUsd = Math.max(0.0001, fileSizeMB * 0.001);
      const antPrice = TOKENS['ANT'].approxUsdPrice;
      storageAmount = (storageUsd / antPrice).toFixed(6);
      break;
    }
    default: {
      // Mock token: 1 MOCK per KB
      storageUsd = Math.max(0.0001, fileSizeBytes / 1024 * 0.001);
      storageAmount = (fileSizeBytes / 1024).toFixed(4);
    }
  }

  // Chain cost: flat fee per reference write
  let chainUsd: number;
  let chainAmount: string;

  switch (chainToken) {
    case 'DUST': {
      // Midnight: ~$0.01 per tx
      chainUsd = 0.01;
      chainAmount = (chainUsd / TOKENS['DUST'].approxUsdPrice).toFixed(4);
      break;
    }
    case 'ETH': {
      // Ethereum: ~$2 per simple tx (gas estimate)
      chainUsd = 2.00;
      chainAmount = (chainUsd / TOKENS['ETH'].approxUsdPrice).toFixed(8);
      break;
    }
    default: {
      chainUsd = 0.001;
      chainAmount = '0.0010';
    }
  }

  const totalUsd = (storageUsd + chainUsd).toFixed(6);

  return {
    storageCost: {
      amount: storageAmount,
      token: storageToken,
      usd: storageUsd.toFixed(6),
    },
    chainCost: {
      amount: chainAmount,
      token: chainToken,
      usd: chainUsd.toFixed(6),
    },
    totalUsd,
    fileSizeBytes,
    fileSizeDisplay,
  };
}

// ── Simulated payment ─────────────────────────────────────────────────────────

/**
 * Simulate a payment transaction.
 *
 * In production this would:
 *   - For Arweave: call arweave.transactions.sign() + post()
 *   - For Midnight: call contract balance deduction via Midnight.js
 *   - For EVM: call ethers.js sendTransaction() with token transfer
 *
 * Here we simulate the UX: a short delay mimicking wallet prompt + confirmation.
 */
export async function simulatePayment(
  type: 'storage' | 'chain',
  amount: string,
  token: TokenSymbol,
  usd: string,
  onStatusUpdate?: (msg: string) => void
): Promise<PaymentReceipt> {
  const tokenName = TOKENS[token]?.name ?? token;

  // Step 1: Wallet prompt simulation
  onStatusUpdate?.(`Requesting ${tokenName} wallet signature…`);
  await delay(600);

  // Step 2: Broadcasting simulation
  onStatusUpdate?.(`Broadcasting ${type} payment transaction…`);
  await delay(800);

  // Step 3: Confirmation simulation
  onStatusUpdate?.(`Awaiting confirmation…`);
  await delay(500);

  const txHash = generateSimulatedTxHash();

  return {
    txHash,
    token,
    amount,
    usd,
    type,
    simulated: true,
    paidAt: Date.now(),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateSimulatedTxHash(): string {
  const hex = Array.from(
    { length: 64 },
    () => Math.floor(Math.random() * 16).toString(16)
  ).join('');
  return `0x${hex}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Token selector helpers ────────────────────────────────────────────────────

/** Get the default storage payment token for a given storage provider */
export function defaultStorageToken(
  storageProvider: string
): TokenSymbol {
  switch (storageProvider) {
    case 'arweave':  return 'AR';
    case 'autonomi': return 'ANT';
    default:         return 'MOCK';
  }
}

/** Get the default chain payment token for a given chain provider */
export function defaultChainToken(
  chainProvider: string
): TokenSymbol {
  switch (chainProvider) {
    case 'midnight': return 'DUST';
    case 'ethereum': return 'ETH';
    case 'polygon':  return 'MATIC';
    default:         return 'MOCK';
  }
}
