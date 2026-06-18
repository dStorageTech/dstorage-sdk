/**
 * Integration tests — storage-only mode with real Arweave.
 *
 * Verifies that DStorage without a chain adapter works end-to-end against a
 * real arlocal node: upload → retrieveByStorageId, and that chain-dependent
 * methods throw with helpful messages.
 *
 * ── Prerequisites ──────────────────────────────────────────────────────────────
 *   docker run -d --rm -p 1984:1984 textury/arlocal
 *
 * ── Run ────────────────────────────────────────────────────────────────────────
 *   npm run test:integration
 *
 * If arlocal is not running, this suite is skipped (not failed).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DStorage, CoreErrorCode } from "@dstorage/core";
import { PasswordEncryptionAdapter } from "@dstorage/encryption";
import { readEnv } from "./helpers/env.js";
import { checkArlocal, createStorageAdapter } from "./helpers/arlocal.js";

const env = readEnv();
const CONTENT = new TextEncoder().encode("hello from integration tests");

const arlocalOk = await checkArlocal(env.arlocalUrl);

describe.skipIf(!arlocalOk)("storage-only mode with real Arweave", () => {
  let storageOnlySdk: DStorage;

  beforeAll(async () => {
    const { adapter } = await createStorageAdapter(env.arlocalUrl);
    storageOnlySdk = new DStorage({
      storageAdapter: adapter,
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "dstorage-storageonly-integration-v1!",
          salt: "dstorage:storageonly:integration:v1",
          params: { N: 1024, r: 8, p: 1 },
        }),
      ],
    });
    await storageOnlySdk.init();
  });

  afterAll(() => {
    storageOnlySdk.destroy();
  });

  it("store() returns storageId with no chainRefId or chainProvider", async () => {
    const result = await storageOnlySdk.store(CONTENT);
    expect(result.storageId).toBeTruthy();
    expect(result.chainRefId).toBeUndefined();
    expect(result.chainProvider).toBeUndefined();
  });

  it("private data round-trips via retrieveByStorageId", async () => {
    const { storageId, cryptoScheme } = await storageOnlySdk.store(CONTENT);
    const result = await storageOnlySdk.retrieveByStorageId(
      storageId,
      cryptoScheme!,
    );
    expect(result.bytes).toEqual(CONTENT);
  });

  it("public data round-trips via retrieveByStorageId without a cryptoScheme", async () => {
    const { storageId } = await storageOnlySdk.store(CONTENT, {
      isPublic: true,
    });
    const result = await storageOnlySdk.retrieveByStorageId(storageId);
    expect(result.bytes).toEqual(CONTENT);
  });

  it("retrieveByStorageId returns empty metadata (metadata is chain-only; not stored in the payload)", async () => {
    const { storageId, cryptoScheme } = await storageOnlySdk.store(CONTENT, {
      metadata: { source: "storage-only-integration", version: "1" },
    });
    const result = await storageOnlySdk.retrieveByStorageId(
      storageId,
      cryptoScheme!,
    );
    expect(result.metadata).toEqual({});
  });

  it("user-supplied tags survive retrieval even without a chain adapter", async () => {
    const userTags = { category: "health", version: "v1" };
    const { storageId, cryptoScheme } = await storageOnlySdk.store(CONTENT, {
      tags: userTags,
    });
    const result = await storageOnlySdk.retrieveByStorageId(
      storageId,
      cryptoScheme!,
    );
    expect(result.tags).toMatchObject(userTags);
  });

  it("retrieveByRefId() throws with a helpful message when no chain adapter is configured", async () => {
    await expect(
      storageOnlySdk.retrieveByRefId("any-ref"),
    ).rejects.toMatchObject({
      code: CoreErrorCode.RETRIEVE_BY_REF_ID_REQUIRES_CHAIN,
      message: expect.stringContaining("requires a chain adapter"),
    });
  });

  it("listReferences() throws when no chain adapter is configured", async () => {
    await expect(storageOnlySdk.listReferences()).rejects.toMatchObject({
      code: CoreErrorCode.LIST_REFS_REQUIRES_CHAIN,
    });
  });
});
