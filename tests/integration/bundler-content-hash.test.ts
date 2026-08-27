/**
 * Integration tests — content hash verification (Arweave Bundler + mock chain).
 *
 * Verifies that the on-chain BLAKE3 content hash is written correctly on store()
 * and verified on retrieveByRefId() when using the Arweave Bundler adapter
 * (local mock signing/bundler server, retrieval via arlocal directly).
 *
 * ── Prerequisites ──────────────────────────────────────────────────────────────
 *   docker compose -f tools/compose-undeployed.yml up -d --wait   (arlocal)
 *   npm run bundler-mock:run                                       (separate terminal;
 *                                                                    copy the printed auth
 *                                                                    token into .env.integration)
 *
 * ── Run ────────────────────────────────────────────────────────────────────────
 *   npm run test:integration -- -t "bundler"
 *
 * If arlocal or the bundler mock server is not running, this suite is
 * skipped (not failed).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { DStorage } from "@dstorage/core";
import { MidnightSimulatorChainAdapter } from "@dstorage/chain";
import { computeBlake3Hex } from "@dstorage/crypto";
import { PasswordEncryptionAdapter } from "@dstorage/encryption";
import type { ArweaveBundlerStorageAdapter } from "@dstorage/storage";
import { readEnv } from "./helpers/env.js";
import {
  isBundlerAvailable,
  createBundlerAdapter,
  retryUntilAvailable,
} from "./helpers/bundler.js";

const env = readEnv();
const CONTENT = new TextEncoder().encode(
  "bundler content-hash integration test payload",
);

const bundlerOk = await isBundlerAvailable(env);

describe.skipIf(!bundlerOk)(
  "content hash — arweave bundler + mock chain",
  () => {
    let sdk: DStorage;
    let mockChain: MidnightSimulatorChainAdapter;
    let storageAdapter: ArweaveBundlerStorageAdapter;

    beforeAll(async () => {
      storageAdapter = createBundlerAdapter(env);
      mockChain = new MidnightSimulatorChainAdapter({ logger: console });
      sdk = new DStorage({
        storageAdapter,
        chainAdapter: mockChain,
        encryptionAdapters: [
          new PasswordEncryptionAdapter({
            password: "dstorage-bundler-content-hash-test-v1!",
            salt: "dstorage:integration-test:bundler-content-hash",
            params: { N: 32768, r: 8, p: 1 },
          }),
        ],
      });
      await sdk.init();
    });

    it("store() writes a 64-char hex contentHash to the chain adapter", async () => {
      const { chainRefId } = await sdk.store(CONTENT);
      const ref = await mockChain.readReference(chainRefId);
      expect(typeof ref.contentHash).toBe("string");
      expect(ref.contentHash).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(ref.contentHash!)).toBe(true);
    });

    it("contentHash equals BLAKE3 of the Arweave ciphertext bytes", async () => {
      const { chainRefId, storageId } = await sdk.store(CONTENT);
      const ref = await mockChain.readReference(chainRefId);

      const { bytes: rawBytes } = await retryUntilAvailable(() =>
        storageAdapter.retrieve(storageId),
      );
      const expected = await computeBlake3Hex(rawBytes);

      expect(ref.contentHash).toBe(expected);
    });

    it("contentHash round-trip: store → retrieveByRefId succeeds with correct content", async () => {
      const { chainRefId } = await sdk.store(CONTENT);
      const result = await retryUntilAvailable(() =>
        sdk.retrieveByRefId(chainRefId),
      );
      expect(result.bytes).toEqual(CONTENT);
    });

    it("contentHash is stored for public uploads too", async () => {
      const { chainRefId } = await sdk.store(CONTENT, { isPublic: true });
      const ref = await mockChain.readReference(chainRefId);
      expect(ref.contentHash).toHaveLength(64);
    });

    it("public upload contentHash equals BLAKE3 of the raw plaintext bytes", async () => {
      const { chainRefId, storageId } = await sdk.store(CONTENT, {
        isPublic: true,
      });
      const ref = await mockChain.readReference(chainRefId);
      const { bytes: rawBytes } = await retryUntilAvailable(() =>
        storageAdapter.retrieve(storageId),
      );
      const expected = await computeBlake3Hex(rawBytes);
      expect(ref.contentHash).toBe(expected);
    });

    it("private upload: Arweave X-Content-Hash tag and on-chain contentHash both agree", async () => {
      const { chainRefId } = await sdk.store(CONTENT);
      const ref = await mockChain.readReference(chainRefId);
      const result = await retryUntilAvailable(() =>
        sdk.retrieveByRefId(chainRefId),
      );
      const arweaveHash = result.tags["X-Content-Hash"];
      expect(arweaveHash).toBeTruthy();
      expect(ref.contentHash).toBe(arweaveHash);
    });

    it("public upload: Arweave X-Content-Hash tag and on-chain contentHash both agree (hash of plaintext)", async () => {
      const { chainRefId } = await sdk.store(CONTENT, { isPublic: true });
      const ref = await mockChain.readReference(chainRefId);
      const result = await retryUntilAvailable(() =>
        sdk.retrieveByRefId(chainRefId),
      );
      const arweaveHash = result.tags["X-Content-Hash"];
      expect(arweaveHash).toBeTruthy();
      expect(ref.contentHash).toBe(arweaveHash);
    });

    it("update() stores a new contentHash and retrieveByRefId returns updated content", async () => {
      const { chainRefId } = await sdk.store(CONTENT);
      const refBefore = await mockChain.readReference(chainRefId);

      const newContent = new TextEncoder().encode("updated bundler payload");
      await sdk.update(chainRefId, newContent);

      const refAfter = await mockChain.readReference(chainRefId);
      expect(refAfter.contentHash).not.toBe(refBefore.contentHash);

      const result = await retryUntilAvailable(() =>
        sdk.retrieveByRefId(chainRefId),
      );
      expect(result.bytes).toEqual(newContent);
    });

    it("rotateKeys() preserves the contentHash (content not re-uploaded)", async () => {
      const { chainRefId } = await sdk.store(CONTENT);
      const refBefore = await mockChain.readReference(chainRefId);

      await sdk.rotateKeys(chainRefId);

      const refAfter = await mockChain.readReference(chainRefId);
      expect(refAfter.contentHash).toBe(refBefore.contentHash);
    });
  },
);
