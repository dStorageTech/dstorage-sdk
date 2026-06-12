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
import { MockChainAdapter } from "@dstorage/chain";
import {
  PasswordEncryptionAdapter,
  MnemonicEncryptionAdapter,
} from "@dstorage/encryption";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

// ── Shared test constants ─────────────────────────────────────────────────────

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

const passwordProvider = () =>
  new PasswordEncryptionAdapter({
    password: "dstorage-multikey-test-passphrase!",
    salt: "dstorage:multikey:test:v1",
    params: { N: 1024, r: 8, p: 1 },
  });

const mnemonicProvider = () =>
  new MnemonicEncryptionAdapter({ mnemonic: TEST_MNEMONIC });

// ── Helpers ───────────────────────────────────────────────────────────────────

function sharedAdapters() {
  return {
    storageAdapter: new MockStorageAdapter(),
    chainAdapter: new MockChainAdapter(),
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
          params: { N: 1024, r: 8, p: 1 },
        }),
      ],
    });
    await unrelatedSdk.init();

    await expect(unrelatedSdk.retrieveByRefId(chainRefId)).rejects.toThrow();
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

    await expect(mnemonicSdk.retrieveByRefId(chainRefId)).rejects.toThrow();
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
