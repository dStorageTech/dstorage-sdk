import { afterEach, describe, expect, it, vi } from "vitest";
import { WebAuthnPrfEncryptionAdapter } from "../WebAuthnPrfEncryptionAdapter.js";
import { EncryptionErrorCode } from "../errors.js";
import { CryptoErrorCode } from "@dstorage/crypto";

// A deterministic fake PRF output so registration + authentication produce
// the same seed, and wrapDek()/unwrapDek() actually round-trip across
// separately-constructed adapter instances. Non-degenerate (not all-same-byte,
// unlike a real WebAuthn PRF output) so it also passes as a raw seed in
// seedDerivation: "raw" mode.
const FAKE_PRF_OUTPUT = Uint8Array.from(
  { length: 32 },
  (_, i) => (i * 7 + 1) % 256,
).buffer;
const FAKE_CREDENTIAL_ID = new Uint8Array([1, 2, 3, 4]).buffer;

interface FakeAuthenticatorOptions {
  prfEnabledAtCreate?: boolean;
  prfResultsAtCreate?: boolean;
  prfProcessedAtGet?: boolean;
  prfResultsAtGet?: boolean;
  capabilities?: Record<string, boolean> | null;
  createImpl?: () => Promise<unknown>;
  getImpl?: () => Promise<unknown>;
}

function stubFakeAuthenticator(opts: FakeAuthenticatorOptions = {}) {
  const {
    prfEnabledAtCreate = true,
    prfResultsAtCreate = true,
    prfProcessedAtGet = true,
    prfResultsAtGet = true,
    capabilities = { "extension:prf": true },
    createImpl,
    getImpl,
  } = opts;

  const create = vi.fn(
    createImpl ??
      (async () => ({
        rawId: FAKE_CREDENTIAL_ID,
        getClientExtensionResults: () => ({
          prf: prfEnabledAtCreate
            ? {
                enabled: true,
                ...(prfResultsAtCreate
                  ? { results: { first: FAKE_PRF_OUTPUT } }
                  : {}),
              }
            : { enabled: false },
        }),
      })),
  );

  const get = vi.fn(
    getImpl ??
      (async () => ({
        rawId: FAKE_CREDENTIAL_ID,
        getClientExtensionResults: () => ({
          ...(prfProcessedAtGet
            ? {
                prf: prfResultsAtGet
                  ? { results: { first: FAKE_PRF_OUTPUT } }
                  : {},
              }
            : {}),
        }),
      })),
  );

  const FakePublicKeyCredential: unknown = capabilities
    ? { getClientCapabilities: async () => capabilities }
    : {};

  vi.stubGlobal("window", {
    PublicKeyCredential: FakePublicKeyCredential,
    location: { hostname: "test.dstorage.local" },
  });
  vi.stubGlobal("navigator", { credentials: { create, get } });
  vi.stubGlobal("PublicKeyCredential", FakePublicKeyCredential);

  return { create, get };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WebAuthnPrfEncryptionAdapter", () => {
  it("register → wrapDek → authenticate → unwrapDek round-trips", async () => {
    stubFakeAuthenticator();
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));

    const writer = await WebAuthnPrfEncryptionAdapter.register();
    expect(writer.name).toBe("webauthn-prf");
    expect(writer.credentialId).toEqual(new Uint8Array(FAKE_CREDENTIAL_ID));

    const wrapped = await writer.wrapDek(dek);

    const reader = await WebAuthnPrfEncryptionAdapter.authenticate([
      writer.credentialId,
    ]);
    const recovered = await reader.unwrapDek(wrapped);
    expect(recovered).toEqual(dek);
  });

  it("two authenticate() calls against the same authenticator interoperate (determinism)", async () => {
    stubFakeAuthenticator();
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));

    const a = await WebAuthnPrfEncryptionAdapter.authenticate([
      new Uint8Array(FAKE_CREDENTIAL_ID),
    ]);
    const b = await WebAuthnPrfEncryptionAdapter.authenticate([
      new Uint8Array(FAKE_CREDENTIAL_ID),
    ]);

    const wrapped = await a.wrapDek(dek);
    const recovered = await b.unwrapDek(wrapped);
    expect(recovered).toEqual(dek);
  });

  describe("isSupported()", () => {
    it("returns true when getClientCapabilities reports extension:prf", async () => {
      stubFakeAuthenticator({ capabilities: { "extension:prf": true } });
      await expect(WebAuthnPrfEncryptionAdapter.isSupported()).resolves.toBe(
        true,
      );
    });

    it("returns false when getClientCapabilities reports no extension:prf", async () => {
      stubFakeAuthenticator({ capabilities: { "extension:prf": false } });
      await expect(WebAuthnPrfEncryptionAdapter.isSupported()).resolves.toBe(
        false,
      );
    });

    it("returns false when window/PublicKeyCredential is unavailable", async () => {
      await expect(WebAuthnPrfEncryptionAdapter.isSupported()).resolves.toBe(
        false,
      );
    });
  });

  it("register() rejects when the authenticator does not support PRF", async () => {
    stubFakeAuthenticator({ prfEnabledAtCreate: false });
    await expect(WebAuthnPrfEncryptionAdapter.register()).rejects.toMatchObject(
      {
        code: EncryptionErrorCode.WEBAUTHN_PRF_UNSUPPORTED_AT_REGISTRATION,
      },
    );
  });

  it("authenticate([]) rejects before touching WebAuthn", async () => {
    const { get } = stubFakeAuthenticator();
    await expect(
      WebAuthnPrfEncryptionAdapter.authenticate([]),
    ).rejects.toMatchObject({
      code: EncryptionErrorCode.WEBAUTHN_PRF_EMPTY_CREDENTIAL_IDS,
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("authenticate() rejects when the PRF extension was not processed", async () => {
    stubFakeAuthenticator({ prfProcessedAtGet: false });
    await expect(
      WebAuthnPrfEncryptionAdapter.authenticate([
        new Uint8Array(FAKE_CREDENTIAL_ID),
      ]),
    ).rejects.toMatchObject({
      code: EncryptionErrorCode.WEBAUTHN_PRF_NOT_PROCESSED,
    });
  });

  it("authenticate() rejects when PRF evaluation returns no output", async () => {
    stubFakeAuthenticator({ prfResultsAtGet: false });
    await expect(
      WebAuthnPrfEncryptionAdapter.authenticate([
        new Uint8Array(FAKE_CREDENTIAL_ID),
      ]),
    ).rejects.toMatchObject({
      code: EncryptionErrorCode.WEBAUTHN_PRF_NO_OUTPUT,
    });
  });

  it("register()/authenticate() reject when WebAuthn is unavailable", async () => {
    await expect(WebAuthnPrfEncryptionAdapter.register()).rejects.toMatchObject(
      {
        code: EncryptionErrorCode.WEBAUTHN_PRF_UNAVAILABLE,
      },
    );
    await expect(
      WebAuthnPrfEncryptionAdapter.authenticate([
        new Uint8Array(FAKE_CREDENTIAL_ID),
      ]),
    ).rejects.toMatchObject({
      code: EncryptionErrorCode.WEBAUTHN_PRF_UNAVAILABLE,
    });
  });

  it("bubbles a raw DOMException (e.g. user cancellation) unwrapped", async () => {
    stubFakeAuthenticator({
      createImpl: async () => {
        throw new DOMException(
          "The operation was cancelled.",
          "NotAllowedError",
        );
      },
    });
    const err = await WebAuthnPrfEncryptionAdapter.register().catch((e) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("NotAllowedError");
    expect((err as { name: string }).name).not.toBe("DStorageError");
  });

  it("register() falls back to a get() ceremony when create() doesn't return PRF output directly", async () => {
    const { get } = stubFakeAuthenticator({ prfResultsAtCreate: false });
    const adapter = await WebAuthnPrfEncryptionAdapter.register();
    expect(get).toHaveBeenCalledTimes(1);

    // The fallback-derived adapter must still be usable and consistent with
    // the same fake authenticator's deterministic PRF output.
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await adapter.wrapDek(dek);
    const other = await WebAuthnPrfEncryptionAdapter.authenticate([
      new Uint8Array(FAKE_CREDENTIAL_ID),
    ]);
    const recovered = await other.unwrapDek(wrapped);
    expect(recovered).toEqual(dek);
  });

  it("intoKeypairEncryptionAdapter() delegates to a working KeypairEncryptionAdapter", async () => {
    stubFakeAuthenticator();
    const adapter = await WebAuthnPrfEncryptionAdapter.register();
    const kp = await adapter.intoKeypairEncryptionAdapter("test-context");
    expect(kp.name).toMatch(/^mlkem/);

    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await kp.wrapDek(dek);
    const recovered = await kp.unwrapDek(wrapped);
    expect(recovered).toEqual(dek);
  });
});

describe("WebAuthnPrfEncryptionAdapter — 3rd-party public-key sharing", () => {
  it("owner shares publicKey; 3rd party wraps via fromPublicKey(); owner decrypts with the SAME authenticate()d adapter", async () => {
    stubFakeAuthenticator();
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));

    const owner = await WebAuthnPrfEncryptionAdapter.register();

    // 3rd party never touches WebAuthn — only needs the raw public key bytes.
    const uploaderAdapter = WebAuthnPrfEncryptionAdapter.fromPublicKey(
      owner.publicKey,
    );
    const wrapped = await uploaderAdapter.wrapDek(dek);

    // Owner re-authenticates later; the single resulting adapter decrypts it —
    // no separate KeypairEncryptionAdapter object needed.
    const reader = await WebAuthnPrfEncryptionAdapter.authenticate([
      owner.credentialId,
    ]);
    const recovered = await reader.unwrapDek(wrapped);
    expect(recovered).toEqual(dek);
  });

  it("the same adapter still decrypts its own direct (symmetric) uploads too", async () => {
    stubFakeAuthenticator();
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const owner = await WebAuthnPrfEncryptionAdapter.register();
    const wrapped = await owner.wrapDek(dek); // self-upload — symmetric path
    const reader = await WebAuthnPrfEncryptionAdapter.authenticate([
      owner.credentialId,
    ]);
    const recovered = await reader.unwrapDek(wrapped);
    expect(recovered).toEqual(dek);
  });

  it("fromPublicKey()'s adapter is upload-only — unwrapDek() throws, no secret key", async () => {
    stubFakeAuthenticator();
    const owner = await WebAuthnPrfEncryptionAdapter.register();
    const uploaderAdapter = WebAuthnPrfEncryptionAdapter.fromPublicKey(
      owner.publicKey,
    );
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await uploaderAdapter.wrapDek(dek);
    await expect(uploaderAdapter.unwrapDek(wrapped)).rejects.toMatchObject({
      code: EncryptionErrorCode.KEYPAIR_MISSING_SECRET_KEY,
    });
  });
});

describe("WebAuthnPrfEncryptionAdapter — configurable derivation", () => {
  it('seedDerivation: "raw" round-trips', async () => {
    stubFakeAuthenticator();
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const owner = await WebAuthnPrfEncryptionAdapter.register({
      seedDerivation: "raw",
    });
    const wrapped = await owner.wrapDek(dek);
    const reader = await WebAuthnPrfEncryptionAdapter.authenticate(
      [owner.credentialId],
      { seedDerivation: "raw" },
    );
    const recovered = await reader.unwrapDek(wrapped);
    expect(recovered).toEqual(dek);
  });

  it('"raw" mode is cryptographically distinct from the default "hkdf-expand" mode', async () => {
    stubFakeAuthenticator();
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const rawOwner = await WebAuthnPrfEncryptionAdapter.register({
      seedDerivation: "raw",
    });
    const wrapped = await rawOwner.wrapDek(dek);
    const defaultReader = await WebAuthnPrfEncryptionAdapter.authenticate([
      rawOwner.credentialId,
    ]);
    await expect(defaultReader.unwrapDek(wrapped)).rejects.toMatchObject({
      code: CryptoErrorCode.XCHACHA_STORAGE_ID_MALFORMED,
    });
  });

  it("seedExpandInfo override round-trips when matching on both sides", async () => {
    stubFakeAuthenticator();
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const customInfo = new TextEncoder().encode("custom:seed-info:v1");
    const owner = await WebAuthnPrfEncryptionAdapter.register({
      seedExpandInfo: customInfo,
    });
    const wrapped = await owner.wrapDek(dek);
    const reader = await WebAuthnPrfEncryptionAdapter.authenticate(
      [owner.credentialId],
      { seedExpandInfo: customInfo },
    );
    const recovered = await reader.unwrapDek(wrapped);
    expect(recovered).toEqual(dek);
  });

  it("seedExpandInfo override is non-interoperable with the default info string", async () => {
    stubFakeAuthenticator();
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const customInfo = new TextEncoder().encode("custom:seed-info:v1");
    const owner = await WebAuthnPrfEncryptionAdapter.register({
      seedExpandInfo: customInfo,
    });
    const wrapped = await owner.wrapDek(dek);
    const defaultReader = await WebAuthnPrfEncryptionAdapter.authenticate([
      owner.credentialId,
    ]);
    await expect(defaultReader.unwrapDek(wrapped)).rejects.toMatchObject({
      code: CryptoErrorCode.XCHACHA_STORAGE_ID_MALFORMED,
    });
  });

  it("shareContext/shareVariant round-trip between register() and fromPublicKey()", async () => {
    stubFakeAuthenticator();
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const owner = await WebAuthnPrfEncryptionAdapter.register({
      shareContext: "custom:share:v1",
    });
    const uploaderAdapter = WebAuthnPrfEncryptionAdapter.fromPublicKey(
      owner.publicKey,
      { shareContext: "custom:share:v1" },
    );
    const wrapped = await uploaderAdapter.wrapDek(dek);
    const reader = await WebAuthnPrfEncryptionAdapter.authenticate(
      [owner.credentialId],
      { shareContext: "custom:share:v1" },
    );
    const recovered = await reader.unwrapDek(wrapped);
    expect(recovered).toEqual(dek);
  });

  it("mismatched shareContext between owner and fromPublicKey() fails to unwrap", async () => {
    stubFakeAuthenticator();
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const owner = await WebAuthnPrfEncryptionAdapter.register({
      shareContext: "custom:share:v1",
    });
    const uploaderAdapter = WebAuthnPrfEncryptionAdapter.fromPublicKey(
      owner.publicKey,
      { shareContext: "a-different-context:v1" },
    );
    const wrapped = await uploaderAdapter.wrapDek(dek);
    const reader = await WebAuthnPrfEncryptionAdapter.authenticate(
      [owner.credentialId],
      { shareContext: "custom:share:v1" },
    );
    await expect(reader.unwrapDek(wrapped)).rejects.toMatchObject({
      code: CryptoErrorCode.XCHACHA_STORAGE_ID_MALFORMED,
    });
  });
});

describe("WebAuthnPrfEncryptionAdapter — discoverable-credential authenticate()", () => {
  it("authenticate([], { discoverable: true }) succeeds and round-trips", async () => {
    stubFakeAuthenticator();
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const owner = await WebAuthnPrfEncryptionAdapter.register();
    const wrapped = await owner.wrapDek(dek);

    const reader = await WebAuthnPrfEncryptionAdapter.authenticate([], {
      discoverable: true,
    });
    const recovered = await reader.unwrapDek(wrapped);
    expect(recovered).toEqual(dek);
  });

  it("discoverable: true omits allowCredentials from the get() call", async () => {
    const { get } = stubFakeAuthenticator();
    await WebAuthnPrfEncryptionAdapter.authenticate([], { discoverable: true });

    const callArgs = (get.mock.calls[0] as unknown as unknown[])[0] as {
      publicKey: { allowCredentials?: unknown };
    };
    expect(callArgs.publicKey.allowCredentials).toBeUndefined();
    expect("allowCredentials" in callArgs.publicKey).toBe(false);
  });

  it("without discoverable, allowCredentials is still populated from credentialIds", async () => {
    const { get } = stubFakeAuthenticator();
    await WebAuthnPrfEncryptionAdapter.authenticate([
      new Uint8Array(FAKE_CREDENTIAL_ID),
    ]);

    const callArgs = (get.mock.calls[0] as unknown as unknown[])[0] as {
      publicKey: { allowCredentials?: unknown[] };
    };
    expect(callArgs.publicKey.allowCredentials).toHaveLength(1);
  });

  it("authenticate([]) without discoverable still throws (unchanged default behavior)", async () => {
    const { get } = stubFakeAuthenticator();
    await expect(
      WebAuthnPrfEncryptionAdapter.authenticate([]),
    ).rejects.toMatchObject({
      code: EncryptionErrorCode.WEBAUTHN_PRF_EMPTY_CREDENTIAL_IDS,
    });
    expect(get).not.toHaveBeenCalled();
  });
});
