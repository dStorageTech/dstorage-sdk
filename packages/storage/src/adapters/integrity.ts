import { DStorageError, computeBlake3Hex } from "@dstorage/crypto";
import { StorageErrorCode } from "../errors.js";

export const CONTENT_HASH_TAG = "X-Content-Hash";
export { computeBlake3Hex };

export async function assertContentHash(
  id: string,
  bytes: Uint8Array,
  storedHash: string,
  adapter: string,
): Promise<void> {
  const actual = await computeBlake3Hex(bytes);
  if (actual !== storedHash) {
    throw new DStorageError(
      StorageErrorCode.CONTENT_HASH_MISMATCH,
      `[dStorage/${adapter}] Content hash mismatch for txId: ${id}.\n` +
        "The retrieved data does not match the hash recorded at upload time.\n" +
        "This may indicate data tampering by a malicious gateway.",
    );
  }
}
