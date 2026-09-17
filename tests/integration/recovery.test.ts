/**
 * Integration tests — StorePartialError recovery.
 *
 * Verifies that a failed chain write (simulated with a mock spy) produces a
 * StorePartialError whose recovery payload can be used with registerReference()
 * to create a valid on-chain reference — without re-uploading the content.
 *
 * ── Prerequisites ──────────────────────────────────────────────────────────────
 *   docker run -d --rm -p 1984:1984 textury/arlocal
 *
 * ── Run ────────────────────────────────────────────────────────────────────────
 *   npm run test:integration
 *
 * If arlocal is not running, this suite is skipped (not failed).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { DStorage, isStorePartialError } from "@dstorage/core";
import type { StoreRecovery, StorePartialError } from "@dstorage/core";
import { MidnightSimulatorChainAdapter } from "@dstorage/chain";
import { PasswordEncryptionAdapter } from "@dstorage/encryption";
import { readEnv } from "./helpers/env.js";
import { checkArlocal, createStorageAdapter } from "./helpers/arlocal.js";

const env = readEnv();
const CONTENT = new TextEncoder().encode("hello from integration tests");

const arlocalOk = await checkArlocal(env.arlocalUrl);

describe.skipIf(!arlocalOk)(
  "StorePartialError recovery — arlocal storage + mock chain",
  () => {
    let sdk: DStorage;
    let mockChain: MidnightSimulatorChainAdapter;

    beforeAll(async () => {
      const { adapter } = await createStorageAdapter(env.arlocalUrl);
      mockChain = new MidnightSimulatorChainAdapter({ logger: console });
      sdk = new DStorage({
        storageAdapters: [adapter],
        chainAdapters: [mockChain],
        encryptionAdapters: [
          new PasswordEncryptionAdapter({
            password: "dstorage-recovery-integration-test!",
            salt: "dstorage:recovery:integration:v1",
            params: { N: 32768, r: 8, p: 1 },
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

describe.skipIf(!arlocalOk)(
  "retryUpdate() recovery — arlocal storage + mock chain",
  () => {
    let sdk: DStorage;
    let mockChain: MidnightSimulatorChainAdapter;
    let refId: string;

    beforeAll(async () => {
      const { adapter } = await createStorageAdapter(env.arlocalUrl);
      mockChain = new MidnightSimulatorChainAdapter({ logger: console });
      sdk = new DStorage({
        storageAdapters: [adapter],
        chainAdapters: [mockChain],
        encryptionAdapters: [
          new PasswordEncryptionAdapter({
            password: "dstorage-retryupdate-integration-test!",
            salt: "dstorage:retryupdate:integration:v1",
            params: { N: 32768, r: 8, p: 1 },
          }),
        ],
      });
      await sdk.init();
      // Store initial v1 so all update tests have a valid refId.
      const v1 = await sdk.store(new TextEncoder().encode("v1 content"));
      refId = v1.chainRefId;
    });

    it("reactive recovery: update() chain fail → retryUpdate() → retrieveByRefId returns v2 bytes", async () => {
      const v2 = new TextEncoder().encode("v2 reactive recovery integration");

      vi.spyOn(mockChain, "updateReference").mockRejectedValueOnce(
        new Error("simulated chain outage"),
      );

      const err = await sdk.update(refId, v2).catch((e: unknown) => e);
      expect(isStorePartialError(err)).toBe(true);

      await sdk.retryUpdate(refId, (err as StorePartialError).recovery);

      const { bytes } = await sdk.retrieveByRefId(refId);
      expect(bytes).toEqual(v2);
    });

    it("proactive recovery: onProgress 'stored' event → simulated failure → retryUpdate() → retrieveByRefId returns v2 bytes", async () => {
      let capturedRecovery: StoreRecovery | undefined;
      const v2 = new TextEncoder().encode("v2 proactive recovery integration");

      vi.spyOn(mockChain, "updateReference").mockRejectedValueOnce(
        new Error("simulated chain outage"),
      );

      await sdk
        .update(refId, v2, {
          onProgress: (p) => {
            if (p.phase === "stored") capturedRecovery = p.recovery;
          },
        })
        .catch(() => {});

      expect(capturedRecovery).toBeDefined();

      await sdk.retryUpdate(refId, capturedRecovery!);

      const { bytes } = await sdk.retrieveByRefId(refId);
      expect(bytes).toEqual(v2);
    });
  },
);
