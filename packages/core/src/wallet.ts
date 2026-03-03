/**
 * @dstorage/core — wallet.ts
 *
 * Wallet connection helpers.
 * Each function:
 *   1. Connects to the wallet
 *   2. Requests a signature of the key-derivation message
 *   3. Returns a WalletInfo ready to pass into dStorage.connect()
 */

import { KEY_DERIVATION_MESSAGE } from "@dstorage/crypto";
import type { WalletInfo } from "./types.js";

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

// ── Midnight DApp Connector v3 types ──────────────────────────────────────────

/**
 * The top-level object injected by the Lace/Midnight browser extension.
 * window.midnight.<networkId>.enable() returns a ConnectedAPI.
 * Docs: https://docs.midnight.network/develop/tutorial/building-a-dapp/connect-wallet
 */
interface MidnightDAppConnector {
  apiVersion: string;
  name: string;
  enable(): Promise<MidnightConnectedAPI>;
  isEnabled(): Promise<boolean>;
}

/**
 * Minimal surface of the connected DApp Connector v3 API.
 * Note: signData() is intentionally absent from v3 — signatures are embedded
 * inside ZK proofs and never exposed to dApp code.
 */
interface MidnightConnectedAPI {
  /** Returns the wallet's shielded (Bech32m) address for the connected network */
  getShieldedAddress(): Promise<string>;
  /** Balances a transaction by attaching DUST fees */
  balanceUnsealedTransaction(tx: unknown): Promise<unknown>;
  /** Broadcasts a balanced+proven transaction to the Midnight network */
  submitTransaction(tx: unknown): Promise<{ txHash: string }>;
}

interface MidnightWalletProvider {
  [networkId: string]: MidnightDAppConnector | undefined;
}

/**
 * Connect to MetaMask (or any EIP-1193 compatible wallet).
 *
 * - Requests account access
 * - Signs the deterministic key-derivation message
 * - Returns WalletInfo ready for dStorage.connect()
 */
export async function connectMetaMask(): Promise<WalletInfo> {
  if (typeof window === "undefined" || !window.ethereum) {
    throw new Error(
      "[dStorage] MetaMask not detected. Please install MetaMask: https://metamask.io",
    );
  }

  const provider = window.ethereum;

  // Request account access
  const accounts = (await provider.request({
    method: "eth_requestAccounts",
  })) as string[];

  if (!accounts || accounts.length === 0) {
    throw new Error("[dStorage] No accounts returned from MetaMask.");
  }

  const address = accounts[0]!;

  // Sign key-derivation message — this signature is deterministic per wallet
  const signatureHex = (await provider.request({
    method: "personal_sign",
    params: [KEY_DERIVATION_MESSAGE, address],
  })) as string;

  console.log(`[dStorage] MetaMask connected: ${address}`);

  return {
    address,
    chainProvider: "mock", // Will become 'ethereum' in Phase 2
    _signatureHex: signatureHex,
  };
}

/**
 * Connect to the Midnight wallet (Lace with Midnight extension).
 *
 * Implements the DApp Connector v3 flow:
 *   1. Locate the wallet via window.midnight[networkId]
 *   2. Call .enable() → ConnectedAPI
 *   3. Get shielded address via api.getShieldedAddress()
 *   4. Derive the encryption key seed from a PBKDF2 hash of the address
 *      (DApp Connector v3 intentionally omits signData() — signatures are
 *      embedded inside ZK proofs; to preserve the deterministic key-derivation
 *      property we use PBKDF2(address) as the seed instead.)
 *   5. Return WalletInfo with walletApi for MidnightChainAdapter to reuse.
 *
 * @param networkId  Midnight network to connect to. Default: "testnet-02".
 *
 * Docs: https://docs.midnight.network/develop/tutorial/building-a-dapp/connect-wallet
 */
export async function connectMidnightWallet(
  networkId = "testnet-02",
): Promise<WalletInfo> {
  if (typeof window === "undefined" || !window.midnight) {
    throw new Error(
      "[dStorage] Midnight wallet not detected. " +
        "Please install the Lace wallet with Midnight extension.",
    );
  }

  const connector = window.midnight[networkId];
  if (!connector) {
    throw new Error(
      `[dStorage] Midnight wallet does not support network "${networkId}". ` +
        `Available networks: ${Object.keys(window.midnight).join(", ")}`,
    );
  }

  // Request connection — the user will see a confirmation prompt in Lace
  const api = await connector.enable();

  // Retrieve the shielded (Bech32m) address for this network
  const address = await api.getShieldedAddress();

  // Derive a deterministic encryption-key seed from the shielded address.
  //
  // Why not use signData()?
  //   DApp Connector v3 omits signData() by design: on Midnight, all
  //   authentication happens inside ZK proofs (the proof itself is the signature).
  //   Exposing a raw signing oracle would break the security model.
  //
  // Why PBKDF2(address) instead of a random seed?
  //   Key-derivation must be deterministic so the same wallet can always decrypt
  //   its data without storing a secret. PBKDF2 with a fixed salt and the
  //   shielded address as the password gives us that property while adding
  //   computational cost against brute-force.
  const signatureHex = await deriveKeySeedFromAddress(address);

  console.log(
    `[dStorage] Midnight wallet connected: ${address} (network: ${networkId})`,
  );

  return {
    address,
    chainProvider: "midnight",
    _signatureHex: signatureHex,
    walletApi: api,
  };
}

/**
 * Derive a deterministic hex seed from a Midnight shielded address using PBKDF2.
 *
 * This replaces the wallet-signature used by MetaMask-style connectors.
 * The same address always produces the same seed, preserving determinism.
 */
async function deriveKeySeedFromAddress(address: string): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(address),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );

  // Fixed salt — namespaced to dStorage so the same wallet used in other
  // dApps produces a different derived value.
  const salt = enc.encode("dstorage-midnight-key-derivation-v1");

  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 },
    keyMaterial,
    256,
  );

  return Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Demo helper: create a fake wallet connection without a real wallet.
 * Useful for testing and demos in environments without extensions.
 */
export async function connectDemoWallet(
  address = "0xDemoWallet1234",
): Promise<WalletInfo> {
  // Use a deterministic fake signature for demo purposes
  const fakeSignature = `0x${"ab".repeat(32)}${address.replace("0x", "").slice(0, 8)}`;

  console.warn(
    "[dStorage] Demo wallet connected — encryption is real but not wallet-bound. For production, use connectMetaMask() or connectMidnightWallet().",
  );

  return {
    address,
    chainProvider: "mock",
    _signatureHex: fakeSignature,
  };
}
