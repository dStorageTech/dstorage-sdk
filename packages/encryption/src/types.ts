/**
 * @dstorage/encryption — types.ts
 *
 * The EncryptionAdapter interface: the unified abstraction for how the
 * dStorage SDK wraps and unwraps per-upload Data Encryption Keys (DEKs).
 *
 * Both symmetric (password, mnemonic) and asymmetric (ML-KEM) adapters implement
 * this interface, so the core SDK calls wrapDek/unwrapDek uniformly with no
 * knowledge of which algorithm is in use.
 *
 * The result of wrapDek() is stored as a KeyWrapper entry in the on-chain
 * KeyEnvelope. At retrieval time, the same result is passed back to unwrapDek()
 * to recover the DEK.
 */

import type { WrappedDekResult } from "@dstorage/crypto";

export type { WrappedDekResult };

/**
 * Wraps and unwraps per-upload DEKs using adapter-specific key material.
 *
 * Implementations:
 *   PasswordEncryptionAdapter  — symmetric: scrypt → HKDF → KEK → XChaCha20
 *   MnemonicEncryptionAdapter  — symmetric: BIP-39 seed → HKDF → KEK → XChaCha20
 *   KeypairEncryptionAdapter    — asymmetric: ML-KEM encapsulate/decapsulate + HKDF + XChaCha20
 */
export interface EncryptionAdapter {
  /** Stable identifier used as wrapKeyName in key envelopes. */
  readonly name: string;

  /**
   * Wrap a DEK under this adapter's key material.
   * Called once per upload, per adapter.
   *
   * @param dek  32-byte Data Encryption Key to protect
   * @returns    WrappedDekResult to store in the on-chain key envelope
   */
  wrapDek(dek: Uint8Array): Promise<WrappedDekResult>;

  /**
   * Unwrap a DEK from a previously wrapped result.
   * Called at retrieval time using the same result that wrapDek() returned.
   *
   * @param data  WrappedDekResult from the on-chain key envelope
   * @returns     32-byte Data Encryption Key
   * @throws      If the adapter's key material cannot decrypt the wrapped DEK
   */
  unwrapDek(data: WrappedDekResult): Promise<Uint8Array>;

  /**
   * Zero any raw key bytes held by this adapter and mark it unusable.
   * Optional — only adapters holding raw byte arrays implement this.
   * Call after the adapter is no longer needed to minimise the window
   * during which secret key material sits in GC-reachable memory.
   */
  destroy?(): void;
}
