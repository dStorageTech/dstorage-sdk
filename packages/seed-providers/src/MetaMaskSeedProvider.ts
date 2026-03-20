/**
 * @dstorage/seed-providers — MetaMaskSeedProvider
 *
 * Derives an encryption seed from a MetaMask (or any EIP-1193 compatible)
 * wallet signature.
 *
 * Flow:
 *   1. Requests account access via eth_requestAccounts.
 *   2. Prompts the user to sign the well-known key-derivation message via personal_sign.
 *   3. Returns the raw signature bytes as the seed.
 *
 * The same wallet + account always produces the same signature, giving
 * deterministic, wallet-bound encryption keys without storing any secret.
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

    return hexToBytes(signatureHex);
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
