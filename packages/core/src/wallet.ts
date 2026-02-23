/**
 * @dstorage/core — wallet.ts
 *
 * Wallet connection helpers.
 * Each function:
 *   1. Connects to the wallet
 *   2. Requests a signature of the key-derivation message
 *   3. Returns a WalletInfo ready to pass into dStorage.connect()
 */

import { KEY_DERIVATION_MESSAGE } from '@dstorage/crypto';
import type { WalletInfo } from './types.js';

// ── MetaMask / EIP-1193 wallets ───────────────────────────────────────────────

/** EIP-1193 provider shape (MetaMask, Rabby, etc.) */
interface EIP1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
    midnight?: MidnightWalletProvider;
  }
}

interface MidnightWalletProvider {
  enable(): Promise<void>;
  getAccounts(): Promise<string[]>;
  signMessage(address: string, message: string): Promise<string>;
}

/**
 * Connect to MetaMask (or any EIP-1193 compatible wallet).
 *
 * - Requests account access
 * - Signs the deterministic key-derivation message
 * - Returns WalletInfo ready for dStorage.connect()
 */
export async function connectMetaMask(): Promise<WalletInfo> {
  if (typeof window === 'undefined' || !window.ethereum) {
    throw new Error(
      '[dStorage] MetaMask not detected. Please install MetaMask: https://metamask.io'
    );
  }

  const provider = window.ethereum;

  // Request account access
  const accounts = (await provider.request({
    method: 'eth_requestAccounts',
  })) as string[];

  if (!accounts || accounts.length === 0) {
    throw new Error('[dStorage] No accounts returned from MetaMask.');
  }

  const address = accounts[0]!;

  // Sign key-derivation message — this signature is deterministic per wallet
  const signatureHex = (await provider.request({
    method: 'personal_sign',
    params: [KEY_DERIVATION_MESSAGE, address],
  })) as string;

  console.log(`[dStorage] MetaMask connected: ${address}`);

  return {
    address,
    chainProvider: 'mock', // Will become 'ethereum' in Phase 2
    _signatureHex: signatureHex,
  };
}

/**
 * Connect to the Midnight wallet (Lace with Midnight extension).
 *
 * Status: Preview — the DApp Connector API is available in Midnight testnet-02.
 * Docs: https://docs.midnight.network/develop/tutorial/building-a-dapp/connect-wallet
 */
export async function connectMidnightWallet(): Promise<WalletInfo> {
  if (typeof window === 'undefined' || !window.midnight) {
    throw new Error(
      '[dStorage] Midnight wallet not detected. ' +
        'Please install the Lace wallet with Midnight extension.'
    );
  }

  /**
   * TODO: Replace with real Midnight DApp Connector API:
   *
   *   import { DAppConnector } from '@midnight-ntwrk/dapp-connector';
   *   const connector = new DAppConnector();
   *   const api = await connector.enable();
   *   const [address] = await api.getUsedAddresses();
   *   const signatureHex = await api.signData(address, KEY_DERIVATION_MESSAGE);
   *
   * The Midnight DApp Connector uses ZK proofs to sign without revealing the key.
   */

  await window.midnight.enable();
  const accounts = await window.midnight.getAccounts();
  const address = accounts[0] ?? 'midnight_address_placeholder';

  const signatureHex = await window.midnight.signMessage(
    address,
    KEY_DERIVATION_MESSAGE
  );

  console.log(`[dStorage] Midnight wallet connected: ${address}`);

  return {
    address,
    chainProvider: 'midnight',
    _signatureHex: signatureHex,
  };
}

/**
 * Demo helper: create a fake wallet connection without a real wallet.
 * Useful for testing and demos in environments without extensions.
 */
export async function connectDemoWallet(address = '0xDemoWallet1234'): Promise<WalletInfo> {
  // Use a deterministic fake signature for demo purposes
  const fakeSignature = `0x${'ab'.repeat(32)}${address.replace('0x', '').slice(0, 8)}`;

  console.warn(
    '[dStorage] Demo wallet connected — encryption is real but not wallet-bound. For production, use connectMetaMask() or connectMidnightWallet().'
  );

  return {
    address,
    chainProvider: 'mock',
    _signatureHex: fakeSignature,
  };
}
