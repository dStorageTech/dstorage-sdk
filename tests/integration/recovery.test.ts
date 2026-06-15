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
import type { StoreRecovery } from "@dstorage/core";
import { MockMidnightChainAdapter } from "@dstorage/chain";
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
