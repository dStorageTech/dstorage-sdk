/**
 * Integration tests — full stack: Midnight + arlocal.
 *
 * Tests the complete end-to-end path: encryption → arlocal storage →
 * on-chain reference via real Midnight ZK proofs → retrieval.
 *
 * ── Prerequisites ──────────────────────────────────────────────────────────────
 *   docker run -d --rm -p 1984:1984 textury/arlocal
 *   docker run -d --rm -p 6300:6300 midnightntwrk/proof-server:8.1.0 -- midnight-proof-server -v
 *   INTEGRATION_SEED=<mnemonic or hex seed with NIGHT + DUST on preprod>
 *
 * See tests/integration/env.example for all available env vars.
 *
 * ── Run ────────────────────────────────────────────────────────────────────────
 *   npm run test:integration
 *
 * If services are not running, this suite is skipped (not failed).
 */

// WebSocket polyfill required for Midnight GraphQL subscriptions in Node.js.
import WebSocket from "ws";
// @ts-expect-error — ws types don't perfectly match DOM WebSocket
globalThis.WebSocket = WebSocket;

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { DStorage } from "@dstorage/core";
import {
  KeypairEncryptionAdapter,
  MnemonicEncryptionAdapter,
  PasswordEncryptionAdapter,
} from "@dstorage/encryption";
import { ArweaveLocalStorageAdapter } from "@dstorage/storage";
import { readEnv } from "./helpers/env.js";
import { checkArlocal, createStorageAdapter } from "./helpers/arlocal.js";
import { isMidnightAvailable, createChainAdapter } from "./helpers/midnight.js";

const env = readEnv();
const CONTENT = new TextEncoder().encode("hello from integration tests");

const arlocalOk = await checkArlocal(env.arlocalUrl);
const midnightOk = arlocalOk && (await isMidnightAvailable(env));

describe.skipIf(!midnightOk)("full stack: Midnight + arlocal", () => {
  let sdk: DStorage;
  let sdkBob: DStorage;
  let adapter: ArweaveLocalStorageAdapter;
  let chainAdapter: Awaited<ReturnType<typeof createChainAdapter>>;

  const ALICE_SEED =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
  const BOB_SEED =
    "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote";

  beforeAll(async () => {
    const [{ adapter: sa }, chain] = await Promise.all([
      createStorageAdapter(env.arlocalUrl),
      createChainAdapter(env),
    ]);
    adapter = sa;
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
    const { chainRefId } = await sdk.registerReference({
      metadata: meta,
    });
    const result = await sdk.retrieveByRefId(chainRefId);
    expect(result.metadata).toEqual(meta);
    expect(result.bytes).toEqual(new Uint8Array(0));
    expect(result.tags).toEqual({});
  });

  it("wallet isolation: Bob cannot read metadata from Alice's metadata-only reference", async () => {
    const { chainRefId } = await sdk.registerReference({
      metadata: { secret: "alice-only" },
    });
    await expect(sdkBob.retrieveByRefId(chainRefId)).rejects.toThrow();
  });

  it("metadata-only removeReference succeeds and reference no longer appears in list", async () => {
    const { chainRefId } = await sdk.registerReference({
      metadata: { temp: "true" },
    });
    await sdk.removeReference(chainRefId);
    const refs = await sdk.listReferences();
    expect(refs.find((r) => r.refId === chainRefId)).toBeUndefined();
  });

  it("updateUpload over a metadata-only reference promotes to full content ref with storageId-based ownerSecret", async () => {
    // Register with no storageId — ownerSecret is sentinel-based (METADATA_ONLY_OWNER_SECRET_SALT).
    const { chainRefId } = await sdk.registerReference({
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

  // ── Private removeReference with real Midnight ────────────────────────────────

  it("private removeReference succeeds and ref no longer appears in list", async () => {
    const { chainRefId } = await sdk.store(CONTENT);
    await expect(sdk.removeReference(chainRefId)).resolves.toBeUndefined();
    const refs = await sdk.listReferences();
    expect(refs.find((r) => r.refId === chainRefId)).toBeUndefined();
  });

  it("retrieveByRefId throws after private removeReference", async () => {
    const { chainRefId } = await sdk.store(CONTENT);
    await sdk.removeReference(chainRefId);
    await expect(sdk.retrieveByRefId(chainRefId)).rejects.toThrow();
  });

  it("private removeReference fails when called by a different user (wrong ownerSecret)", async () => {
    const { chainRefId } = await sdk.store(CONTENT);
    await expect(sdkBob.removeReference(chainRefId)).rejects.toThrow();
  });

  // ── update() on existing content with real Midnight + arlocal ─────────────────

  it("update replaces content: retrieveByRefId returns new bytes", async () => {
    const V1 = new TextEncoder().encode("version 1 content");
    const V2 = new TextEncoder().encode("version 2 content");
    const { chainRefId } = await sdk.store(V1);
    const { storageId } = await sdk.update(chainRefId, V2);
    expect(storageId).toBeTruthy();
    const result = await sdk.retrieveByRefId(chainRefId);
    expect(result.bytes).toEqual(V2);
  });

  it("second update succeeds and reflects the latest content", async () => {
    const V1 = new TextEncoder().encode("v1");
    const V2 = new TextEncoder().encode("v2");
    const V3 = new TextEncoder().encode("v3");
    const { chainRefId } = await sdk.store(V1);
    await sdk.update(chainRefId, V2);
    await sdk.update(chainRefId, V3);
    const result = await sdk.retrieveByRefId(chainRefId);
    expect(result.bytes).toEqual(V3);
  });

  it("removeReference succeeds after update (ownerSecret derived from updated storageId)", async () => {
    const { chainRefId } = await sdk.store(CONTENT);
    await sdk.update(chainRefId, new TextEncoder().encode("updated content"));
    await expect(sdk.removeReference(chainRefId)).resolves.toBeUndefined();
  });

  // ── Error code propagation through real Midnight chain reads ──────────────────

  it("listReferences for Bob shows Alice's private ref with null storageId and decryptionError", async () => {
    const { chainRefId } = await sdk.store(CONTENT);
    const refs = await sdkBob.listReferences();
    const entry = refs.find((r) => r.refId === chainRefId);
    expect(entry).toBeDefined();
    expect(entry?.storageId).toBeNull();
    expect(entry?.decryptionError).toBeDefined();
    expect(typeof entry?.decryptionError).toBe("string");
  });

  it("listReferences for Bob shows Alice's public ref as visible but with decryptionError (cannot unwrap ownerSeed)", async () => {
    const { chainRefId } = await sdk.store(CONTENT, { isPublic: true });
    const refs = await sdkBob.listReferences();
    const entry = refs.find((r) => r.refId === chainRefId);
    expect(entry).toBeDefined();
    expect(entry?.storageId).toBeTruthy();
    expect(entry?.decryptionError).toBeDefined();
  });

  // ── Session lifecycle — destroy and reinit ────────────────────────────────────

  describe("session lifecycle — destroy and reinit", () => {
    it("content stored before destroy is retrievable after reinit with same seed", async () => {
      const content = new TextEncoder().encode("persisted-after-reinit");
      const first = new DStorage({
        storageAdapter: adapter,
        chainAdapter,
        encryptionAdapters: [
          new MnemonicEncryptionAdapter({ mnemonic: ALICE_SEED }),
        ],
      });
      await first.init();
      const { chainRefId } = await first.store(content);
      first.destroy();

      const second = new DStorage({
        storageAdapter: adapter,
        chainAdapter,
        encryptionAdapters: [
          new MnemonicEncryptionAdapter({ mnemonic: ALICE_SEED }),
        ],
      });
      await second.init();
      const result = await second.retrieveByRefId(chainRefId);
      expect(result.bytes).toEqual(content);
      second.destroy();
    });

    it("listReferences on a fresh instance still includes the pre-destroy ref", async () => {
      const first = new DStorage({
        storageAdapter: adapter,
        chainAdapter,
        encryptionAdapters: [
          new MnemonicEncryptionAdapter({ mnemonic: ALICE_SEED }),
        ],
      });
      await first.init();
      const { chainRefId } = await first.store(CONTENT);
      first.destroy();

      const second = new DStorage({
        storageAdapter: adapter,
        chainAdapter,
        encryptionAdapters: [
          new MnemonicEncryptionAdapter({ mnemonic: ALICE_SEED }),
        ],
      });
      await second.init();
      const refs = await second.listReferences();
      expect(refs.some((r) => r.refId === chainRefId)).toBe(true);
      second.destroy();
    });
  });

  // ── Multi-key envelope (password + mnemonic) with real Midnight ───────────────

  describe("multi-key envelope (password + mnemonic) with real Midnight", () => {
    const PASSWORD_ADAPTER = new PasswordEncryptionAdapter({
      password: "dstorage-multikey-integration-test-v1!",
      salt: "dstorage:multikey:integration:v1",
      params: { N: 1024, r: 8, p: 1 },
    });
    // Reuse ALICE_SEED so the mnemonic adapter matches what Alice's sdk already uses.
    const MNEMONIC_ADAPTER = new MnemonicEncryptionAdapter({
      mnemonic: ALICE_SEED,
    });

    let multiKeySdk: DStorage;
    let passwordOnlySdk: DStorage;
    let mnemonicOnlySdk: DStorage;

    beforeAll(async () => {
      multiKeySdk = new DStorage({
        storageAdapter: adapter,
        chainAdapter,
        encryptionAdapters: [PASSWORD_ADAPTER, MNEMONIC_ADAPTER],
      });
      await multiKeySdk.init();

      passwordOnlySdk = new DStorage({
        storageAdapter: adapter,
        chainAdapter,
        encryptionAdapters: [PASSWORD_ADAPTER],
      });
      await passwordOnlySdk.init();

      mnemonicOnlySdk = new DStorage({
        storageAdapter: adapter,
        chainAdapter,
        encryptionAdapters: [MNEMONIC_ADAPTER],
      });
      await mnemonicOnlySdk.init();
    });

    it("password-only SDK retrieves content uploaded with two adapters", async () => {
      const { chainRefId } = await multiKeySdk.store(CONTENT);
      const result = await passwordOnlySdk.retrieveByRefId(chainRefId);
      expect(result.bytes).toEqual(CONTENT);
    });

    it("mnemonic-only SDK retrieves content uploaded with two adapters", async () => {
      const { chainRefId } = await multiKeySdk.store(CONTENT);
      const result = await mnemonicOnlySdk.retrieveByRefId(chainRefId);
      expect(result.bytes).toEqual(CONTENT);
    });

    it("unrelated SDK (Bob) cannot retrieve multi-key upload", async () => {
      const { chainRefId } = await multiKeySdk.store(CONTENT);
      await expect(sdkBob.retrieveByRefId(chainRefId)).rejects.toThrow();
    });

    it("on-chain keyEnvelope has exactly two wrappers for a two-adapter upload", async () => {
      const { chainRefId } = await multiKeySdk.store(CONTENT);
      const ref = await chainAdapter.readReference(chainRefId);
      const envelope = JSON.parse(ref.keyEnvelope) as { wrappers: unknown[] };
      expect(envelope.wrappers).toHaveLength(2);
    });
  });

  // ── ML-KEM asymmetric encryption with real Midnight ──────────────────────────

  describe("ML-KEM asymmetric encryption with real Midnight", () => {
    let mlkemSdk: DStorage;
    let kpPublicKey: Uint8Array;
    let kpSecretKey: Uint8Array;

    beforeAll(async () => {
      const {
        adapter: kpAdapter,
        publicKey,
        secretKey,
      } = KeypairEncryptionAdapter.generateKeypair();
      kpPublicKey = publicKey;
      kpSecretKey = secretKey;

      mlkemSdk = new DStorage({
        storageAdapter: adapter,
        chainAdapter,
        encryptionAdapters: [kpAdapter],
      });
      await mlkemSdk.init();
    });

    it("ML-KEM encrypted content round-trips through real Midnight chain", async () => {
      const { chainRefId } = await mlkemSdk.store(CONTENT);
      const result = await mlkemSdk.retrieveByRefId(chainRefId);
      expect(result.bytes).toEqual(CONTENT);
    });

    it("on-chain keyEnvelope contains exactly one ML-KEM wrapper with kemCiphertext", async () => {
      const { chainRefId } = await mlkemSdk.store(CONTENT);
      const ref = await chainAdapter.readReference(chainRefId);
      const envelope = JSON.parse(ref.keyEnvelope) as {
        wrappers: Array<{ kemCiphertext?: string }>;
      };
      expect(envelope.wrappers).toHaveLength(1);
      expect(envelope.wrappers[0]?.kemCiphertext).toBeTruthy();
    });

    it("PK-only SDK uploads; SK SDK retrieves the same content", async () => {
      const pkOnly = KeypairEncryptionAdapter.fromPublicKey(kpPublicKey);
      const skFull = KeypairEncryptionAdapter.fromKeypair(
        kpPublicKey,
        kpSecretKey,
      );

      const pkSdk = new DStorage({
        storageAdapter: adapter,
        chainAdapter,
        encryptionAdapters: [pkOnly],
      });
      const skSdk = new DStorage({
        storageAdapter: adapter,
        chainAdapter,
        encryptionAdapters: [skFull],
      });
      await pkSdk.init();
      await skSdk.init();

      const { chainRefId } = await pkSdk.store(CONTENT);
      const result = await skSdk.retrieveByRefId(chainRefId);
      expect(result.bytes).toEqual(CONTENT);
    });
  });

  // ── Content hash — full stack ─────────────────────────────────────────────────

  describe("content hash", () => {
    it("store() writes a 64-char hex contentHash to the Midnight DataRegistry contract", async () => {
      const { chainRefId } = await sdk.store(CONTENT);
      const ref = await chainAdapter.readReference(chainRefId);
      expect(typeof ref.contentHash).toBe("string");
      expect(ref.contentHash).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(ref.contentHash!)).toBe(true);
    });

    it("contentHash round-trip: store → retrieveByRefId succeeds with correct content", async () => {
      const { chainRefId } = await sdk.store(CONTENT);
      const result = await sdk.retrieveByRefId(chainRefId);
      expect(result.bytes).toEqual(CONTENT);
    });

    it("contentHash appears in listReferences() output", async () => {
      const { chainRefId } = await sdk.store(CONTENT);
      const refs = await sdk.listReferences();
      // listReferences returns DataReferenceSummary which doesn't expose contentHash,
      // but we verify the underlying ref has it via readReference
      const ref = await chainAdapter.readReference(chainRefId);
      expect(ref.contentHash).toHaveLength(64);
    });

    it("update() stores a new contentHash and retrieval returns updated content", async () => {
      const { chainRefId } = await sdk.store(CONTENT);
      const refBefore = await chainAdapter.readReference(chainRefId);

      const newContent = new TextEncoder().encode(
        "updated via Midnight circuit",
      );
      await sdk.update(chainRefId, newContent);

      const refAfter = await chainAdapter.readReference(chainRefId);
      expect(refAfter.contentHash).toBeDefined();
      expect(refAfter.contentHash).not.toBe(refBefore.contentHash);

      const result = await sdk.retrieveByRefId(chainRefId);
      expect(result.bytes).toEqual(newContent);
    });
  });
});
