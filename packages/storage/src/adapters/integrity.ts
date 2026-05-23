export const CONTENT_HASH_TAG = "X-Content-Hash";

export async function computeBlake3Hex(bytes: Uint8Array): Promise<string> {
  const { blake3 } = await import("@noble/hashes/blake3.js");
  return Array.from(blake3(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function assertContentHash(
  id: string,
  bytes: Uint8Array,
  storedHash: string,
  adapter: string,
): Promise<void> {
  const actual = await computeBlake3Hex(bytes);
  if (actual !== storedHash) {
    throw new Error(
      `[dStorage/${adapter}] Content hash mismatch for txId: ${id}.\n` +
        "The retrieved data does not match the hash recorded at upload time.\n" +
        "This may indicate data tampering by a malicious gateway.",
    );
  }
}
