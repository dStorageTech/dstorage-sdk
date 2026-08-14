/**
 * Multi-key wrapping tests.
 *
 * Verifies that a single encrypted upload can be independently decrypted by
 * two different seed providers — one PasswordEncryptionAdapter and one
 * MnemonicEncryptionAdapter — each holding their own Key Encryption Key (KEK) that
 * wraps the same per-upload DEK.
 *
 * All tests use fast scrypt params (N=1024) and the standard mock adapters so
 * no external services are required.
 */

import { describe, it, expect } from "vitest";
import { DStorage } from "../dStorage.js";
import { MockStorageAdapter } from "@dstorage/storage";
import { MidnightSimulatorChainAdapter } from "@dstorage/chain";
import {
  PasswordEncryptionAdapter,
  MnemonicEncryptionAdapter,
} from "@dstorage/encryption";
import { CoreErrorCode } from "../errors.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

// ── Shared test constants ─────────────────────────────────────────────────────

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

const passwordProvider = () =>
  new PasswordEncryptionAdapter({
    password: "dstorage-multikey-test-passphrase!",
    salt: "dstorage:multikey:test:v1",
    params: { N: 32768, r: 8, p: 1 },
  });

const mnemonicProvider = () =>
  new MnemonicEncryptionAdapter({ mnemonic: TEST_MNEMONIC });

// ── Helpers ───────────────────────────────────────────────────────────────────

function sharedAdapters() {
  return {
    storageAdapter: new MockStorageAdapter(),
    chainAdapter: new MidnightSimulatorChainAdapter(),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("multi-key wrapping — upload with two providers", () => {
  it("content uploaded with two providers can be retrieved by either one", async () => {
    const adapters = sharedAdapters();

    // Upload with BOTH providers in encryptionAdapters.
    const uploader = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider(), mnemonicProvider()],
    });
    await uploader.init();

    const content = "secret health record";
    const { chainRefId } = await uploader.store(enc(content));

    // Retrieve using only the PasswordEncryptionAdapter.
    const passwordSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider()],
    });
    await passwordSdk.init();
    const byPassword = await passwordSdk.retrieveByRefId(chainRefId);
    expect(dec(byPassword.bytes)).toBe(content);

    // Retrieve using only the MnemonicEncryptionAdapter.
    const mnemonicSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [mnemonicProvider()],
    });
    await mnemonicSdk.init();
    const byMnemonic = await mnemonicSdk.retrieveByRefId(chainRefId);
    expect(dec(byMnemonic.bytes)).toBe(content);
  });

  it("key envelope contains two wrappers per key set — one per provider", async () => {
    const adapters = sharedAdapters();
    const uploader = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider(), mnemonicProvider()],
    });
    await uploader.init();

    const { chainRefId } = await uploader.store(enc("envelope check"));

    const ref = await adapters.chainAdapter.readReference(chainRefId);
    expect(ref).not.toBeNull();
    const envelope = JSON.parse(ref!.keyEnvelope!);
    expect(envelope.v).toBe(1);
    // wrappers: one per provider (data DEK wrapped under each KEK)
    expect(envelope.wrappers).toHaveLength(2);
    expect(envelope.wrappers[0].wrapKeyName).toBe("password");
    expect(envelope.wrappers[1].wrapKeyName).toBe("mnemonic");
    // ownerWrappers no longer exists — ownerSecret is derived from the DEK
    expect(envelope.ownerWrappers).toBeUndefined();
  });

  it("a third SDK with an unrelated key cannot decrypt the content", async () => {
    const adapters = sharedAdapters();
    const uploader = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider(), mnemonicProvider()],
    });
    await uploader.init();

    const { chainRefId } = await uploader.store(enc("private content"));

    const unrelatedSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "completely-different-passphrase!",
          salt: "dstorage:multikey:test:v1",
          params: { N: 32768, r: 8, p: 1 },
        }),
      ],
    });
    await unrelatedSdk.init();

    await expect(
      unrelatedSdk.retrieveByRefId(chainRefId),
    ).rejects.toMatchObject({
      code: CoreErrorCode.DECRYPT_NO_WRAPPER_MATCHED,
    });
  });

  it("both providers independently decrypt the same bytes", async () => {
    const adapters = sharedAdapters();
    const uploader = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider(), mnemonicProvider()],
    });
    await uploader.init();

    const content = "identical content check";
    const { chainRefId } = await uploader.store(enc(content));

    const passwordSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider()],
    });
    const mnemonicSdk = new DStorage({
      ...adapters,
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

  it("single-provider upload is still decryptable by that provider", async () => {
    const adapters = sharedAdapters();
    const sdk = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider()],
    });
    await sdk.init();

    const content = "single key content";
    const { chainRefId } = await sdk.store(enc(content));
    const { bytes } = await sdk.retrieveByRefId(chainRefId);
    expect(dec(bytes)).toBe(content);
  });

  it("single-provider upload cannot be decrypted by a different provider", async () => {
    const adapters = sharedAdapters();

    const passwordSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider()],
    });
    await passwordSdk.init();

    const { chainRefId } = await passwordSdk.store(enc("password-only"));

    const mnemonicSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [mnemonicProvider()],
    });
    await mnemonicSdk.init();

    await expect(mnemonicSdk.retrieveByRefId(chainRefId)).rejects.toMatchObject(
      {
        code: CoreErrorCode.DECRYPT_NO_WRAPPER_MATCHED,
      },
    );
  });

  it("multiple uploads each get independent DEKs (different envelopes)", async () => {
    const adapters = sharedAdapters();
    const uploader = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider(), mnemonicProvider()],
    });
    await uploader.init();

    const { chainRefId: ref1 } = await uploader.store(enc("upload one"));
    const { chainRefId: ref2 } = await uploader.store(enc("upload two"));

    const r1 = await adapters.chainAdapter.readReference(ref1);
    const r2 = await adapters.chainAdapter.readReference(ref2);

    // Each upload has its own key envelope — the wrapped DEKs differ.
    expect(r1!.keyEnvelope).not.toBe(r2!.keyEnvelope);
  });
});

// ── public upload — ownerSeed envelope ───────────────────────────────────────

describe("public upload — ownerSeed envelope", () => {
  it("public upload generates a non-empty keyEnvelope containing wrapped ownerSeed", async () => {
    const adapters = sharedAdapters();
    const sdk = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider()],
    });
    await sdk.init();

    const { chainRefId } = await sdk.store(enc("public content"), {
      isPublic: true,
    });
    const ref = await adapters.chainAdapter.readReference(chainRefId);

    expect(ref.keyEnvelope).toBeTruthy();
    const envelope = JSON.parse(ref.keyEnvelope);
    expect(envelope.v).toBe(1);
    expect(Array.isArray(envelope.wrappers)).toBe(true);
    expect(envelope.wrappers).toHaveLength(1);
    expect(envelope.wrappers[0].wrapKeyName).toBe("password");
  });

  it("envelope has one wrapper per provider for a multi-KEK public upload", async () => {
    const adapters = sharedAdapters();
    const sdk = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider(), mnemonicProvider()],
    });
    await sdk.init();

    const { chainRefId } = await sdk.store(enc("multi-kek public"), {
      isPublic: true,
    });
    const ref = await adapters.chainAdapter.readReference(chainRefId);

    const envelope = JSON.parse(ref.keyEnvelope);
    expect(envelope.wrappers).toHaveLength(2);
    expect(envelope.wrappers[0].wrapKeyName).toBe("password");
    expect(envelope.wrappers[1].wrapKeyName).toBe("mnemonic");
  });

  it("each public upload gets an independent ownerSeed (different envelopes)", async () => {
    const adapters = sharedAdapters();
    const sdk = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider()],
    });
    await sdk.init();

    const { chainRefId: ref1 } = await sdk.store(enc("public one"), {
      isPublic: true,
    });
    const { chainRefId: ref2 } = await sdk.store(enc("public two"), {
      isPublic: true,
    });

    const r1 = await adapters.chainAdapter.readReference(ref1);
    const r2 = await adapters.chainAdapter.readReference(ref2);
    expect(r1.keyEnvelope).not.toBe(r2.keyEnvelope);
  });

  it("password-only SDK can removeReference a public upload made with two providers", async () => {
    const adapters = sharedAdapters();
    const uploader = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider(), mnemonicProvider()],
    });
    await uploader.init();
    const { chainRefId } = await uploader.store(enc("public removable"), {
      isPublic: true,
    });

    const passwordSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider()],
    });
    await passwordSdk.init();

    await expect(
      passwordSdk.removeReference(chainRefId),
    ).resolves.toBeUndefined();
    const refs = await passwordSdk.listReferences();
    expect(refs.find((r) => r.refId === chainRefId)).toBeUndefined();
  });

  it("mnemonic-only SDK can removeReference a public upload made with two providers", async () => {
    const adapters = sharedAdapters();
    const uploader = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider(), mnemonicProvider()],
    });
    await uploader.init();
    const { chainRefId } = await uploader.store(enc("public removable 2"), {
      isPublic: true,
    });

    const mnemonicSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [mnemonicProvider()],
    });
    await mnemonicSdk.init();

    await expect(
      mnemonicSdk.removeReference(chainRefId),
    ).resolves.toBeUndefined();
  });
});

// ── update — adding an encryption adapter ─────────────────────────────────────

describe("update — adding an encryption adapter", () => {
  it("update with an added mnemonic adapter expands the key envelope to two wrappers", async () => {
    const adapters = sharedAdapters();

    const storeSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider()],
    });
    await storeSdk.init();
    const { chainRefId } = await storeSdk.store(enc("v1 content"));

    const v1Ref = await adapters.chainAdapter.readReference(chainRefId);
    const v1Envelope = JSON.parse(v1Ref!.keyEnvelope!);
    expect(v1Envelope.wrappers).toHaveLength(1);
    expect(v1Envelope.wrappers[0].wrapKeyName).toBe("password");

    const updateSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider(), mnemonicProvider()],
    });
    await updateSdk.init();
    const result = await updateSdk.update(chainRefId, enc("v2 content"));

    expect(result.chainRefId).toBe(chainRefId);

    const v2Ref = await adapters.chainAdapter.readReference(chainRefId);
    const v2Envelope = JSON.parse(v2Ref!.keyEnvelope!);
    expect(v2Envelope.wrappers).toHaveLength(2);
    expect(v2Envelope.wrappers[0].wrapKeyName).toBe("password");
    expect(v2Envelope.wrappers[1].wrapKeyName).toBe("mnemonic");
  });

  it("after update both adapters independently retrieve v2 content", async () => {
    const adapters = sharedAdapters();

    const storeSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider()],
    });
    await storeSdk.init();
    const { chainRefId } = await storeSdk.store(enc("v1 content"));

    const updateSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider(), mnemonicProvider()],
    });
    await updateSdk.init();
    const v2 = enc("v2 content — updated");
    await updateSdk.update(chainRefId, v2);

    const passwordSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider()],
    });
    await passwordSdk.init();
    const byPassword = await passwordSdk.retrieveByRefId(chainRefId);
    expect(dec(byPassword.bytes)).toBe("v2 content — updated");

    const mnemonicSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [mnemonicProvider()],
    });
    await mnemonicSdk.init();
    const byMnemonic = await mnemonicSdk.retrieveByRefId(chainRefId);
    expect(byMnemonic.bytes).toEqual(v2);
  });

  it("password-only SDK can update a reference it originally stored, adding a mnemonic adapter", async () => {
    const adapters = sharedAdapters();

    const storeSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider()],
    });
    await storeSdk.init();
    const { chainRefId } = await storeSdk.store(enc("v1 content"));

    const updateSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider(), mnemonicProvider()],
    });
    await updateSdk.init();
    const result = await updateSdk.update(chainRefId, enc("v2 content"));

    expect(result.chainRefId).toBe(chainRefId);
  });
});

// ── removeReference via any KEK ───────────────────────────────────────────────

describe("removeReference via any available KEK", () => {
  it("password-only SDK can removeReference an upload made with two providers", async () => {
    // _computeOwnerSecret unwraps the DEK — any matching KEK suffices.
    const adapters = sharedAdapters();
    const uploader = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider(), mnemonicProvider()],
    });
    await uploader.init();

    const { chainRefId } = await uploader.store(enc("removable by password"));

    const passwordSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider()],
    });
    await passwordSdk.init();

    // Should succeed: password KEK can unwrap the DEK → derive ownerSecret
    await expect(
      passwordSdk.removeReference(chainRefId),
    ).resolves.toBeUndefined();

    // Ref is gone
    const refs = await passwordSdk.listReferences();
    expect(refs.find((r) => r.refId === chainRefId)).toBeUndefined();
  });

  it("mnemonic-only SDK can removeReference an upload made with two providers", async () => {
    const adapters = sharedAdapters();
    const uploader = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider(), mnemonicProvider()],
    });
    await uploader.init();

    const { chainRefId } = await uploader.store(enc("removable by mnemonic"));

    const mnemonicSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [mnemonicProvider()],
    });
    await mnemonicSdk.init();

    // Should succeed: mnemonic KEK can unwrap the DEK → derive ownerSecret
    await expect(
      mnemonicSdk.removeReference(chainRefId),
    ).resolves.toBeUndefined();
  });
});

// ── rotateKeys — password rotation via mnemonic recovery ───────────────────────────

const newPasswordProvider = () =>
  new PasswordEncryptionAdapter({
    password: "dstorage-NEW-passphrase-after-rotation!",
    salt: "dstorage:multikey:test:v1",
    params: { N: 32768, r: 8, p: 1 },
  });

describe("rotateKeys — password rotation via mnemonic recovery", () => {
  it("mnemonic adapter alone can authorise rotateKeys to a new password", async () => {
    const adapters = sharedAdapters();
    const storeSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider(), mnemonicProvider()],
    });
    await storeSdk.init();
    const content = "secret record";
    const { chainRefId } = await storeSdk.store(enc(content));

    const rotateKeysSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [newPasswordProvider(), mnemonicProvider()],
    });
    await rotateKeysSdk.init();
    await expect(rotateKeysSdk.rotateKeys(chainRefId)).resolves.toBeUndefined();

    const newPasswordSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [newPasswordProvider()],
    });
    await newPasswordSdk.init();
    const byNewPassword = await newPasswordSdk.retrieveByRefId(chainRefId);
    expect(dec(byNewPassword.bytes)).toBe(content);

    const mnemonicSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [mnemonicProvider()],
    });
    await mnemonicSdk.init();
    const byMnemonic = await mnemonicSdk.retrieveByRefId(chainRefId);
    expect(dec(byMnemonic.bytes)).toBe(content);
  });

  it("after rotateKeys: new password decrypts, old password cannot, mnemonic still can", async () => {
    const adapters = sharedAdapters();
    const storeSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider(), mnemonicProvider()],
    });
    await storeSdk.init();
    const content = "sensitive data";
    const { chainRefId } = await storeSdk.store(enc(content));

    const rotateKeysSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [newPasswordProvider(), mnemonicProvider()],
    });
    await rotateKeysSdk.init();
    await rotateKeysSdk.rotateKeys(chainRefId);

    const newPasswordSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [newPasswordProvider()],
    });
    await newPasswordSdk.init();
    const byNewPassword = await newPasswordSdk.retrieveByRefId(chainRefId);
    expect(dec(byNewPassword.bytes)).toBe(content);

    const mnemonicSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [mnemonicProvider()],
    });
    await mnemonicSdk.init();
    const byMnemonic = await mnemonicSdk.retrieveByRefId(chainRefId);
    expect(dec(byMnemonic.bytes)).toBe(content);

    const oldPasswordSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider()],
    });
    await oldPasswordSdk.init();
    await expect(
      oldPasswordSdk.retrieveByRefId(chainRefId),
    ).rejects.toMatchObject({
      code: CoreErrorCode.DECRYPT_NO_WRAPPER_MATCHED,
    });
  });

  it("rotateKeys replaces the key envelope wrappers, content bytes are unchanged", async () => {
    const adapters = sharedAdapters();
    const storeSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider(), mnemonicProvider()],
    });
    await storeSdk.init();
    const content = "immutable content";
    const { chainRefId } = await storeSdk.store(enc(content));

    const rotateKeysSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [newPasswordProvider(), mnemonicProvider()],
    });
    await rotateKeysSdk.init();
    await rotateKeysSdk.rotateKeys(chainRefId);

    const ref = await adapters.chainAdapter.readReference(chainRefId);
    const envelope = JSON.parse(ref!.keyEnvelope!);
    expect(envelope.wrappers).toHaveLength(2);
    expect(envelope.wrappers[0].wrapKeyName).toBe("password");
    expect(envelope.wrappers[1].wrapKeyName).toBe("mnemonic");

    const newPasswordSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [newPasswordProvider()],
    });
    await newPasswordSdk.init();
    const byNewPassword = await newPasswordSdk.retrieveByRefId(chainRefId);
    expect(dec(byNewPassword.bytes)).toBe(content);

    const mnemonicSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [mnemonicProvider()],
    });
    await mnemonicSdk.init();
    const byMnemonic = await mnemonicSdk.retrieveByRefId(chainRefId);
    expect(dec(byMnemonic.bytes)).toBe(content);
  });

  it("throws ROTATE_KEYS_REQUIRES_CHAIN when no chain adapter is configured", async () => {
    const ds = new DStorage({
      storageAdapter: new MockStorageAdapter(),
      encryptionAdapters: [passwordProvider()],
    });
    await ds.init();
    await expect(ds.rotateKeys("refId")).rejects.toMatchObject({
      code: CoreErrorCode.ROTATE_KEYS_REQUIRES_CHAIN,
    });
  });

  it("throws ROTATE_KEYS_REQUIRES_ENCRYPTION when no encryption adapters are configured", async () => {
    const ds = new DStorage({
      storageAdapter: new MockStorageAdapter(),
      chainAdapter: new MidnightSimulatorChainAdapter(),
    });
    await ds.init();
    await expect(ds.rotateKeys("refId")).rejects.toMatchObject({
      code: CoreErrorCode.ROTATE_KEYS_REQUIRES_ENCRYPTION,
    });
  });

  it("throws when no configured adapter matches any wrapper in the old envelope", async () => {
    const adapters = sharedAdapters();
    const storeSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider()],
    });
    await storeSdk.init();
    const { chainRefId } = await storeSdk.store(enc("content"));

    const unrelatedSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "completely-different-passphrase!",
          salt: "dstorage:multikey:test:v1",
          params: { N: 32768, r: 8, p: 1 },
        }),
      ],
    });
    await unrelatedSdk.init();
    await expect(unrelatedSdk.rotateKeys(chainRefId)).rejects.toMatchObject({
      code: CoreErrorCode.UNWRAP_DEK_NO_WRAPPER_MATCHED,
    });
  });
});

// ── same-named adapter collision ────────────────────────────────────────────
//
// Multiple configured providers can share the same `.name` — e.g. two
// MnemonicEncryptionAdapter instances during a seed-rotation window, or two
// PasswordEncryptionAdapter instances during a password-rotation window. A
// name match on a wrapper doesn't guarantee that specific provider holds the
// KEK for that wrapper, so the SDK must try every same-named candidate
// against a wrapper before giving up on it — not just the first one found.

// A second, distinct seed for MnemonicEncryptionAdapter, via seedHex to avoid
// needing a second checksummed BIP-39 phrase. 32 non-uniform bytes.
const OTHER_SEED_HEX = "0123456789abcdef".repeat(4);

const otherMnemonicProvider = () =>
  new MnemonicEncryptionAdapter({ seedHex: OTHER_SEED_HEX });

describe("same-named adapter collision — mnemonic", () => {
  it("retrieve succeeds when the matching adapter is first in the array", async () => {
    const adapters = sharedAdapters();
    const storeSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [mnemonicProvider()],
    });
    await storeSdk.init();
    const content = "rotated-seed content";
    const { chainRefId } = await storeSdk.store(enc(content));

    const retrieveSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [mnemonicProvider(), otherMnemonicProvider()],
    });
    await retrieveSdk.init();
    const result = await retrieveSdk.retrieveByRefId(chainRefId);
    expect(dec(result.bytes)).toBe(content);
  });

  it("retrieve succeeds when the matching adapter is NOT first in the array", async () => {
    const adapters = sharedAdapters();
    const storeSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [mnemonicProvider()],
    });
    await storeSdk.init();
    const content = "rotated-seed content, wrong order";
    const { chainRefId } = await storeSdk.store(enc(content));

    // The provider that can actually decrypt this reference (mnemonicProvider)
    // is listed second, behind a same-named provider (otherMnemonicProvider)
    // that cannot. Before the fix, name-based `.find()` always resolved to the
    // first same-named provider and never retried with the second.
    const retrieveSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [otherMnemonicProvider(), mnemonicProvider()],
    });
    await retrieveSdk.init();
    const result = await retrieveSdk.retrieveByRefId(chainRefId);
    expect(dec(result.bytes)).toBe(content);
  });

  it("rotateKeys with old and new same-named mnemonic adapters configured together works regardless of order", async () => {
    const adapters = sharedAdapters();
    const storeSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [mnemonicProvider()],
    });
    await storeSdk.init();
    const content = "content protected by rotated mnemonic";
    const { chainRefId } = await storeSdk.store(enc(content));

    // Documented rotateKeys pattern: configure both the old and new adapters
    // together so the old one can authorise the rotation. Both are
    // MnemonicEncryptionAdapter instances, so both share name "mnemonic".
    const rotateKeysSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [mnemonicProvider(), otherMnemonicProvider()],
    });
    await rotateKeysSdk.init();
    await expect(rotateKeysSdk.rotateKeys(chainRefId)).resolves.toBeUndefined();

    // New seed alone must now decrypt it.
    const newOnlySdk = new DStorage({
      ...adapters,
      encryptionAdapters: [otherMnemonicProvider()],
    });
    await newOnlySdk.init();
    const byNew = await newOnlySdk.retrieveByRefId(chainRefId);
    expect(dec(byNew.bytes)).toBe(content);

    // A fresh SDK with the new adapter listed FIRST (wrong-order relative to
    // the store-time array) must also succeed post-fix.
    const wrongOrderSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [otherMnemonicProvider(), mnemonicProvider()],
    });
    await wrongOrderSdk.init();
    const byWrongOrder = await wrongOrderSdk.retrieveByRefId(chainRefId);
    expect(dec(byWrongOrder.bytes)).toBe(content);
  });
});

describe("same-named adapter collision — password", () => {
  it("retrieve succeeds when the matching password adapter is NOT first in the array", async () => {
    const adapters = sharedAdapters();
    const storeSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [passwordProvider()],
    });
    await storeSdk.init();
    const content = "rotated-password content, wrong order";
    const { chainRefId } = await storeSdk.store(enc(content));

    // newPasswordProvider() and passwordProvider() both have name "password".
    // The one that can actually decrypt (passwordProvider) is listed second.
    const retrieveSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [newPasswordProvider(), passwordProvider()],
    });
    await retrieveSdk.init();
    const result = await retrieveSdk.retrieveByRefId(chainRefId);
    expect(dec(result.bytes)).toBe(content);
  });
});
