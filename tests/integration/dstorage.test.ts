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
  MnemonicSeedProvider,
  PasswordSeedProvider,
} from "@dstorage/seed-providers";
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
      encryptionSeedProviders: [
        new PasswordSeedProvider({
          password: "dstorage-integration-test-v1!",
          salt: "dstorage:integration-test:arlocal",
          params: { N: 1024, r: 8, p: 1 },
        }),
      ],
    });
    await sdk.init();
  });

  it("uploads and retrieves private data", async () => {
    const { chainRefId } = await sdk.upload(CONTENT);
    const result = await sdk.retrieveByRefId(chainRefId);
    expect(result.bytes).toEqual(CONTENT);
  });

  it("uploads and retrieves public data", async () => {
    const { chainRefId } = await sdk.upload(CONTENT, { isPublic: true });
    const result = await sdk.retrieveByRefId(chainRefId);
    expect(result.bytes).toEqual(CONTENT);
  });

  it("public upload produces a non-empty keyEnvelope with one wrapper per provider", async () => {
    const { chainRefId } = await sdk.upload(CONTENT, { isPublic: true });
    const ref = await mockChain.readReference(chainRefId);
    expect(ref.keyEnvelope).toBeTruthy();
    const envelope = JSON.parse(ref.keyEnvelope);
    expect(envelope.v).toBe(1);
    expect(envelope.wrappers).toHaveLength(1);
    expect(envelope.wrappers[0].wrapKeyName).toBe("password");
  });

  it("two uploads produce different storage IDs", async () => {
    const a = await sdk.upload(CONTENT);
    const b = await sdk.upload(CONTENT);
    expect(a.storageId).not.toBe(b.storageId);
  });

  it("listing references returns uploaded entries", async () => {
    const { chainRefId } = await sdk.upload(CONTENT);
    const refs = await sdk.listReferences();
    expect(refs.some((r) => r.refId === chainRefId)).toBe(true);
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
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const BOB_SEED = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";

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
      encryptionSeedProviders: [
        new MnemonicSeedProvider({
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
      encryptionSeedProviders: [
        new MnemonicSeedProvider({ mnemonic: BOB_SEED }),
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

  it("uploads private data and retrieves it", async () => {
    const { chainRefId } = await sdk.upload(CONTENT);
    const result = await sdk.retrieveByRefId(chainRefId);
    expect(result.bytes).toEqual(CONTENT);
  });

  it("uploads public data and retrieves it", async () => {
    const { chainRefId } = await sdk.upload(CONTENT, { isPublic: true });
    const result = await sdk.retrieveByRefId(chainRefId);
    expect(result.bytes).toEqual(CONTENT);
  });

  it("two uploads from the same wallet produce different DEKs", async () => {
    const a = await sdk.upload(CONTENT);
    const b = await sdk.upload(CONTENT);
    // Different storageIds confirm different DEKs were used.
    expect(a.storageId).not.toBe(b.storageId);
  });

  it("listing references includes the uploaded entry", async () => {
    const { chainRefId } = await sdk.upload(CONTENT);
    const refs = await sdk.listReferences();
    expect(refs.some((r) => r.refId === chainRefId)).toBe(true);
  });

  it("wallet isolation: Bob cannot decrypt Alice's private reference", async () => {
    const { chainRefId } = await sdk.upload(CONTENT);
    await expect(sdkBob.retrieveByRefId(chainRefId)).rejects.toThrow();
  });

  it("public removeReference succeeds when called by the uploader", async () => {
    const { chainRefId } = await sdk.upload(CONTENT, { isPublic: true });
    await expect(sdk.removeReference(chainRefId)).resolves.toBeUndefined();
    const refs = await sdk.listReferences();
    expect(refs.find((r) => r.refId === chainRefId)).toBeUndefined();
  });

  it("public removeReference fails when called by a different user (wrong ownerSecret)", async () => {
    // Alice uploads a public reference — ownerSeed is wrapped under Alice's KEK only.
    // Bob's KEK cannot unwrap it, so the ownerSecret Bob derives will not match the
    // ownerCommitment stored on-chain, and the ZK circuit must reject the transaction.
    const { chainRefId } = await sdk.upload(CONTENT, { isPublic: true });
    await expect(sdkBob.removeReference(chainRefId)).rejects.toThrow();
  });
});
