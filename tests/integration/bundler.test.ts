/**
 * Integration tests — Arweave Bundler adapter (mock chain), fully local/offline.
 *
 * Verifies that upload/retrieve works end-to-end through the Arweave Bundler
 * adapter, using a local mock signing/bundler server that relays uploads into
 * real arlocal L1 transactions; retrieval also goes through arlocal directly.
 * No real network, external services, or funds are involved.
 *
 * ── Prerequisites ──────────────────────────────────────────────────────────────
 *   docker compose -f tools/compose-undeployed.yml up -d --wait   (arlocal)
 *   npm run bundler-mock:run                                       (separate terminal;
 *                                                                    copy the printed auth
 *                                                                    token into .env.integration)
 *
 * ── Run ────────────────────────────────────────────────────────────────────────
 *   npm run test:integration -- -t "arweave bundler"
 *
 * If arlocal or the bundler mock server is not running, this suite is
 * skipped (not failed).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { DStorage } from "@dstorage/core";
import { MidnightSimulatorChainAdapter } from "@dstorage/chain";
import { PasswordEncryptionAdapter } from "@dstorage/encryption";
import { readEnv } from "./helpers/env.js";
import {
  isBundlerAvailable,
  createBundlerAdapter,
  retryUntilAvailable,
} from "./helpers/bundler.js";

const env = readEnv();
const CONTENT = new TextEncoder().encode(
  "hello from bundler integration tests",
);

const bundlerOk = await isBundlerAvailable(env);

describe.skipIf(!bundlerOk)("arweave bundler (mock chain)", () => {
  let sdk: DStorage;
  let mockChain: MidnightSimulatorChainAdapter;

  beforeAll(async () => {
    const adapter = createBundlerAdapter(env);
    mockChain = new MidnightSimulatorChainAdapter({ logger: console });
    sdk = new DStorage({
      storageAdapters: [adapter],
      chainAdapters: [mockChain],
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "dstorage-bundler-integration-test-v1!",
          salt: "dstorage:integration-test:bundler",
          params: { N: 32768, r: 8, p: 1 },
        }),
      ],
    });
    await sdk.init();
  });

  it("stores and retrieves private data", async () => {
    const { chainRefId } = await sdk.store(CONTENT);
    const result = await retryUntilAvailable(() =>
      sdk.retrieveByRefId(chainRefId),
    );
    expect(result.bytes).toEqual(CONTENT);
  });

  it("stores and retrieves public data", async () => {
    const { chainRefId } = await sdk.store(CONTENT, { isPublic: true });
    const result = await retryUntilAvailable(() =>
      sdk.retrieveByRefId(chainRefId),
    );
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
    const result = await retryUntilAvailable(() =>
      sdk.retrieveByRefId(chainRefId),
    );
    expect(result.metadata).toEqual(meta);
  });

  it("user-supplied tags survive a real Arweave upload/retrieve round-trip", async () => {
    const userTags = { category: "health", version: "v1" };
    const { chainRefId } = await sdk.store(CONTENT, { tags: userTags });
    const result = await retryUntilAvailable(() =>
      sdk.retrieveByRefId(chainRefId),
    );
    expect(result.tags).toMatchObject(userTags);
    expect(result.tags["X-Content-Hash"]).toBeTruthy();
  });
});
