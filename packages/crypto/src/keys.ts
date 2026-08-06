/**
 * @dstorage/crypto — keys.ts
 * Provides seed-based key derivation utilities:
 *
 * - KeyDeriver: resolves a BIP-39 mnemonic or raw hex seed to raw bytes,
 *   importing seed bytes as a CryptoKey for use with deriveKek() (keyEnvelope.ts).
 * - hexToBytes: parses a hex string into a Uint8Array.
 */

import { wordlist } from "@scure/bip39/wordlists/english.js";
import { validateMnemonic } from "@scure/bip39";
import { DStorageError, CryptoErrorCode } from "./errors.js";

// BIP-39: PBKDF2-HMAC-SHA512, 2048 iterations, 64-byte output.
// Uses Web Crypto API — no @noble/hashes dep required.
async function mnemonicToSeed(mnemonic: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    enc.encode(mnemonic.normalize("NFKD")),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-512",
      salt: enc.encode("mnemonic".normalize("NFKD")),
      iterations: 2048,
    },
    key,
    512,
  );
  return new Uint8Array(bits);
}

// ── KeyDeriver ────────────────────────────────────────────────────────────────

/**
 * Resolves a BIP-39 mnemonic or raw hex seed to raw bytes.
 * Implements EncryptionAdapter — pass an instance to DStorage config.
 */
export class KeyDeriver {
  private readonly input: { mnemonic?: string; seedHex?: string };

  constructor(input: { mnemonic?: string; seedHex?: string }) {
    if (!input.mnemonic && !input.seedHex) {
      throw new DStorageError(
        CryptoErrorCode.MISSING_KEY_INPUT,
        "[dStorage/crypto] Either mnemonic or seedHex must be provided.",
      );
    }
    if (input.mnemonic !== undefined) {
      const wordCount = input.mnemonic.trim().split(/\s+/).length;
      if (wordCount < 24) {
        throw new DStorageError(
          CryptoErrorCode.MNEMONIC_TOO_SHORT,
          `[dStorage/crypto] A 24-word BIP-39 mnemonic is required (got ${wordCount} words). ` +
            `Shorter mnemonics provide insufficient entropy for post-quantum-safe key derivation.`,
        );
      }
    }
    this.input = input;
  }

  /**
   * Return the raw seed bytes.
   * Import the result as a non-extractable HKDF CryptoKey before passing to deriveKek().
   */
  async getSeed(): Promise<Uint8Array> {
    return this.getSeedBuffer();
  }

  /** Resolves and validates the seed as a Buffer. */
  private async getSeedBuffer(): Promise<Uint8Array> {
    if (this.input.seedHex) {
      const bytes = hexToBytes(this.input.seedHex, "seedHex");
      if (bytes.length !== 32 && bytes.length !== 64) {
        throw new DStorageError(
          CryptoErrorCode.SEED_INVALID_LENGTH,
          "[dStorage/crypto] seedHex must be 32 bytes (64 hex chars) or 64 bytes (128 hex chars).",
        );
      }
      assertSeedNotDegenerate(bytes);
      return bytes;
    }

    // mnemonic path — validate (word membership + BIP-39 checksum) then convert.
    // A single-word typo that still lands on a valid wordlist word would otherwise
    // be silently accepted and derive a different seed — validateMnemonic() rejects
    // it via the checksum bits encoded in the phrase.
    if (!validateMnemonic(this.input.mnemonic!, wordlist)) {
      throw new DStorageError(
        CryptoErrorCode.MNEMONIC_INVALID,
        "[dStorage/crypto] Invalid BIP-39 mnemonic phrase. Unrecognized word or failed checksum.",
      );
    }
    return mnemonicToSeed(this.input.mnemonic!);
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

/**
 * Reject structurally degenerate seeds — every byte identical, which covers
 * all-zeros, all-0xff, and placeholder values pasted from documentation.
 *
 * The mnemonic path is already protected by the BIP-39 checksum, which a
 * degenerate phrase cannot satisfy. The raw-hex path has no such guard, so a
 * caller can otherwise hand over a seed with no entropy at all and derive a
 * valid, fully reproducible keyspace without any error.
 *
 * Deliberately narrow. A statistical randomness test is not attempted: it would
 * falsely reject legitimate seeds and still could not tell a weak generator from
 * a strong one. This catches the values a human types by hand, not weak entropy
 * in general — seed quality remains the caller's responsibility.
 */
function assertSeedNotDegenerate(bytes: Uint8Array): void {
  const first = bytes[0]!;
  if (bytes.every((b) => b === first)) {
    throw new DStorageError(
      CryptoErrorCode.SEED_LOW_ENTROPY,
      `[dStorage/crypto] seedHex has no entropy — all ${bytes.length} bytes are identical. ` +
        `Generate a real seed with \`openssl rand -hex 32\` or supply a 24-word BIP-39 mnemonic.`,
    );
  }
}

export function hexToBytes(
  hex: string,
  label = "hex string",
): Uint8Array<ArrayBuffer> {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new DStorageError(
      CryptoErrorCode.HEX_ODD_LENGTH,
      `[dStorage/crypto] ${label} has odd length (${clean.length} chars) — each byte requires exactly 2 hex characters.`,
    );
  }
  if (!/^[0-9a-fA-F]*$/.test(clean)) {
    throw new DStorageError(
      CryptoErrorCode.HEX_INVALID_CHARS,
      `[dStorage/crypto] ${label} contains non-hexadecimal characters. Only 0-9 and a-f are valid.`,
    );
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
