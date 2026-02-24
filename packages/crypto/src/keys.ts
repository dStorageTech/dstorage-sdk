/**
 * @dstorage/crypto — keys.ts
 * Derives a deterministic AES-GCM encryption key from a wallet signature.
 *
 * Flow:
 *   1. dApp asks wallet to sign a well-known message.
 *   2. The signature (unique per wallet address) is used as PBKDF2 input.
 *   3. PBKDF2 outputs a 256-bit AES-GCM key.
 *
 * The same wallet always produces the same key — no server involved.
 */

/** The message signed by the wallet to derive the encryption key. */
export const KEY_DERIVATION_MESSAGE =
  'dStorage key derivation v1\n\nThis signature derives your encryption key. Never share it.';

function getCrypto(): Crypto {
  if (typeof globalThis.crypto !== 'undefined') return globalThis.crypto;
  throw new Error('[dStorage/crypto] WebCrypto not available in this environment.');
}

/**
 * Derive a deterministic AES-GCM CryptoKey from a hex-encoded wallet signature.
 *
 * @param signatureHex  Raw hex string returned by the wallet (e.g. eth_sign)
 * @param salt          Optional extra salt — use the wallet address for extra binding
 */
export async function deriveKeyFromSignature(
  signatureHex: string,
  salt = 'dstorage-v1'
): Promise<CryptoKey> {
  const crypto = getCrypto();

  // Convert hex signature → raw bytes
  const sigBytes = hexToBytes(signatureHex);

  // Import raw bytes as PBKDF2 key material
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    sigBytes,
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  // Derive a 256-bit AES-GCM key
  const saltBytes = new TextEncoder().encode(salt);

  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: 100_000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false, // not extractable — key never leaves the browser
    ['encrypt', 'decrypt']
  );

  return key;
}

// ── Utilities ────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
