/**
 * WebAuthnPrfEncryptionAdapter integration tests — real arlocal storage +
 * mock chain.
 *
 * The WebAuthn ceremony itself is faked (vi.stubGlobal, same technique used
 * by the adapter's own unit tests in
 * packages/encryption/src/__tests__/WebAuthnPrfEncryptionAdapter.test.ts) —
 * no browser-automation infrastructure exists in this repo to drive a real
 * navigator.credentials ceremony. What this suite adds over the core-level
 * mock tests (packages/core/src/__tests__/webAuthnPrf.test.ts) is a REAL
 * storage round trip: actual HTTP calls to arlocal, real chunking and
 * serialization, not an in-memory mock.
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

import { afterEach, describe, it, expect, beforeAll, vi } from "vitest";
import { DStorage, CoreErrorCode } from "@dstorage/core";
import { MidnightSimulatorChainAdapter } from "@dstorage/chain";
import { WebAuthnPrfEncryptionAdapter } from "@dstorage/encryption";
import { readEnv } from "./helpers/env.js";
import { checkArlocal, createStorageAdapter } from "./helpers/arlocal.js";
import type { ArweaveLocalStorageAdapter } from "@dstorage/storage";

const env = readEnv();
const arlocalOk = await checkArlocal(env.arlocalUrl);

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

// ── Fake WebAuthn authenticator (same technique as packages/encryption's own
//    unit tests — no real browser-automation infra exists in this repo) ──────

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

describe.skipIf(!arlocalOk)(
  "WebAuthnPrfEncryptionAdapter — arlocal storage + mock chain",
  () => {
    let storageAdapter: ArweaveLocalStorageAdapter;
    let chainAdapter: MidnightSimulatorChainAdapter;

    beforeAll(async () => {
      const { adapter } = await createStorageAdapter(env.arlocalUrl);
      storageAdapter = adapter;
      chainAdapter = new MidnightSimulatorChainAdapter({ logger: console });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("register() -> store on real arlocal; authenticate() -> retrieve", async () => {
      stubFakeAuthenticator();
      const owner = await WebAuthnPrfEncryptionAdapter.register();

      const uploaderSdk = new DStorage({
        storageAdapter,
        chainAdapter,
        encryptionAdapters: [owner],
      });
      await uploaderSdk.init();

      const content = "integration: webauthn-prf arlocal round trip";
      const { chainRefId } = await uploaderSdk.store(enc(content));

      const readerSdk = new DStorage({
        storageAdapter,
        chainAdapter,
        encryptionAdapters: [
          await WebAuthnPrfEncryptionAdapter.authenticate([owner.credentialId]),
        ],
      });
      await readerSdk.init();

      const { bytes } = await readerSdk.retrieveByRefId(chainRefId);
      expect(dec(bytes)).toBe(content);
    });

    it("3rd party fromPublicKey() upload on real arlocal; owner authenticate() retrieves", async () => {
      stubFakeAuthenticator();
      const owner = await WebAuthnPrfEncryptionAdapter.register();

      const uploaderSdk = new DStorage({
        storageAdapter,
        chainAdapter,
        encryptionAdapters: [
          WebAuthnPrfEncryptionAdapter.fromPublicKey(owner.publicKey),
        ],
      });
      await uploaderSdk.init();

      const content = "integration: shared-pk arlocal round trip";
      const { chainRefId } = await uploaderSdk.store(enc(content));

      const readerSdk = new DStorage({
        storageAdapter,
        chainAdapter,
        encryptionAdapters: [
          await WebAuthnPrfEncryptionAdapter.authenticate([owner.credentialId]),
        ],
      });
      await readerSdk.init();

      const { bytes } = await readerSdk.retrieveByRefId(chainRefId);
      expect(dec(bytes)).toBe(content);
    });

    it("unrelated credential cannot decrypt", async () => {
      stubFakeAuthenticator();
      const owner = await WebAuthnPrfEncryptionAdapter.register();

      const uploaderSdk = new DStorage({
        storageAdapter,
        chainAdapter,
        encryptionAdapters: [owner],
      });
      await uploaderSdk.init();
      const { chainRefId } = await uploaderSdk.store(
        enc("integration: unrelated credential rejected"),
      );

      stubFakeAuthenticator(OTHER_PRF_OUTPUT, OTHER_CREDENTIAL_ID);
      const unrelated = await WebAuthnPrfEncryptionAdapter.authenticate([
        new Uint8Array(OTHER_CREDENTIAL_ID),
      ]);

      const unrelatedSdk = new DStorage({
        storageAdapter,
        chainAdapter,
        encryptionAdapters: [unrelated],
      });
      await unrelatedSdk.init();

      await expect(
        unrelatedSdk.retrieveByRefId(chainRefId),
      ).rejects.toMatchObject({
        code: CoreErrorCode.DECRYPT_NO_WRAPPER_MATCHED,
      });
    });
  },
);
