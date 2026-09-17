/**
 * Multi-key wrapping integration tests — real arlocal storage + mock chain.
 *
 * Verifies that a single store encrypted with two seed providers (password +
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
import { DStorage, CoreErrorCode } from "@dstorage/core";
import { MidnightSimulatorChainAdapter } from "@dstorage/chain";
import {
  PasswordEncryptionAdapter,
  MnemonicEncryptionAdapter,
} from "@dstorage/encryption";
import { readEnv } from "./helpers/env.js";
import { checkArlocal, createStorageAdapter } from "./helpers/arlocal.js";
import type { ArweaveLocalStorageAdapter } from "@dstorage/storage";

const env = readEnv();
const arlocalOk = await checkArlocal(env.arlocalUrl);

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

// ── Seed providers ────────────────────────────────────────────────────────────

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

// Low-cost scrypt params so the integration suite stays fast.
const passwordProvider = () =>
  new PasswordEncryptionAdapter({
    password: "dstorage-multikey-integration-test!",
    salt: "dstorage:multikey:integration:v1",
    params: { N: 32768, r: 8, p: 1 },
  });

const mnemonicProvider = () =>
  new MnemonicEncryptionAdapter({ mnemonic: TEST_MNEMONIC });

// Different password used to simulate a post-rotation credential.
const newPasswordProvider = () =>
  new PasswordEncryptionAdapter({
    password: "dstorage-multikey-integration-ROTATED!",
    salt: "dstorage:multikey:integration:v1",
    params: { N: 32768, r: 8, p: 1 },
  });

// ── Suite ─────────────────────────────────────────────────────────────────────

describe.skipIf(!arlocalOk)(
  "multi-key wrapping — arlocal storage + mock chain",
  () => {
    let storageAdapter: ArweaveLocalStorageAdapter;
    let chainAdapter: MidnightSimulatorChainAdapter;

    beforeAll(async () => {
      const { adapter } = await createStorageAdapter(env.arlocalUrl);
      storageAdapter = adapter;
      chainAdapter = new MidnightSimulatorChainAdapter({ logger: console });
    });

    it("content stored with two providers is retrievable by the password provider", async () => {
      const uploader = new DStorage({
        storageAdapters: [storageAdapter],
        chainAdapters: [chainAdapter],
        encryptionAdapters: [passwordProvider(), mnemonicProvider()],
      });
      await uploader.init();

      const content = "integration: password retrieval";
      const { chainRefId } = await uploader.store(enc(content));

      const sdk = new DStorage({
        storageAdapters: [storageAdapter],
        chainAdapters: [chainAdapter],
        encryptionAdapters: [passwordProvider()],
      });
      await sdk.init();

      const { bytes } = await sdk.retrieveByRefId(chainRefId);
      expect(dec(bytes)).toBe(content);
    });

    it("content stored with two providers is retrievable by the mnemonic provider", async () => {
      const uploader = new DStorage({
        storageAdapters: [storageAdapter],
        chainAdapters: [chainAdapter],
        encryptionAdapters: [passwordProvider(), mnemonicProvider()],
      });
      await uploader.init();

      const content = "integration: mnemonic retrieval";
      const { chainRefId } = await uploader.store(enc(content));

      const sdk = new DStorage({
        storageAdapters: [storageAdapter],
        chainAdapters: [chainAdapter],
        encryptionAdapters: [mnemonicProvider()],
      });
      await sdk.init();

      const { bytes } = await sdk.retrieveByRefId(chainRefId);
      expect(dec(bytes)).toBe(content);
    });

    it("both providers recover identical bytes from the same store", async () => {
      const uploader = new DStorage({
        storageAdapters: [storageAdapter],
        chainAdapters: [chainAdapter],
        encryptionAdapters: [passwordProvider(), mnemonicProvider()],
      });
      await uploader.init();

      const content = "integration: identical bytes check";
      const { chainRefId } = await uploader.store(enc(content));

      const passwordSdk = new DStorage({
        storageAdapters: [storageAdapter],
        chainAdapters: [chainAdapter],
        encryptionAdapters: [passwordProvider()],
      });
      const mnemonicSdk = new DStorage({
        storageAdapters: [storageAdapter],
        chainAdapters: [chainAdapter],
        encryptionAdapters: [mnemonicProvider()],
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
        storageAdapters: [storageAdapter],
        chainAdapters: [chainAdapter],
        encryptionAdapters: [passwordProvider(), mnemonicProvider()],
      });
      await uploader.init();

      const { chainRefId } = await uploader.store(enc("private"));

      const unrelated = new DStorage({
        storageAdapters: [storageAdapter],
        chainAdapters: [chainAdapter],
        encryptionAdapters: [
          new PasswordEncryptionAdapter({
            password: "completely-different-passphrase!",
            salt: "dstorage:multikey:integration:v1",
            params: { N: 32768, r: 8, p: 1 },
          }),
        ],
      });
      await unrelated.init();

      await expect(unrelated.retrieveByRefId(chainRefId)).rejects.toMatchObject(
        {
          code: CoreErrorCode.DECRYPT_NO_WRAPPER_MATCHED,
        },
      );
    });

    it("password-only SDK can removeReference a public store made with two providers", async () => {
      const uploader = new DStorage({
        storageAdapters: [storageAdapter],
        chainAdapters: [chainAdapter],
        encryptionAdapters: [passwordProvider(), mnemonicProvider()],
      });
      await uploader.init();
      const { chainRefId } = await uploader.store(enc("public removable"), {
        isPublic: true,
      });

      const passwordSdk = new DStorage({
        storageAdapters: [storageAdapter],
        chainAdapters: [chainAdapter],
        encryptionAdapters: [passwordProvider()],
      });
      await passwordSdk.init();

      await expect(
        passwordSdk.removeReference(chainRefId),
      ).resolves.toBeUndefined();
      const refs = await passwordSdk.listReferences();
      expect(refs.find((r) => r.refId === chainRefId)).toBeUndefined();
    });

    it("mnemonic-only SDK can removeReference a public store made with two providers", async () => {
      const uploader = new DStorage({
        storageAdapters: [storageAdapter],
        chainAdapters: [chainAdapter],
        encryptionAdapters: [passwordProvider(), mnemonicProvider()],
      });
      await uploader.init();
      const { chainRefId } = await uploader.store(enc("public removable 2"), {
        isPublic: true,
      });

      const mnemonicSdk = new DStorage({
        storageAdapters: [storageAdapter],
        chainAdapters: [chainAdapter],
        encryptionAdapters: [mnemonicProvider()],
      });
      await mnemonicSdk.init();

      await expect(
        mnemonicSdk.removeReference(chainRefId),
      ).resolves.toBeUndefined();
    });

    // ── rotateKeys ──────────────────────────────────────────────────────────────

    describe("rotateKeys", () => {
      it("mnemonic authorises rotation to a new password; both new adapters can then retrieve", async () => {
        const uploader = new DStorage({
          storageAdapters: [storageAdapter],
          chainAdapters: [chainAdapter],
          encryptionAdapters: [passwordProvider(), mnemonicProvider()],
        });
        await uploader.init();

        const content = "integration: rotate password via mnemonic";
        const { chainRefId } = await uploader.store(enc(content));

        // Rotate: old password is absent — mnemonic unwraps the old DEK.
        const rotateSdk = new DStorage({
          storageAdapters: [storageAdapter],
          chainAdapters: [chainAdapter],
          encryptionAdapters: [newPasswordProvider(), mnemonicProvider()],
        });
        await rotateSdk.init();
        await rotateSdk.rotateKeys(chainRefId);

        const newPasswordSdk = new DStorage({
          storageAdapters: [storageAdapter],
          chainAdapters: [chainAdapter],
          encryptionAdapters: [newPasswordProvider()],
        });
        await newPasswordSdk.init();
        const byNewPassword = await newPasswordSdk.retrieveByRefId(chainRefId);
        expect(dec(byNewPassword.bytes)).toBe(content);

        const mnemonicSdk = new DStorage({
          storageAdapters: [storageAdapter],
          chainAdapters: [chainAdapter],
          encryptionAdapters: [mnemonicProvider()],
        });
        await mnemonicSdk.init();
        const byMnemonic = await mnemonicSdk.retrieveByRefId(chainRefId);
        expect(dec(byMnemonic.bytes)).toBe(content);
      });

      it("old password can no longer decrypt after rotation", async () => {
        const uploader = new DStorage({
          storageAdapters: [storageAdapter],
          chainAdapters: [chainAdapter],
          encryptionAdapters: [passwordProvider(), mnemonicProvider()],
        });
        await uploader.init();

        const { chainRefId } = await uploader.store(
          enc("integration: old key locked out after rotation"),
        );

        const rotateSdk = new DStorage({
          storageAdapters: [storageAdapter],
          chainAdapters: [chainAdapter],
          encryptionAdapters: [newPasswordProvider(), mnemonicProvider()],
        });
        await rotateSdk.init();
        await rotateSdk.rotateKeys(chainRefId);

        const oldPasswordSdk = new DStorage({
          storageAdapters: [storageAdapter],
          chainAdapters: [chainAdapter],
          encryptionAdapters: [passwordProvider()],
        });
        await oldPasswordSdk.init();
        await expect(
          oldPasswordSdk.retrieveByRefId(chainRefId),
        ).rejects.toMatchObject({
          code: CoreErrorCode.DECRYPT_NO_WRAPPER_MATCHED,
        });
      });

      it("rotateKeys with the same adapter set is idempotent — content still decrypts", async () => {
        const sdk = new DStorage({
          storageAdapters: [storageAdapter],
          chainAdapters: [chainAdapter],
          encryptionAdapters: [passwordProvider(), mnemonicProvider()],
        });
        await sdk.init();

        const content = "integration: idempotent rotate";
        const { chainRefId } = await sdk.store(enc(content));

        // rotateKeys with the exact same adapter set — envelope is re-wrapped
        // but semantics are unchanged.
        await sdk.rotateKeys(chainRefId);

        const { bytes } = await sdk.retrieveByRefId(chainRefId);
        expect(dec(bytes)).toBe(content);
      });

      it("unrelated adapter cannot authorise rotateKeys", async () => {
        const storeSdk = new DStorage({
          storageAdapters: [storageAdapter],
          chainAdapters: [chainAdapter],
          encryptionAdapters: [passwordProvider()],
        });
        await storeSdk.init();
        const { chainRefId } = await storeSdk.store(
          enc("integration: unrelated adapter rejected"),
        );

        const unrelatedSdk = new DStorage({
          storageAdapters: [storageAdapter],
          chainAdapters: [chainAdapter],
          encryptionAdapters: [
            new PasswordEncryptionAdapter({
              password: "completely-different-passphrase!",
              salt: "dstorage:multikey:integration:v1",
              params: { N: 32768, r: 8, p: 1 },
            }),
          ],
        });
        await unrelatedSdk.init();
        await expect(unrelatedSdk.rotateKeys(chainRefId)).rejects.toMatchObject(
          {
            code: CoreErrorCode.UNWRAP_DEK_NO_WRAPPER_MATCHED,
          },
        );
      });
    });
  },
);
