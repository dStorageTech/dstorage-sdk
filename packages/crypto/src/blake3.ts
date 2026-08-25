import { blake3 } from "@noble/hashes/blake3.js";

/** BLAKE3 hash of `bytes`, returned as a raw 32-byte Uint8Array. */
export async function computeBlake3(bytes: Uint8Array): Promise<Uint8Array> {
  return blake3(bytes);
}

/** BLAKE3 hash of `bytes`, returned as a 64-character lowercase hex string. */
export async function computeBlake3Hex(bytes: Uint8Array): Promise<string> {
  return Array.from(blake3(bytes), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
}
