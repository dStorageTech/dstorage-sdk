/**
 * WebAuthnPrfEncryptionAdapter core-level tests.
 *
 * Verifies WebAuthnPrfEncryptionAdapter works end-to-end through DStorage's
 * store()/retrieve() cycle: register() -> store, authenticate() -> retrieve,
 * and the 3rd-party public-key-sharing flow via fromPublicKey() — proven
 * through DStorage's real envelope/wrapper machinery, not just the adapter's
 * own isolated dispatch logic (already covered by
 * packages/encryption/src/__tests__/WebAuthnPrfEncryptionAdapter.test.ts).
 *
 * The WebAuthn ceremony is faked via vi.stubGlobal — same technique used by
 * the adapter's own unit tests — since no real browser is available here.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { DStorage } from "../dStorage.js";
import { CoreErrorCode } from "../errors.js";
import { MockStorageAdapter } from "@dstorage/storage";
import { MidnightSimulatorChainAdapter } from "@dstorage/chain";
import { WebAuthnPrfEncryptionAdapter } from "@dstorage/encryption";

// ── Fake WebAuthn authenticator ─────────────────────────────────────────────

const FAKE_PRF_OUTPUT = Uint8Array.from(
  { length: 32 },
  (_, i) => (i * 7 + 1) % 256,
).buffer;
const FAKE_CREDENTIAL_ID = new Uint8Array([1, 2, 3, 4]).buffer;

const OTHER_PRF_OUTPUT = Uint8Array.from(
  { length: 32 },
  (_, i) => (i * 11 + 3) % 256,
).buffer;
const OTHER_CREDENTIAL_ID = new Uint8Array([5, 6, 7, 8]).buffer;

function stubFakeAuthenticator(
  prfOutput: ArrayBuffer = FAKE_PRF_OUTPUT,
  credentialId: ArrayBuffer = FAKE_CREDENTIAL_ID,
) {
  const create = vi.fn(async () => ({
    rawId: credentialId,
    getClientExtensionResults: () => ({
      prf: { enabled: true, results: { first: prfOutput } },
    }),
  }));
  const get = vi.fn(async () => ({
    rawId: credentialId,
    getClientExtensionResults: () => ({
      prf: { results: { first: prfOutput } },
    }),
  }));
  const FakePublicKeyCredential = {
    getClientCapabilities: async () => ({ "extension:prf": true }),
  };
  vi.stubGlobal("window", {
    PublicKeyCredential: FakePublicKeyCredential,
    location: { hostname: "test.dstorage.local" },
    // Stubbing `window` at all flips `typeof window !== "undefined"` checks
    // elsewhere (e.g. the Midnight WASM simulator's glue code) from their
    // normal Node branch to a browser branch that expects window.crypto —
    // preserve it so unrelated code paths keep working.
    crypto: globalThis.crypto,
  });
  vi.stubGlobal("navigator", { credentials: { create, get } });
  vi.stubGlobal("PublicKeyCredential", FakePublicKeyCredential);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function sharedAdapters() {
  return {
    storageAdapter: new MockStorageAdapter(),
    chainAdapter: new MidnightSimulatorChainAdapter(),
  };
}

describe("WebAuthnPrfEncryptionAdapter — DStorage store/retrieve round trip", () => {
  it("register() -> store, authenticate() -> retrieve", async () => {
    stubFakeAuthenticator();
    const adapters = sharedAdapters();
    const owner = await WebAuthnPrfEncryptionAdapter.register();

    const uploaderSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [owner],
    });
    await uploaderSdk.init();

    const content = "webauthn-prf self-upload round trip";
    const { chainRefId } = await uploaderSdk.store(enc(content));

    const readerSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [
        await WebAuthnPrfEncryptionAdapter.authenticate([owner.credentialId]),
      ],
    });
    await readerSdk.init();

    const { bytes } = await readerSdk.retrieveByRefId(chainRefId);
    expect(dec(bytes)).toBe(content);
  });

  it("3rd party fromPublicKey() upload, owner authenticate() retrieves", async () => {
    stubFakeAuthenticator();
    const adapters = sharedAdapters();
    const owner = await WebAuthnPrfEncryptionAdapter.register();

    const uploaderSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [
        WebAuthnPrfEncryptionAdapter.fromPublicKey(owner.publicKey),
      ],
    });
    await uploaderSdk.init();

    const content = "shared-pk upload for webauthn-prf owner";
    const { chainRefId } = await uploaderSdk.store(enc(content));

    const readerSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [
        await WebAuthnPrfEncryptionAdapter.authenticate([owner.credentialId]),
      ],
    });
    await readerSdk.init();

    const { bytes } = await readerSdk.retrieveByRefId(chainRefId);
    expect(dec(bytes)).toBe(content);
  });

  it("envelope wrappers share wrapKeyName 'webauthn-prf' but differ in shape (symmetric vs ML-KEM)", async () => {
    stubFakeAuthenticator();
    const adapters = sharedAdapters();
    const owner = await WebAuthnPrfEncryptionAdapter.register();

    // Self-upload — symmetric wrapper.
    const ownerSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [owner],
    });
    await ownerSdk.init();
    const { chainRefId: selfRefId } = await ownerSdk.store(enc("self"));
    const selfRef = await adapters.chainAdapter.readReference(selfRefId);
    const selfEnvelope = JSON.parse(selfRef.keyEnvelope);
    expect(selfEnvelope.wrappers).toHaveLength(1);
    expect(selfEnvelope.wrappers[0].wrapKeyName).toBe("webauthn-prf");
    expect(selfEnvelope.wrappers[0].kemCiphertext).toBeUndefined();
    expect(selfEnvelope.wrappers[0].algorithm).toBe("xchacha20poly1305-v1");

    // 3rd-party shared-key upload — ML-KEM wrapper, same wrapKeyName.
    const uploaderSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [
        WebAuthnPrfEncryptionAdapter.fromPublicKey(owner.publicKey),
      ],
    });
    await uploaderSdk.init();
    const { chainRefId: sharedRefId } = await uploaderSdk.store(enc("shared"));
    const sharedRef = await adapters.chainAdapter.readReference(sharedRefId);
    const sharedEnvelope = JSON.parse(sharedRef.keyEnvelope);
    expect(sharedEnvelope.wrappers).toHaveLength(1);
    expect(sharedEnvelope.wrappers[0].wrapKeyName).toBe("webauthn-prf");
    expect(sharedEnvelope.wrappers[0].kemCiphertext).toBeDefined();
    expect(sharedEnvelope.wrappers[0].algorithm).toMatch(/^mlkem/);
  });

  it("unrelated authenticate() (different credential) cannot retrieve", async () => {
    stubFakeAuthenticator();
    const adapters = sharedAdapters();
    const owner = await WebAuthnPrfEncryptionAdapter.register();

    const uploaderSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [owner],
    });
    await uploaderSdk.init();
    const { chainRefId } = await uploaderSdk.store(enc("private"));

    // A different physical passkey — different fake credential/PRF output.
    stubFakeAuthenticator(OTHER_PRF_OUTPUT, OTHER_CREDENTIAL_ID);
    const unrelated = await WebAuthnPrfEncryptionAdapter.authenticate([
      new Uint8Array(OTHER_CREDENTIAL_ID),
    ]);

    const unrelatedSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [unrelated],
    });
    await unrelatedSdk.init();

    await expect(
      unrelatedSdk.retrieveByRefId(chainRefId),
    ).rejects.toMatchObject({
      code: CoreErrorCode.DECRYPT_NO_WRAPPER_MATCHED,
    });
  });
});

// ── same-named adapter collision ────────────────────────────────────────────
//
// Every WebAuthnPrfEncryptionAdapter instance has `.name === "webauthn-prf"`
// regardless of which passkey identity registered it — so two different
// registered identities share the same provider name.

describe("same-named adapter collision — webauthn-prf", () => {
  it("retrieve succeeds when the matching adapter is NOT first in the array", async () => {
    stubFakeAuthenticator();
    const adapters = sharedAdapters();
    const owner = await WebAuthnPrfEncryptionAdapter.register();

    const uploaderSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [owner],
    });
    await uploaderSdk.init();
    const content = "webauthn-prf collision content";
    const { chainRefId } = await uploaderSdk.store(enc(content));

    // A second, distinct passkey identity — register() eagerly derives and
    // caches its key material, so this adapter works independently of which
    // fake authenticator is stubbed afterwards.
    stubFakeAuthenticator(OTHER_PRF_OUTPUT, OTHER_CREDENTIAL_ID);
    const otherOwner = await WebAuthnPrfEncryptionAdapter.register();
    expect(otherOwner.name).toBe(owner.name);

    // otherOwner (cannot decrypt this reference) is listed first; owner
    // (can) is listed second, both sharing name "webauthn-prf".
    const retrieveSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [otherOwner, owner],
    });
    await retrieveSdk.init();
    const { bytes } = await retrieveSdk.retrieveByRefId(chainRefId);
    expect(dec(bytes)).toBe(content);
  });
});
