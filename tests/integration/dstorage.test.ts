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
 * Load before running: set -a; source .env.integration; set +a
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

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DStorage } from "@dstorage/core";
import { MockMidnightChainAdapter } from "@dstorage/chain";
import { MnemonicSeedProvider, DemoSeedProvider } from "@dstorage/seed-providers";
import { readEnv } from "./helpers/env.js";
import { checkArlocal, createStorageAdapter } from "./helpers/arlocal.js";
import { isMidnightAvailable, createChainAdapter } from "./helpers/midnight.js";

const env = readEnv();
const CONTENT = new TextEncoder().encode("hello from integration tests");

// Availability checks run once at module load (top-level await in ESM).
const arlocalOk = await checkArlocal(env.arlocalUrl);
const midnightOk = arlocalOk && await isMidnightAvailable(env);

// ── Suite 1: arlocal only (no Midnight) ────────────────────────────────────────
//
// Verifies that upload/retrieve works end-to-end through a real arlocal node
// before adding the complexity of the Midnight chain adapter.

describe.skipIf(!arlocalOk)("arlocal only (mock chain)", () => {
  let sdk: DStorage;

  beforeAll(async () => {
    const { adapter } = await createStorageAdapter(env.arlocalUrl);
    sdk = new DStorage({
      storageAdapter: adapter,
      chainAdapter: new MockMidnightChainAdapter({ logger: console }),
      encryptionSeedProvider: new DemoSeedProvider(),
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
  const BOB_SEED =
    "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";

  beforeAll(async () => {
    const [{ adapter }, chain] = await Promise.all([
      createStorageAdapter(env.arlocalUrl),
      createChainAdapter(env),
    ]);
    chainAdapter = chain;

    sdk = new DStorage({
      storageAdapter: adapter,
      chainAdapter,
      encryptionSeedProvider: new MnemonicSeedProvider({ mnemonic: ALICE_SEED }),
    });
    await sdk.init();

    // Bob uses a separate DStorage instance against the same contract.
    const { adapter: adapterBob } = await createStorageAdapter(env.arlocalUrl);
    const chainBob = await createChainAdapter(env);
    sdkBob = new DStorage({
      storageAdapter: adapterBob,
      chainAdapter: chainBob,
      encryptionSeedProvider: new MnemonicSeedProvider({ mnemonic: BOB_SEED }),
      ...(env.midnight.contractAddress
        ? { dataRegistryAddress: env.midnight.contractAddress }
        : {}),
    });
    await sdkBob.init();
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
});
