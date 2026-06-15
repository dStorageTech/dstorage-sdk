/**
 * Integration tests — BLAKE3 content-integrity with real Arweave.
 *
 * Verifies that the X-Content-Hash BLAKE3 tag is written during upload and
 * verified during retrieve against a real arlocal node.
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
import { ArweaveLocalStorageAdapter } from "@dstorage/storage";
import { readEnv } from "./helpers/env.js";
import { checkArlocal, createStorageAdapter } from "./helpers/arlocal.js";

const env = readEnv();

const arlocalOk = await checkArlocal(env.arlocalUrl);

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
