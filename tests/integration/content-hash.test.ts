/**
 * Integration tests — content hash verification (arlocal + mock chain).
 *
 * Verifies that the on-chain BLAKE3 content hash is written correctly on store()
 * and verified on retrieveByRefId() when using a real arlocal storage node.
 *
 * ── Prerequisites ──────────────────────────────────────────────────────────────
 *   docker run -d --rm -p 1984:1984 textury/arlocal
 *
 * ── Run ────────────────────────────────────────────────────────────────────────
 *   npm run test:integration
 *
 * If arlocal is not running, this suite is skipped (not failed).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { DStorage } from "@dstorage/core";
import { MockMidnightChainAdapter } from "@dstorage/chain";
import { computeBlake3Hex } from "@dstorage/crypto";
import { PasswordEncryptionAdapter } from "@dstorage/encryption";
import { readEnv } from "./helpers/env.js";
import { checkArlocal, createStorageAdapter } from "./helpers/arlocal.js";

const env = readEnv();
const CONTENT = new TextEncoder().encode(
  "content-hash integration test payload",
);

const arlocalOk = await checkArlocal(env.arlocalUrl);

describe.skipIf(!arlocalOk)("content hash — arlocal + mock chain", () => {
  let sdk: DStorage;
  let mockChain: MockMidnightChainAdapter;
  let storageAdapter: Awaited<
    ReturnType<typeof createStorageAdapter>
  >["adapter"];

  beforeAll(async () => {
    const { adapter } = await createStorageAdapter(env.arlocalUrl);
    storageAdapter = adapter;
    mockChain = new MockMidnightChainAdapter({ logger: console });
    sdk = new DStorage({
      storageAdapter,
      chainAdapter: mockChain,
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "dstorage-content-hash-test-v1!",
          salt: "dstorage:integration-test:content-hash",
          params: { N: 1024, r: 8, p: 1 },
        }),
      ],
    });
    await sdk.init();
  });

  it("store() writes a 64-char hex contentHash to the chain adapter", async () => {
    const { chainRefId } = await sdk.store(CONTENT);
    const ref = await mockChain.readReference(chainRefId);
    expect(typeof ref.contentHash).toBe("string");
    expect(ref.contentHash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(ref.contentHash!)).toBe(true);
  });

  it("contentHash equals BLAKE3 of the Arweave ciphertext bytes", async () => {
    const { chainRefId, storageId } = await sdk.store(CONTENT);
    const ref = await mockChain.readReference(chainRefId);

    // Retrieve raw ciphertext bytes directly from the storage adapter
    const { bytes: rawBytes } = await storageAdapter.retrieve(storageId);
    const expected = await computeBlake3Hex(rawBytes);

    expect(ref.contentHash).toBe(expected);
  });

  it("contentHash round-trip: store → retrieveByRefId succeeds with correct content", async () => {
    const { chainRefId } = await sdk.store(CONTENT);
    const result = await sdk.retrieveByRefId(chainRefId);
    expect(result.bytes).toEqual(CONTENT);
  });

  it("contentHash is stored for public uploads too", async () => {
    const { chainRefId } = await sdk.store(CONTENT, { isPublic: true });
    const ref = await mockChain.readReference(chainRefId);
    expect(ref.contentHash).toHaveLength(64);
  });

  it("public upload contentHash equals BLAKE3 of the raw plaintext bytes", async () => {
    const { chainRefId, storageId } = await sdk.store(CONTENT, {
      isPublic: true,
    });
    const ref = await mockChain.readReference(chainRefId);
    const { bytes: rawBytes } = await storageAdapter.retrieve(storageId);
    const expected = await computeBlake3Hex(rawBytes);
    expect(ref.contentHash).toBe(expected);
  });

  it("private upload: Arweave X-Content-Hash tag and on-chain contentHash both agree", async () => {
    const { chainRefId } = await sdk.store(CONTENT);
    const ref = await mockChain.readReference(chainRefId);
    const result = await sdk.retrieveByRefId(chainRefId);
    // ArweaveStorageAdapter writes X-Content-Hash = BLAKE3(ciphertext) as a tx tag
    const arweaveHash = result.tags["X-Content-Hash"];
    expect(arweaveHash).toBeTruthy();
    // On-chain contentHash is also BLAKE3(ciphertext) — both must agree
    expect(ref.contentHash).toBe(arweaveHash);
  });

  it("public upload: Arweave X-Content-Hash tag and on-chain contentHash both agree (hash of plaintext)", async () => {
    const { chainRefId } = await sdk.store(CONTENT, { isPublic: true });
    const ref = await mockChain.readReference(chainRefId);
    const result = await sdk.retrieveByRefId(chainRefId);
    // For public uploads the stored bytes are plaintext — both hashes cover the same bytes
    const arweaveHash = result.tags["X-Content-Hash"];
    expect(arweaveHash).toBeTruthy();
    expect(ref.contentHash).toBe(arweaveHash);
  });

  it("update() stores a new contentHash and retrieveByRefId returns updated content", async () => {
    const { chainRefId } = await sdk.store(CONTENT);
    const refBefore = await mockChain.readReference(chainRefId);

    const newContent = new TextEncoder().encode("updated payload");
    await sdk.update(chainRefId, newContent);

    const refAfter = await mockChain.readReference(chainRefId);
    expect(refAfter.contentHash).not.toBe(refBefore.contentHash);

    const result = await sdk.retrieveByRefId(chainRefId);
    expect(result.bytes).toEqual(newContent);
  });

  it("rotateKeys() preserves the contentHash (content not re-uploaded)", async () => {
    const { chainRefId } = await sdk.store(CONTENT);
    const refBefore = await mockChain.readReference(chainRefId);

    await sdk.rotateKeys(chainRefId);

    const refAfter = await mockChain.readReference(chainRefId);
    expect(refAfter.contentHash).toBe(refBefore.contentHash);
  });
});
