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

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import { DStorage, isStorePartialError } from "@dstorage/core";
import type { StoreRecovery } from "@dstorage/core";
import { MockMidnightChainAdapter } from "@dstorage/chain";
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

// ── Suite 2: full stack — Midnight + arlocal ───────────────────────────────────
//
// Tests the complete end-to-end path: encryption → arlocal storage →
// on-chain reference via real Midnight ZK proofs → retrieval.

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

  // ── Item 2: private removeReference with real Midnight ──────────────────────

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

  // ── Item 3: update() on existing content with real Midnight + arlocal ────────

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

  // ── Item 10: error code propagation through real Midnight chain reads ─────────

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

  // ── Item 4: session destroy + reinit with real Midnight ───────────────────────

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

  // ── Item 5: multi-key envelope (password + mnemonic) with real Midnight ────────

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

  // ── Item 6: ML-KEM asymmetric encryption with real Midnight ───────────────────

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
});

// ── Suite 3: StorePartialError recovery — arlocal + mock chain ─────────────────
//
// Verifies that a failed chain write (simulated with a mock spy) produces a
// StorePartialError whose recovery payload can be used with registerReference()
// to create a valid on-chain reference — without re-uploading the content.

describe.skipIf(!arlocalOk)(
  "StorePartialError recovery — arlocal storage + mock chain",
  () => {
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
            password: "dstorage-recovery-integration-test!",
            salt: "dstorage:recovery:integration:v1",
            params: { N: 1024, r: 8, p: 1 },
          }),
        ],
      });
      await sdk.init();
    });

    it("reactive recovery: StorePartialError → registerReference → retrieveByRefId decrypts correctly", async () => {
      vi.spyOn(mockChain, "writeReference").mockRejectedValueOnce(
        new Error("simulated chain outage"),
      );

      const content = new TextEncoder().encode(
        "reactive recovery integration test",
      );
      const err = await sdk.store(content).catch((e: unknown) => e);
      expect(isStorePartialError(err)).toBe(true);

      const { storageId, storageProvider, keyEnvelope } = (
        err as import("@dstorage/core").StorePartialError
      ).recovery;

      const { chainRefId } = await sdk.registerReference({
        storageId,
        storageProvider,
        keyEnvelope,
      });
      const { bytes } = await sdk.retrieveByRefId(chainRefId);
      expect(bytes).toEqual(content);
    });

    it("proactive recovery: onProgress 'stored' event → simulated failure → registerReference → retrieveByRefId", async () => {
      let capturedRecovery: StoreRecovery | undefined;

      vi.spyOn(mockChain, "writeReference").mockRejectedValueOnce(
        new Error("simulated chain outage"),
      );

      const content = new TextEncoder().encode(
        "proactive recovery integration test",
      );
      await sdk
        .store(content, {
          onProgress: (p) => {
            if (p.phase === "stored") capturedRecovery = p.recovery;
          },
        })
        .catch(() => {});

      expect(capturedRecovery).toBeDefined();

      const { chainRefId } = await sdk.registerReference({
        storageId: capturedRecovery!.storageId,
        storageProvider: capturedRecovery!.storageProvider,
        keyEnvelope: capturedRecovery!.keyEnvelope,
      });
      const { bytes } = await sdk.retrieveByRefId(chainRefId);
      expect(bytes).toEqual(content);
    });
  },
);

// ── Suite 4: storage-only mode with real Arweave (item 7) ─────────────────────
//
// Verifies that DStorage without a chain adapter works end-to-end against a
// real arlocal node: upload → retrieveByStorageId, metadata round-trip, and
// that chain-dependent methods throw with helpful messages.

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
    await expect(storageOnlySdk.retrieveByRefId("any-ref")).rejects.toThrow(
      "[dStorage] retrieveByRefId() requires a chain adapter.",
    );
  });

  it("listReferences() throws when no chain adapter is configured", async () => {
    await expect(storageOnlySdk.listReferences()).rejects.toThrow();
  });
});

// ── Suite 6: BLAKE3 content-integrity with real Arweave (item 9) ───────────────
//
// Verifies that the X-Content-Hash BLAKE3 tag is written during upload and
// verified during retrieve against a real arlocal node.

describe.skipIf(!arlocalOk)(
  "BLAKE3 content-integrity with real Arweave",
  () => {
    let storageAdapter: ArweaveLocalStorageAdapter;
    const DATA = new TextEncoder().encode(
      "blake3-integrity-integration-test-data",
    );

    beforeAll(async () => {
      ({ adapter: storageAdapter } = await createStorageAdapter(
        env.arlocalUrl,
      ));
    });

    it("upload and retrieve round-trip succeeds with integrity check enabled (default)", async () => {
      const { id } = await storageAdapter.store(DATA);
      const { bytes } = await storageAdapter.retrieve(id);
      expect(bytes).toEqual(DATA);
    });

    it("X-Content-Hash tag is present on the Arweave transaction", async () => {
      const { id } = await storageAdapter.store(DATA);

      // Fetch the raw transaction from arlocal; tags are base64url-encoded in the Arweave protocol.
      const res = await fetch(`${env.arlocalUrl}/tx/${id}`);
      const tx = (await res.json()) as {
        tags: Array<{ name: string; value: string }>;
      };

      const { blake3 } = await import("@noble/hashes/blake3.js");
      const hashHex = Array.from(blake3(DATA))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      const toB64url = (s: string) =>
        btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

      const expectedName = toB64url("X-Content-Hash");
      const expectedValue = toB64url(hashHex);

      const hashTag = tx.tags.find((t) => t.name === expectedName);
      expect(hashTag).toBeDefined();
      expect(hashTag?.value).toBe(expectedValue);
    });

    it("retrieve with skipIntegrityCheck: true also returns correct bytes on clean data", async () => {
      const { walletKey } =
        await ArweaveLocalStorageAdapter.createWithTestWallet();
      const noCheckAdapter = new ArweaveLocalStorageAdapter({
        walletKey,
        skipIntegrityCheck: true,
      });
      const { id } = await noCheckAdapter.store(DATA);
      const { bytes } = await noCheckAdapter.retrieve(id);
      expect(bytes).toEqual(DATA);
    });
  },
);
