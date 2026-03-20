/**
 * @dstorage/seed-providers — MetaMaskSeedProvider
 *
 * Derives an encryption seed from a MetaMask (or any EIP-1193 compatible)
 * wallet signature.
 *
 * Flow:
 *   1. Requests account access via eth_requestAccounts.
 *   2. Prompts the user to sign the well-known key-derivation message via personal_sign.
 *   3. Canonicalizes the ECDSA signature to low-s form (EIP-2 / BIP-62).
 *   4. Returns the canonical signature bytes as the seed.
 *
 * The same wallet + account always produces the same signature, giving
 * deterministic, wallet-bound encryption keys without storing any secret.
 *
 * Step 3 ensures cross-wallet determinism: secp256k1 ECDSA signatures are
 * malleable — for any valid (r, s), the pair (r, n−s) is also valid. Different
 * EIP-1193 providers may return either form. By normalizing to low-s before use,
 * any conforming provider produces the same canonical seed for the same key.
 */

import { KEY_DERIVATION_MESSAGE } from "@dstorage/crypto";
import type { EncryptionSeedProvider } from "./types.js";

interface EIP1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export class MetaMaskSeedProvider implements EncryptionSeedProvider {
  async getSeed(): Promise<Uint8Array> {
    if (typeof window === "undefined" || !window.ethereum) {
      throw new Error(
        "[dStorage] MetaMask not detected. Please install MetaMask: https://metamask.io",
      );
    }

    const provider = window.ethereum;

    const accounts = (await provider.request({
      method: "eth_requestAccounts",
    })) as string[];

    if (!accounts || accounts.length === 0) {
      throw new Error("[dStorage] No accounts returned from MetaMask.");
    }

    const address = accounts[0]!;

    const signatureHex = (await provider.request({
      method: "personal_sign",
      params: [KEY_DERIVATION_MESSAGE, address],
    })) as string;

    return canonicalizeEcdsaSignature(hexToBytes(signatureHex));
  }
}

const SECP256K1_N = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141",
);
const SECP256K1_N_HALF = SECP256K1_N >> 1n;

/**
 * Normalize an ECDSA signature to low-s canonical form (EIP-2 / BIP-62).
 * Input must be 65 bytes: r(32) || s(32) || v(1).
 * If s > n/2, replace s with n-s. v is preserved unchanged.
 */
function canonicalizeEcdsaSignature(sig: Uint8Array): Uint8Array {
  // Extract s (bytes 32–63)
  let s = 0n;
  for (let i = 32; i < 64; i++) {
    s = (s << 8n) | BigInt(sig[i]!);
  }

  if (s <= SECP256K1_N_HALF) return sig; // already canonical

  const sLow = SECP256K1_N - s;
  const out = new Uint8Array(sig); // copy r and v unchanged
  // Write low-s back into bytes 32–63 (big-endian)
  let tmp = sLow;
  for (let i = 63; i >= 32; i--) {
    out[i] = Number(tmp & 0xffn);
    tmp >>= 8n;
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
