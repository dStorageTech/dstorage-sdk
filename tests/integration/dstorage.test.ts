/**
 * Integration tests for dStorage with real network adapters.
 *
 * ── Prerequisites ──────────────────────────────────────────────────────────────
 *
 * "arlocal only" suite:
 *   docker run -d --rm -p 1984:1984 textury/arlocal
 *
 * "full stack" suite (additionally):
 *   docker run -d --rm -p 6300:6300 midnightntwrk/proof-server:8.0.3 -- midnight-proof-server -v
 *   INTEGRATION_SEED=<mnemonic or hex seed with NIGHT + DUST on preprod>
 *
 * See tests/integration/env.example for all available env vars.
 *
 * ── Run ────────────────────────────────────────────────────────────────────────
 *   npm run test:integration
 *
 * If services are not running, the affected suite is skipped (not failed).
 */

// WebSocket polyfill required for Midnight GraphQL subscriptions in Node.js.
import WebSocket from "ws";
// @ts-expect-error — ws types don't perfectly match DOM WebSocket
globalThis.WebSocket = WebSocket;

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { DStorage } from "@dstorage/core";
import { MockMidnightChainAdapter } from "@dstorage/chain";
import {
  MnemonicEncryptionAdapter,
  PasswordEncryptionAdapter,
} from "@dstorage/encryption";
import { readEnv } from "./helpers/env.js";
import { checkArlocal, createStorageAdapter } from "./helpers/arlocal.js";
import { isMidnightAvailable, createChainAdapter } from "./helpers/midnight.js";

const env = readEnv();
const CONTENT = new TextEncoder().encode("hello from integration tests");

// Availability checks run once at module load (top-level await in ESM).
const arlocalOk = await checkArlocal(env.arlocalUrl);
const midnightOk = arlocalOk && (await isMidnightAvailable(env));

// ── Suite 1: arlocal only (no Midnight) ────────────────────────────────────────
//
// Verifies that upload/retrieve works end-to-end through a real arlocal node
// before adding the complexity of the Midnight chain adapter.

describe.skipIf(!arlocalOk)("arlocal only (mock chain)", () => {
  let sdk: DStorage;
  let mockChain: MockMidnightChainAdapter;

  beforeAll(async () => {
    const { adapter } = await createStorageAdapter(env.arlocalUrl);
    mockChain = new MockMidnightChainAdapter({ logger: console });
    sdk = new DStorage({
      storageAdapter: adapter,
      chainAdapter: mockChain,
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "dstorage-integration-test-v1!",
          salt: "dstorage:integration-test:arlocal",
          params: { N: 1024, r: 8, p: 1 },
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
    const { chainRefId } = await sdk.registerReference(undefined, {
      metadata: meta,
    });
    const result = await sdk.retrieveByRefId(chainRefId);
    expect(result.metadata).toEqual(meta);
    expect(result.bytes).toEqual(new Uint8Array(0));
    expect(result.tags).toEqual({});
  });

  it("metadata-only reference with no metadata returns empty metadata and empty bytes", async () => {
    const { chainRefId } = await sdk.registerReference(undefined);
    const result = await sdk.retrieveByRefId(chainRefId);
    expect(result.metadata).toEqual({});
    expect(result.bytes).toEqual(new Uint8Array(0));
  });
});

// ── Suite 2: full stack — Midnight + arlocal ───────────────────────────────────
//
// Tests the complete end-to-end path: encryption → arlocal storage →
// on-chain reference via real Midnight ZK proofs → retrieval.

describe.skipIf(!midnightOk)("full stack: Midnight + arlocal", () => {
  let sdk: DStorage;
  let sdkBob: DStorage;
  let chainAdapter: Awaited<ReturnType<typeof createChainAdapter>>;

  const ALICE_SEED =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
  const BOB_SEED =
    "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote";

  beforeAll(async () => {
    const [{ adapter }, chain] = await Promise.all([
      createStorageAdapter(env.arlocalUrl),
      createChainAdapter(env),
    ]);
    chainAdapter = chain;

    // Both Alice and Bob share the same chain adapter and storage adapter.
    // Isolation under test is purely cryptographic — different encryptionSeedProvider
    // means different keys and therefore different ability to decrypt each other's data.
    sdk = new DStorage({
      storageAdapter: adapter,
      chainAdapter,
      encryptionAdapters: [
        new MnemonicEncryptionAdapter({
          mnemonic: ALICE_SEED,
        }),
      ],
    });
    const dataRegistryAddress = await sdk.init();

    // If no contract address was pre-configured, a new contract was deployed.
    // Print it prominently so the user can persist it in .env.integration.
    if (!env.midnight.contractAddress && dataRegistryAddress) {
      const title = `  NEW CONTRACT DEPLOYED — add to .env.integration to reuse it:`;
      const addrLine = `  INTEGRATION_CONTRACT_ADDRESS=${dataRegistryAddress}`;
      const innerWidth = Math.max(title.length, addrLine.length) + 2;
      const border = "═".repeat(innerWidth);
      const pad = (s: string) => `║${s.padEnd(innerWidth)}║`;
      console.log(`\n\x1b[33m╔${border}╗`);
      console.log(pad(title));
      console.log(pad(""));
      console.log(pad(addrLine));
      console.log(pad(""));
      console.log(`╚${border}╝\x1b[0m\n`);
    }

    sdkBob = new DStorage({
      storageAdapter: adapter,
      chainAdapter,
      encryptionAdapters: [
        new MnemonicEncryptionAdapter({ mnemonic: BOB_SEED }),
      ],
    });
    // chainAdapter.init() is a no-op on the second call (cached API); only sets up Bob's crypto.
    await sdkBob.init();
  });

  afterEach(async () => {
    // Allow the wallet time to sync DUST regeneration between transactions.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  });

  afterAll(async () => {
    await chainAdapter?.stop?.();
  });

  it("stores private data and retrieves it", async () => {
    const { chainRefId } = await sdk.store(CONTENT);
    const result = await sdk.retrieveByRefId(chainRefId);
    expect(result.bytes).toEqual(CONTENT);
  });

  it("stores public data and retrieves it", async () => {
    const { chainRefId } = await sdk.store(CONTENT, { isPublic: true });
    const result = await sdk.retrieveByRefId(chainRefId);
    expect(result.bytes).toEqual(CONTENT);
  });

  it("two stores from the same wallet produce different DEKs", async () => {
    const a = await sdk.store(CONTENT);
    const b = await sdk.store(CONTENT);
    // Different storageIds confirm different DEKs were used.
    expect(a.storageId).not.toBe(b.storageId);
  });

  it("listing references includes the stored entry", async () => {
    const { chainRefId } = await sdk.store(CONTENT);
    const refs = await sdk.listReferences();
    expect(refs.some((r) => r.refId === chainRefId)).toBe(true);
  });

  it("wallet isolation: Bob cannot decrypt Alice's private reference", async () => {
    const { chainRefId } = await sdk.store(CONTENT);
    await expect(sdkBob.retrieveByRefId(chainRefId)).rejects.toThrow();
  });

  it("public removeReference succeeds when called by the storer", async () => {
    const { chainRefId } = await sdk.store(CONTENT, { isPublic: true });
    await expect(sdk.removeReference(chainRefId)).resolves.toBeUndefined();
    const refs = await sdk.listReferences();
    expect(refs.find((r) => r.refId === chainRefId)).toBeUndefined();
  });

  it("public removeReference fails when called by a different user (wrong ownerSecret)", async () => {
    // Alice uploads a public reference — ownerSeed is wrapped under Alice's KEK only.
    // Bob's KEK cannot unwrap it, so the ownerSecret Bob derives will not match the
    // ownerCommitment stored on-chain, and the ZK circuit must reject the transaction.
    const { chainRefId } = await sdk.store(CONTENT, { isPublic: true });
    await expect(sdkBob.removeReference(chainRefId)).rejects.toThrow();
  });

  it("registers a metadata-only reference and retrieves metadata by refId", async () => {
    const meta = { type: "profile", name: "Alice" };
    const { chainRefId } = await sdk.registerReference(undefined, {
      metadata: meta,
    });
    const result = await sdk.retrieveByRefId(chainRefId);
    expect(result.metadata).toEqual(meta);
    expect(result.bytes).toEqual(new Uint8Array(0));
    expect(result.tags).toEqual({});
  });

  it("wallet isolation: Bob cannot read metadata from Alice's metadata-only reference", async () => {
    const { chainRefId } = await sdk.registerReference(undefined, {
      metadata: { secret: "alice-only" },
    });
    await expect(sdkBob.retrieveByRefId(chainRefId)).rejects.toThrow();
  });

  it("metadata-only removeReference succeeds and reference no longer appears in list", async () => {
    const { chainRefId } = await sdk.registerReference(undefined, {
      metadata: { temp: "true" },
    });
    await sdk.removeReference(chainRefId);
    const refs = await sdk.listReferences();
    expect(refs.find((r) => r.refId === chainRefId)).toBeUndefined();
  });

  it("updateUpload over a metadata-only reference promotes to full content ref with storageId-based ownerSecret", async () => {
    // Register with no storageId — ownerSecret is sentinel-based (METADATA_ONLY_OWNER_SECRET_SALT).
    const { chainRefId } = await sdk.registerReference(undefined, {
      metadata: { version: "1" },
    });

    // updateUpload must pass the current sentinel-derived ownerSecret to the ZK circuit,
    // then commit a new ownerSecret derived from the fresh storageId.
    const UPDATED = new TextEncoder().encode("promoted content");
    const { storageId } = await sdk.update(chainRefId, UPDATED, {
      metadata: { version: "2" },
    });
    expect(storageId).toBeTruthy();

    // Both content and metadata must reflect the update.
    const result = await sdk.retrieveByRefId(chainRefId);
    expect(result.bytes).toEqual(UPDATED);
    expect(result.metadata).toEqual({ version: "2" });

    // removeReference must succeed — proves the new storageId-based ownerSecret was
    // correctly committed by updateUpload and matches what _computeOwnerSecret re-derives.
    await expect(sdk.removeReference(chainRefId)).resolves.toBeUndefined();
  });
});
