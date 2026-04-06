/**
 * Multi-key wrapping integration tests — real arlocal storage + mock chain.
 *
 * Verifies that a single upload encrypted with two seed providers (password +
 * mnemonic) can be independently decrypted by each provider against real
 * Arweave-local storage.
 *
 * ── Prerequisites ──────────────────────────────────────────────────────────────
 *
 *   docker run -d --rm -p 1984:1984 textury/arlocal
 *
 * If arlocal is not running, the suite is skipped (not failed).
 *
 * ── Run ────────────────────────────────────────────────────────────────────────
 *   npm run test:integration
 */

import { describe, it, expect, beforeAll } from "vitest";
import { DStorage } from "@dstorage/core";
import { MockMidnightChainAdapter } from "@dstorage/chain";
import {
  PasswordSeedProvider,
  MnemonicSeedProvider,
} from "@dstorage/seed-providers";
import { readEnv } from "./helpers/env.js";
import { checkArlocal, createStorageAdapter } from "./helpers/arlocal.js";
import type { ArweaveLocalStorageAdapter } from "@dstorage/storage";

const env = readEnv();
const arlocalOk = await checkArlocal(env.arlocalUrl);

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

// ── Seed providers ────────────────────────────────────────────────────────────

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// Low-cost scrypt params so the integration suite stays fast.
const passwordProvider = () =>
  new PasswordSeedProvider({
    password: "dstorage-multikey-integration-test!",
    salt: "dstorage:multikey:integration:v1",
    params: { N: 1024, r: 8, p: 1 },
  });

const mnemonicProvider = () =>
  new MnemonicSeedProvider({ mnemonic: TEST_MNEMONIC });

// ── Suite ─────────────────────────────────────────────────────────────────────

describe.skipIf(!arlocalOk)(
  "multi-key wrapping — arlocal storage + mock chain",
  () => {
    let storageAdapter: ArweaveLocalStorageAdapter;
    let chainAdapter: MockMidnightChainAdapter;

    beforeAll(async () => {
      const { adapter } = await createStorageAdapter(env.arlocalUrl);
      storageAdapter = adapter;
      chainAdapter = new MockMidnightChainAdapter({ logger: console });
    });

    it("content uploaded with two providers is retrievable by the password provider", async () => {
      const uploader = new DStorage({
        storageAdapter,
        chainAdapter,
        encryptionSeedProviders: [passwordProvider(), mnemonicProvider()],
      });
      await uploader.init();

      const content = "integration: password retrieval";
      const { chainRefId } = await uploader.upload(enc(content));

      const sdk = new DStorage({
        storageAdapter,
        chainAdapter,
        encryptionSeedProviders: [passwordProvider()],
      });
      await sdk.init();

      const { bytes } = await sdk.retrieveByRefId(chainRefId);
      expect(dec(bytes)).toBe(content);
    });

    it("content uploaded with two providers is retrievable by the mnemonic provider", async () => {
      const uploader = new DStorage({
        storageAdapter,
        chainAdapter,
        encryptionSeedProviders: [passwordProvider(), mnemonicProvider()],
      });
      await uploader.init();

      const content = "integration: mnemonic retrieval";
      const { chainRefId } = await uploader.upload(enc(content));

      const sdk = new DStorage({
        storageAdapter,
        chainAdapter,
        encryptionSeedProviders: [mnemonicProvider()],
      });
      await sdk.init();

      const { bytes } = await sdk.retrieveByRefId(chainRefId);
      expect(dec(bytes)).toBe(content);
    });

    it("both providers recover identical bytes from the same upload", async () => {
      const uploader = new DStorage({
        storageAdapter,
        chainAdapter,
        encryptionSeedProviders: [passwordProvider(), mnemonicProvider()],
      });
      await uploader.init();

      const content = "integration: identical bytes check";
      const { chainRefId } = await uploader.upload(enc(content));

      const passwordSdk = new DStorage({
        storageAdapter,
        chainAdapter,
        encryptionSeedProviders: [passwordProvider()],
      });
      const mnemonicSdk = new DStorage({
        storageAdapter,
        chainAdapter,
        encryptionSeedProviders: [mnemonicProvider()],
      });
      await Promise.all([passwordSdk.init(), mnemonicSdk.init()]);

      const [byPassword, byMnemonic] = await Promise.all([
        passwordSdk.retrieveByRefId(chainRefId),
        mnemonicSdk.retrieveByRefId(chainRefId),
      ]);

      expect(byPassword.bytes).toEqual(byMnemonic.bytes);
      expect(dec(byPassword.bytes)).toBe(content);
    });

    it("an unrelated provider cannot decrypt multi-key content", async () => {
      const uploader = new DStorage({
        storageAdapter,
        chainAdapter,
        encryptionSeedProviders: [passwordProvider(), mnemonicProvider()],
      });
      await uploader.init();

      const { chainRefId } = await uploader.upload(enc("private"));

      const unrelated = new DStorage({
        storageAdapter,
        chainAdapter,
        encryptionSeedProviders: [
          new PasswordSeedProvider({
            password: "completely-different-passphrase!",
            salt: "dstorage:multikey:integration:v1",
            params: { N: 1024, r: 8, p: 1 },
          }),
        ],
      });
      await unrelated.init();

      await expect(unrelated.retrieveByRefId(chainRefId)).rejects.toThrow();
    });
  },
);
