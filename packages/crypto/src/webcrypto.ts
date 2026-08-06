/**
 * @dstorage/crypto — webcrypto.ts
 *
 * Single access point for the platform WebCrypto object.
 *
 * Every byte of randomness this SDK produces — DEKs, XChaCha20-Poly1305 nonces,
 * ML-KEM keypair seeds — comes from `getCrypto().getRandomValues()`. Routing all
 * of them through one guard means a missing CSPRNG fails loudly with a
 * `[dStorage/crypto]`-prefixed DStorageError rather than a bare TypeError, and
 * gives a single place to audit when reasoning about entropy.
 */

import { DStorageError, CryptoErrorCode } from "./errors.js";

/**
 * Return the platform WebCrypto object, or throw if unavailable.
 *
 * Available in browsers and Node.js 19+ as `globalThis.crypto`. Deliberately has
 * no fallback: degrading to a non-cryptographic RNG would silently produce
 * predictable keys, which is strictly worse than failing to start.
 */
export function getCrypto(): Crypto {
  if (typeof globalThis.crypto !== "undefined") return globalThis.crypto;
  throw new DStorageError(
    CryptoErrorCode.WEBCRYPTO_NOT_AVAILABLE,
    "[dStorage/crypto] WebCrypto not available in this environment.",
  );
}
