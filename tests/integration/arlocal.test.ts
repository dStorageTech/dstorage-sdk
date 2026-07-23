/**
 * Integration tests — arlocal only (mock chain).
 *
 * Verifies that upload/retrieve works end-to-end through a real arlocal node
 * before adding the complexity of the Midnight chain adapter.
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
import { MidnightSimulatorChainAdapter } from "@dstorage/chain";
import { PasswordEncryptionAdapter } from "@dstorage/encryption";
import { readEnv } from "./helpers/env.js";
import { checkArlocal, createStorageAdapter } from "./helpers/arlocal.js";

const env = readEnv();
const CONTENT = new TextEncoder().encode("hello from integration tests");

const arlocalOk = await checkArlocal(env.arlocalUrl);

describe.skipIf(!arlocalOk)("arlocal only (mock chain)", () => {
  let sdk: DStorage;
  let mockChain: MidnightSimulatorChainAdapter;

  beforeAll(async () => {
    const { adapter } = await createStorageAdapter(env.arlocalUrl);
    mockChain = new MidnightSimulatorChainAdapter({ logger: console });
    sdk = new DStorage({
      storageAdapter: adapter,
      chainAdapter: mockChain,
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "dstorage-integration-test-v1!",
          salt: "dstorage:integration-test:arlocal",
          params: { N: 32768, r: 8, p: 1 },
        }),
      ],
    });
    await sdk.init();
  });

  it("stores and retrieves private data", async () => {
    const { chainRefId } = await sdk.store(CONTENT);
    const result = await sdk.retrieveByRefId(chainRefId);
    expect(result.bytes).toEqual(CONTENT);
  });

  it("stores and retrieves public data", async () => {
    const { chainRefId } = await sdk.store(CONTENT, { isPublic: true });
    const result = await sdk.retrieveByRefId(chainRefId);
    expect(result.bytes).toEqual(CONTENT);
  });

  it("public store produces a non-empty keyEnvelope with one wrapper per provider", async () => {
    const { chainRefId } = await sdk.store(CONTENT, { isPublic: true });
    const ref = await mockChain.readReference(chainRefId);
    expect(ref.keyEnvelope).toBeTruthy();
    const envelope = JSON.parse(ref.keyEnvelope);
    expect(envelope.v).toBe(1);
    expect(envelope.wrappers).toHaveLength(1);
    expect(envelope.wrappers[0].wrapKeyName).toBe("password");
  });

  it("two stores produce different storage IDs", async () => {
    const a = await sdk.store(CONTENT);
    const b = await sdk.store(CONTENT);
    expect(a.storageId).not.toBe(b.storageId);
  });

  it("listing references returns stored entries", async () => {
    const { chainRefId } = await sdk.store(CONTENT);
    const refs = await sdk.listReferences();
    expect(refs.some((r) => r.refId === chainRefId)).toBe(true);
  });

  it("registers a metadata-only reference and retrieves metadata by refId", async () => {
    const meta = { type: "profile", name: "Alice" };
    const { chainRefId } = await sdk.registerReference({
      metadata: meta,
    });
    const result = await sdk.retrieveByRefId(chainRefId);
    expect(result.metadata).toEqual(meta);
    expect(result.bytes).toEqual(new Uint8Array(0));
    expect(result.tags).toEqual({});
  });

  it("metadata-only reference with no metadata returns empty metadata and empty bytes", async () => {
    const { chainRefId } = await sdk.registerReference();
    const result = await sdk.retrieveByRefId(chainRefId);
    expect(result.metadata).toEqual({});
    expect(result.bytes).toEqual(new Uint8Array(0));
  });

  it("metadata supplied to store() is returned by retrieveByRefId", async () => {
    const meta = { category: "health", version: "2" };
    const { chainRefId } = await sdk.store(CONTENT, { metadata: meta });
    const result = await sdk.retrieveByRefId(chainRefId);
    expect(result.metadata).toEqual(meta);
  });

  it("user-supplied tags survive a real Arweave upload/retrieve round-trip", async () => {
    const userTags = { category: "health", version: "v1" };
    const { chainRefId } = await sdk.store(CONTENT, { tags: userTags });
    const result = await sdk.retrieveByRefId(chainRefId);
    expect(result.tags).toMatchObject(userTags);
    // X-Content-Hash is also present, written by the payment adapter alongside user tags.
    expect(result.tags["X-Content-Hash"]).toBeTruthy();
  });
});
