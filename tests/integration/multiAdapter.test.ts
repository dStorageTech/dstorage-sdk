/**
 * Integration tests — multi-adapter fallback (`storageAdapters`/`chainAdapters`
 * arrays) against real infrastructure.
 *
 * Storage fallback (Block A) uses two genuinely independent, real
 * ArweaveLocalStorageAdapter wallets against the same arlocal node — each
 * `createStorageAdapter()` call mints a fresh funded wallet, so both adapters
 * are real, working backends. Chain fallback (Block B) uses two
 * MidnightSimulatorChainAdapter instances (no real Midnight devnet/proof-server
 * needed) alongside real arlocal storage. Failures are injected deterministically
 * with `vi.spyOn`, matching the existing pattern in recovery.test.ts — this
 * keeps the tests fast and reliable while every non-failing step (encryption,
 * upload, on-chain write/read) is real.
 *
 * ── Prerequisites ──────────────────────────────────────────────────────────────
 *   docker run -d --rm -p 1984:1984 textury/arlocal
 *
 * ── Run ────────────────────────────────────────────────────────────────────────
 *   npm run test:integration
 *
 * If arlocal is not running, these suites are skipped (not failed).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import {
  DStorage,
  CoreErrorCode,
  StorePartialError,
  isStorePartialError,
} from "@dstorage/core";
import type { ArweaveLocalStorageAdapter } from "@dstorage/storage";
import { MidnightSimulatorChainAdapter } from "@dstorage/chain";
import { PasswordEncryptionAdapter } from "@dstorage/encryption";
import { readEnv } from "./helpers/env.js";
import { checkArlocal, createStorageAdapter } from "./helpers/arlocal.js";
import {
  isBundlerAvailable,
  createBundlerAdapter,
  retryUntilAvailable,
} from "./helpers/bundler.js";

const env = readEnv();
const enc = (s: string) => new TextEncoder().encode(s);

const arlocalOk = await checkArlocal(env.arlocalUrl);
const bundlerOk = await isBundlerAvailable(env);

const testEncryption = (salt: string) =>
  new PasswordEncryptionAdapter({
    password: "dstorage-multiadapter-integration-test-v1!",
    salt,
    params: { N: 32768, r: 8, p: 1 },
  });

// ── Block A: real storage adapter fallback ─────────────────────────────────────

describe.skipIf(!arlocalOk)(
  "multi-adapter: real storage fallback (arlocal)",
  () => {
    let adapterA: ArweaveLocalStorageAdapter;
    let adapterB: ArweaveLocalStorageAdapter;

    beforeAll(async () => {
      // Two independently-funded wallets against the same arlocal node — both
      // are real, working storage backends.
      ({ adapter: adapterA } = await createStorageAdapter(env.arlocalUrl));
      ({ adapter: adapterB } = await createStorageAdapter(env.arlocalUrl));
    });

    it("falls back to the second real storage adapter when the first fails to write", async () => {
      const failSpy = vi
        .spyOn(adapterA, "store")
        .mockRejectedValueOnce(new Error("simulated network failure"));

      const ds = new DStorage({
        storageAdapters: [adapterA, adapterB],
        chainAdapters: [new MidnightSimulatorChainAdapter({ logger: console })],
        encryptionAdapters: [testEncryption("storage-write-fallback")],
      });
      await ds.init();

      const content = "real storage write fallback";
      const { chainRefId } = await ds.store(enc(content));
      expect(failSpy).toHaveBeenCalled();

      const { bytes } = await ds.retrieveByRefId(chainRefId!);
      expect(new TextDecoder().decode(bytes)).toBe(content);
    });

    it("falls back to the second real storage adapter when the first fails to retrieve", async () => {
      const chainAdapter = new MidnightSimulatorChainAdapter({
        logger: console,
      });
      const encryption = testEncryption("storage-read-fallback");

      // Store via adapterB alone first.
      const uploaderDs = new DStorage({
        storageAdapters: [adapterB],
        chainAdapters: [chainAdapter],
        encryptionAdapters: [encryption],
      });
      await uploaderDs.init();
      const content = "real storage read fallback";
      const { chainRefId } = await uploaderDs.store(enc(content));

      // Real arlocal retrieval is txId-addressed and gateway-shared, so
      // adapterA could actually retrieve the same content too — force its
      // turn to fail so the fallback to adapterB is what's under test.
      const failSpy = vi
        .spyOn(adapterA, "retrieve")
        .mockRejectedValueOnce(new Error("simulated retrieve failure"));

      const retrieverDs = new DStorage({
        storageAdapters: [adapterA, adapterB],
        chainAdapters: [chainAdapter],
        encryptionAdapters: [encryption],
      });
      await retrieverDs.init();

      const { bytes } = await retrieverDs.retrieveByRefId(chainRefId!);
      expect(failSpy).toHaveBeenCalled();
      expect(new TextDecoder().decode(bytes)).toBe(content);
    });

    it("throws STORAGE_WRITE_ALL_FAILED when both real storage adapters fail to write", async () => {
      vi.spyOn(adapterA, "store").mockRejectedValueOnce(new Error("fail A"));
      vi.spyOn(adapterB, "store").mockRejectedValueOnce(new Error("fail B"));

      const ds = new DStorage({
        storageAdapters: [adapterA, adapterB],
        chainAdapters: [new MidnightSimulatorChainAdapter({ logger: console })],
        encryptionAdapters: [testEncryption("storage-write-all-failed")],
      });
      await ds.init();

      const err = await ds
        .store(enc("should not land anywhere"))
        .catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: CoreErrorCode.STORAGE_WRITE_ALL_FAILED,
      });
      expect((err as { cause?: unknown[] }).cause).toHaveLength(2);
    });
  },
);

// ── Block B: chain adapter fallback (real storage, simulator chains) ───────────

describe.skipIf(!arlocalOk)(
  "multi-adapter: chain fallback (simulator chains + real arlocal storage)",
  () => {
    let storageAdapter: ArweaveLocalStorageAdapter;

    beforeAll(async () => {
      ({ adapter: storageAdapter } = await createStorageAdapter(
        env.arlocalUrl,
      ));
    });

    it("falls back to the second chain adapter when the first fails to write", async () => {
      const chainA = new MidnightSimulatorChainAdapter({ logger: console });
      const chainB = new MidnightSimulatorChainAdapter({ logger: console });
      vi.spyOn(chainA, "writeReference").mockRejectedValueOnce(
        new Error("simulated chain outage"),
      );

      const ds = new DStorage({
        storageAdapters: [storageAdapter],
        chainAdapters: [chainA, chainB],
        encryptionAdapters: [testEncryption("chain-write-fallback")],
      });
      await ds.init();

      const content = "real chain write fallback";
      const { chainRefId } = await ds.store(enc(content));

      // Confirm the reference actually landed on chainB.
      const ref = await chainB.readReference(chainRefId!);
      expect(ref).toBeDefined();

      const { bytes } = await ds.retrieveByRefId(chainRefId!);
      expect(new TextDecoder().decode(bytes)).toBe(content);
    });

    it("listReferences() aggregates real references written across both configured chain adapters", async () => {
      const chainA = new MidnightSimulatorChainAdapter({ logger: console });
      const chainB = new MidnightSimulatorChainAdapter({ logger: console });
      const encryption = testEncryption("chain-list-aggregate");

      const dsA = new DStorage({
        storageAdapters: [storageAdapter],
        chainAdapters: [chainA],
        encryptionAdapters: [encryption],
      });
      await dsA.init();
      const { chainRefId: refA } = await dsA.store(enc("on real chain A"));

      const dsB = new DStorage({
        storageAdapters: [storageAdapter],
        chainAdapters: [chainB],
        encryptionAdapters: [encryption],
      });
      await dsB.init();
      const { chainRefId: refB } = await dsB.store(enc("on real chain B"));

      const combined = new DStorage({
        storageAdapters: [storageAdapter],
        chainAdapters: [chainA, chainB],
        encryptionAdapters: [encryption],
      });
      await combined.init();

      const refs = await combined.listReferences();
      const entryA = refs.find((r) => r.refId === refA);
      const entryB = refs.find((r) => r.refId === refB);
      expect(entryA).toBeDefined();
      expect(entryB).toBeDefined();
      expect(entryA?.sourceAdapterIndex).toBe(0);
      expect(entryB?.sourceAdapterIndex).toBe(1);
    });

    it("update() locates and targets only the chain adapter that actually holds the real ref", async () => {
      const chainA = new MidnightSimulatorChainAdapter({ logger: console });
      const chainB = new MidnightSimulatorChainAdapter({ logger: console });
      const updateSpyA = vi.spyOn(chainA, "updateReference");
      const encryption = testEncryption("chain-locate-holder");

      const dsB = new DStorage({
        storageAdapters: [storageAdapter],
        chainAdapters: [chainB],
        encryptionAdapters: [encryption],
      });
      await dsB.init();
      const { chainRefId } = await dsB.store(enc("v1 real content"));

      const ds = new DStorage({
        storageAdapters: [storageAdapter],
        chainAdapters: [chainA, chainB],
        encryptionAdapters: [encryption],
      });
      await ds.init();

      await ds.update(chainRefId!, enc("v2 real content"));

      expect(updateSpyA).not.toHaveBeenCalled();

      const { bytes } = await ds.retrieveByRefId(chainRefId!);
      expect(new TextDecoder().decode(bytes)).toBe("v2 real content");
    });

    it("StorePartialError.cause is the aggregate CHAIN_WRITE_ALL_FAILED error when both chain adapters fail to write", async () => {
      const chainA = new MidnightSimulatorChainAdapter({ logger: console });
      const chainB = new MidnightSimulatorChainAdapter({ logger: console });
      vi.spyOn(chainA, "writeReference").mockRejectedValueOnce(
        new Error("fail A"),
      );
      vi.spyOn(chainB, "writeReference").mockRejectedValueOnce(
        new Error("fail B"),
      );

      const ds = new DStorage({
        storageAdapters: [storageAdapter],
        chainAdapters: [chainA, chainB],
        encryptionAdapters: [testEncryption("chain-write-all-failed")],
      });
      await ds.init();

      const err = await ds
        .store(enc("should not reach any chain"))
        .catch((e: unknown) => e);
      expect(isStorePartialError(err)).toBe(true);
      const cause = (err as StorePartialError).cause as {
        code?: number;
        cause?: unknown[];
      };
      expect(cause.code).toBe(CoreErrorCode.CHAIN_WRITE_ALL_FAILED);
      expect(cause.cause).toHaveLength(2);
    });
  },
);

// ── Block C: heterogeneous storage backends (bundler + arlocal) ────────────────
//
// Same write-fallback shape as Block A, but the two configured storage
// adapters are genuinely different classes (ArweaveBundlerStorageAdapter vs
// ArweaveLocalStorageAdapter), not just two instances of the same one.

describe.skipIf(!bundlerOk)(
  "multi-adapter: bundler + arlocal storage fallback",
  () => {
    it("falls back to the real arlocal adapter when the bundler adapter fails to write", async () => {
      const bundlerAdapter = createBundlerAdapter(env);
      const { adapter: arlocalAdapter } = await createStorageAdapter(
        env.arlocalUrl,
      );
      vi.spyOn(bundlerAdapter, "store").mockRejectedValueOnce(
        new Error("simulated bundler outage"),
      );

      const ds = new DStorage({
        storageAdapters: [bundlerAdapter, arlocalAdapter],
        chainAdapters: [new MidnightSimulatorChainAdapter({ logger: console })],
        encryptionAdapters: [testEncryption("bundler-arlocal-fallback")],
      });
      await ds.init();

      const content = "bundler + arlocal heterogeneous fallback";
      const { chainRefId } = await ds.store(enc(content));

      const result = await retryUntilAvailable(() =>
        ds.retrieveByRefId(chainRefId!),
      );
      expect(new TextDecoder().decode(result.bytes)).toBe(content);
    });
  },
);
