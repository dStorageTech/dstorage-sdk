/**
 * @dstorage/crypto — mlkem.ts
 *
 * Post-quantum DEK wrapping via ML-KEM (CRYSTALS-Kyber, NIST FIPS 203).
 *
 * Hybrid encryption pattern:
 *   wrapDek:   ML-KEM encapsulate(PK) → sharedSecret → HKDF → KEK → XChaCha20 wraps DEK
 *   unwrapDek: ML-KEM decapsulate(SK, ct) → sharedSecret → HKDF → KEK → XChaCha20 unwraps DEK
 *
 * This provides post-quantum confidentiality for the DEK:
 *   - Only the holder of the Secret Key can recover the DEK.
 *   - Encapsulation (upload) requires only the Public Key.
 *   - A quantum computer cannot recover sharedSecret from the KEM ciphertext alone.
 *
 * Key sizes (variant mlkem768, NIST recommended):
 *   Public key:  1184 bytes
 *   Secret key:  2400 bytes
 *   Ciphertext:  1088 bytes
 *   Shared secret: 32 bytes
 */

import {
  ml_kem512,
  ml_kem768,
  ml_kem1024,
} from "@noble/post-quantum/ml-kem.js";
import {
  bytesToBase64url,
  base64urlToBytes,
  type WrappedDekResult,
} from "./types.js";
import { wrapKey, unwrapKey } from "./keyEnvelope.js";
import { DStorageError, CryptoErrorCode } from "./errors.js";

export type MLKemVariant = "mlkem512" | "mlkem768" | "mlkem1024";

const DEFAULT_VARIANT: MLKemVariant = "mlkem768";

const MLKEM_ALGO_SUFFIX = "-xchacha20poly1305-v1";

function parseVariantFromAlgorithm(algorithm: string): MLKemVariant {
  if (!algorithm.endsWith(MLKEM_ALGO_SUFFIX)) {
    throw new DStorageError(
      CryptoErrorCode.MLKEM_UNKNOWN_ALGORITHM,
      `[dStorage] mlkemUnwrapDek: unrecognised algorithm "${algorithm}". ` +
        `Expected format: "<variant>-xchacha20poly1305-v1".`,
    );
  }
  const prefix = algorithm.slice(0, -MLKEM_ALGO_SUFFIX.length) as MLKemVariant;
  if (
    prefix !== "mlkem512" &&
    prefix !== "mlkem768" &&
    prefix !== "mlkem1024"
  ) {
    throw new DStorageError(
      CryptoErrorCode.MLKEM_UNKNOWN_VARIANT,
      `[dStorage] mlkemUnwrapDek: unknown ML-KEM variant "${prefix}" in algorithm "${algorithm}".`,
    );
  }
  return prefix;
}

function getImpl(variant: MLKemVariant = DEFAULT_VARIANT) {
  if (variant === "mlkem512") return ml_kem512;
  if (variant === "mlkem1024") return ml_kem1024;
  return ml_kem768;
}

// Derive a 32-byte KEK from the ML-KEM shared secret using HKDF-SHA-256.
// Uses ML-KEM-specific salt and a context-bound info string to domain-separate
// from all other keys and bind to a specific deployment or account.
async function deriveKekFromSharedSecret(
  sharedSecret: Uint8Array,
  context: string,
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    "raw",
    Uint8Array.from(sharedSecret),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode("dstorage-mlkem-v1"),
      info: enc.encode(`dstorage:mlkem:kek:v1:${context}`),
    },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Generate a random ML-KEM keypair.
 *
 * @param variant  ML-KEM variant. Default: "mlkem768" (NIST recommended, 192-bit security).
 */
export function mlkemGenerateKeypair(variant: MLKemVariant = DEFAULT_VARIANT): {
  pk: Uint8Array;
  sk: Uint8Array;
} {
  const { publicKey, secretKey } = getImpl(variant).keygen();
  return { pk: publicKey, sk: secretKey };
}

/**
 * Generate a deterministic ML-KEM keypair from a 64-byte seed (d‖z, per FIPS 203).
 * The same seed always produces the same keypair.
 *
 * Requires exactly 64 bytes — derive via Web Crypto HKDF deriveBits (512 bits) before calling.
 *
 * @param seed64   64-byte seed material
 * @param variant  ML-KEM variant. Default: "mlkem768".
 */
export function mlkemGenerateKeypairFromSeed(
  seed64: Uint8Array,
  variant: MLKemVariant = DEFAULT_VARIANT,
): { pk: Uint8Array; sk: Uint8Array } {
  if (seed64.length !== 64) {
    throw new DStorageError(
      CryptoErrorCode.MLKEM_SEED_INVALID_LENGTH,
      `[dStorage] mlkemGenerateKeypairFromSeed: expected 64-byte seed, got ${seed64.length} bytes.`,
    );
  }
  const { publicKey, secretKey } = getImpl(variant).keygen(seed64);
  return { pk: publicKey, sk: secretKey };
}

/**
 * Wrap a DEK under a ML-KEM public key.
 *
 * Encapsulates a shared secret, derives a KEK from it via HKDF, then wraps
 * the DEK with the same XChaCha20-Poly1305 scheme used by symmetric providers.
 * The KEM ciphertext is stored alongside the wrapped DEK so the holder of the
 * secret key can reverse the process at retrieval time.
 *
 * @param dek      32-byte Data Encryption Key to protect
 * @param pk       ML-KEM public key
 * @param variant  ML-KEM variant. Default: "mlkem768".
 */
export async function mlkemWrapDek(
  dek: Uint8Array,
  pk: Uint8Array,
  context: string,
  variant: MLKemVariant = DEFAULT_VARIANT,
): Promise<WrappedDekResult> {
  const { cipherText, sharedSecret } = getImpl(variant).encapsulate(pk);
  const kek = await deriveKekFromSharedSecret(sharedSecret, context);
  const wrappedDek = await wrapKey(dek, kek);
  return {
    algorithm: `${variant}-xchacha20poly1305-v1`,
    kekDerivation: "mlkem-hkdf-sha256-v1",
    wrappedDek,
    kemCiphertext: bytesToBase64url(cipherText),
  };
}

/**
 * Unwrap a DEK from a ML-KEM wrapped DEK result.
 *
 * The ML-KEM variant is read from `data.algorithm` (e.g. "mlkem768-xchacha20poly1305-v1"),
 * so the caller does not need to supply it — the key envelope is self-describing.
 *
 * @param data  WrappedDekResult containing algorithm, kemCiphertext, and wrappedDek
 * @param sk    ML-KEM secret key
 */
export async function mlkemUnwrapDek(
  data: WrappedDekResult,
  sk: Uint8Array,
  context: string,
): Promise<Uint8Array> {
  if (!data.kemCiphertext) {
    throw new DStorageError(
      CryptoErrorCode.MLKEM_MISSING_CIPHERTEXT,
      "[dStorage] mlkemUnwrapDek: kemCiphertext is missing from the wrapper — cannot decapsulate.",
    );
  }
  const variant = parseVariantFromAlgorithm(data.algorithm);
  const cipherText = base64urlToBytes(data.kemCiphertext);
  const sharedSecret = getImpl(variant).decapsulate(cipherText, sk);
  const kek = await deriveKekFromSharedSecret(sharedSecret, context);
  return unwrapKey(data.wrappedDek, kek);
}
