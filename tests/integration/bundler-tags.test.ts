/**
 * Integration tests — Arweave Bundler storage transaction tags.
 *
 * Verifies that the correct tag keys and values are written to the relayed
 * Arweave transactions for single-shot and chunked uploads (both public and
 * private), using the local mock signing/bundler server (retrieval via
 * arlocal directly).
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
import { DStorage, CHUNK_SIZE } from "@dstorage/core";
import type { ChunkManifest } from "@dstorage/core";
import { MidnightSimulatorChainAdapter } from "@dstorage/chain";
import { PasswordEncryptionAdapter } from "@dstorage/encryption";
import type { ArweaveBundlerStorageAdapter } from "@dstorage/storage";
import { readEnv } from "./helpers/env.js";
import {
  isBundlerAvailable,
  createBundlerAdapter,
  retryUntilAvailable,
} from "./helpers/bundler.js";
import { fetchTxTags } from "./helpers/arweave-tags.js";
import corePackageJson from "../../packages/core/package.json";

const env = readEnv();
const bundlerOk = await isBundlerAvailable(env);

const SMALL_CONTENT = new TextEncoder().encode(
  "bundler-tags-integration-test-content",
);

describe.skipIf(!bundlerOk)("arweave bundler storage transaction tags", () => {
  let sdk: DStorage;
  let storageAdapter: ArweaveBundlerStorageAdapter;

  beforeAll(async () => {
    storageAdapter = createBundlerAdapter(env);
    sdk = new DStorage({
      storageAdapter,
      chainAdapter: new MidnightSimulatorChainAdapter({ logger: console }),
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "dstorage-integration-bundler-tags-test-v1!",
          salt: "dstorage:integration-test:bundler-tags",
          params: { N: 32768, r: 8, p: 1 },
        }),
      ],
    });
    await sdk.init();
  });

  it("single-shot private upload — dStorage-Version and Content-Type: application/octet-stream", async () => {
    const { storageId } = await sdk.store(SMALL_CONTENT);
    const tags = await retryUntilAvailable(() =>
      fetchTxTags(env.arlocalUrl, storageId),
    );
    expect(tags["dStorage-Version"]).toBe(corePackageJson.version);
    expect(tags["Content-Type"]).toBe("application/octet-stream");
  });

  it("single-shot public upload — dStorage-Version and Content-Type: application/octet-stream", async () => {
    const { storageId } = await sdk.store(SMALL_CONTENT, { isPublic: true });
    const tags = await retryUntilAvailable(() =>
      fetchTxTags(env.arlocalUrl, storageId),
    );
    expect(tags["dStorage-Version"]).toBe(corePackageJson.version);
    expect(tags["Content-Type"]).toBe("application/octet-stream");
  });

  it("public chunked manifest — Content-Type: application/json and chunk txs carry chunk index/total tags", async () => {
    // Force chunked path: needs data > CHUNK_SIZE (5 MB).
    const largeData = new Uint8Array(CHUNK_SIZE + 1);
    for (let i = 0; i < largeData.length; i += 65536) {
      crypto.getRandomValues(largeData.subarray(i, i + 65536));
    }

    const { storageId: manifestId } = await sdk.store(largeData, {
      isPublic: true,
    });

    const manifestTags = await retryUntilAvailable(() =>
      fetchTxTags(env.arlocalUrl, manifestId),
    );
    expect(manifestTags["Content-Type"]).toBe("application/json");
    expect(manifestTags["dStorage-Manifest-Upload"]).toBe("true");
    expect(manifestTags["dStorage-Version"]).toBe(corePackageJson.version);

    // For public uploads the manifest is plaintext JSON — retrieve and parse it
    // to get each chunk's storageId, then verify the chunk-level tags.
    const { bytes: manifestBytes } = await retryUntilAvailable(() =>
      storageAdapter.retrieve(manifestId),
    );
    const manifest = JSON.parse(
      new TextDecoder().decode(manifestBytes),
    ) as ChunkManifest;

    for (const chunk of manifest.chunks) {
      const chunkTags = await retryUntilAvailable(() =>
        fetchTxTags(env.arlocalUrl, chunk.storageId),
      );
      expect(chunkTags["dStorage-Chunk-Index"]).toBe(String(chunk.index));
      expect(chunkTags["dStorage-Chunk-Total"]).toBe(
        String(manifest.chunkCount),
      );
      expect(chunkTags["Content-Type"]).toBe("application/octet-stream");
      expect(chunkTags["dStorage-Version"]).toBe(corePackageJson.version);
    }
  });

  it("private chunked manifest — Content-Type: application/octet-stream (ciphertext)", async () => {
    const largeData = new Uint8Array(CHUNK_SIZE + 1);
    const { storageId: manifestId } = await sdk.store(largeData);
    const tags = await retryUntilAvailable(() =>
      fetchTxTags(env.arlocalUrl, manifestId),
    );
    expect(tags["Content-Type"]).toBe("application/octet-stream");
    expect(tags["dStorage-Manifest-Upload"]).toBe("true");
    expect(tags["dStorage-Version"]).toBe(corePackageJson.version);
  });
});
