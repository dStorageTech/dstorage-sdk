/**
 * Integration tests — SDK storage transaction tags on arlocal.
 *
 * Verifies that the correct tag keys and values are written to Arweave
 * transactions for single-shot and chunked uploads (both public and private).
 *
 * ── Prerequisites ──────────────────────────────────────────────────────────────
 *   docker run -d --rm -p 1984:1984 textury/arlocal
 *
 * ── Run ────────────────────────────────────────────────────────────────────────
 *   npm run test:integration
 *
 * If arlocal is not running, this suite is skipped (not failed).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { DStorage, CHUNK_SIZE } from "@dstorage/core";
import type { ChunkManifest } from "@dstorage/core";
import { MidnightSimulatorChainAdapter } from "@dstorage/chain";
import { PasswordEncryptionAdapter } from "@dstorage/encryption";
import type { ArweaveLocalStorageAdapter } from "@dstorage/storage";
import { readEnv } from "./helpers/env.js";
import { checkArlocal, createStorageAdapter } from "./helpers/arlocal.js";
import { fetchTxTags } from "./helpers/arweave-tags.js";
import corePackageJson from "../../packages/core/package.json";

const env = readEnv();
const arlocalOk = await checkArlocal(env.arlocalUrl);

const SMALL_CONTENT = new TextEncoder().encode("tags-integration-test-content");

describe.skipIf(!arlocalOk)("storage transaction tags on arlocal", () => {
  let sdk: DStorage;
  let storageAdapter: ArweaveLocalStorageAdapter;

  beforeAll(async () => {
    ({ adapter: storageAdapter } = await createStorageAdapter(env.arlocalUrl));
    sdk = new DStorage({
      storageAdapter,
      chainAdapter: new MidnightSimulatorChainAdapter({ logger: console }),
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "dstorage-integration-tags-test-v1!",
          salt: "dstorage:integration-test:tags",
          params: { N: 1024, r: 8, p: 1 },
        }),
      ],
    });
    await sdk.init();
  });

  it("single-shot private upload — dStorage-Version and Content-Type: application/octet-stream", async () => {
    const { storageId } = await sdk.store(SMALL_CONTENT);
    const tags = await fetchTxTags(env.arlocalUrl, storageId);
    expect(tags["dStorage-Version"]).toBe(corePackageJson.version);
    expect(tags["Content-Type"]).toBe("application/octet-stream");
  });

  it("single-shot public upload — dStorage-Version and Content-Type: application/octet-stream", async () => {
    const { storageId } = await sdk.store(SMALL_CONTENT, { isPublic: true });
    const tags = await fetchTxTags(env.arlocalUrl, storageId);
    expect(tags["dStorage-Version"]).toBe(corePackageJson.version);
    expect(tags["Content-Type"]).toBe("application/octet-stream");
  });

  it("public chunked manifest — Content-Type: application/json and chunk txs carry chunk index/total tags", async () => {
    // Force chunked path: needs data > CHUNK_SIZE (10 MB).
    const largeData = new Uint8Array(CHUNK_SIZE + 1);

    const { storageId: manifestId } = await sdk.store(largeData, {
      isPublic: true,
    });

    const manifestTags = await fetchTxTags(env.arlocalUrl, manifestId);
    expect(manifestTags["Content-Type"]).toBe("application/json");
    expect(manifestTags["dStorage-Manifest-Upload"]).toBe("true");
    expect(manifestTags["dStorage-Version"]).toBe(corePackageJson.version);

    // For public uploads the manifest is plaintext JSON — retrieve and parse it
    // to get each chunk's storageId, then verify the chunk-level tags.
    const { bytes: manifestBytes } = await storageAdapter.retrieve(manifestId);
    const manifest = JSON.parse(
      new TextDecoder().decode(manifestBytes),
    ) as ChunkManifest;

    for (const chunk of manifest.chunks) {
      const chunkTags = await fetchTxTags(env.arlocalUrl, chunk.storageId);
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
    const tags = await fetchTxTags(env.arlocalUrl, manifestId);
    expect(tags["Content-Type"]).toBe("application/octet-stream");
    expect(tags["dStorage-Manifest-Upload"]).toBe("true");
    expect(tags["dStorage-Version"]).toBe(corePackageJson.version);
  });
});
