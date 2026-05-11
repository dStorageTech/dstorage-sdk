/**
 * Asymmetric ML-KEM encryption provider tests.
 *
 * Verifies that MLKemEncryptionProvider can be used alongside symmetric
 * providers in the encryptionSeedProviders list, and that the upload/retrieve
 * flow works correctly with PK-only upload and SK-based retrieval.
 */

import { describe, it, expect } from "vitest";
import { DStorage } from "../dStorage.js";
import { MockStorageAdapter } from "@dstorage/storage";
import { MockChainAdapter } from "@dstorage/chain";
import {
  MLKemEncryptionProvider,
  PasswordSeedProvider,
} from "@dstorage/seed-providers";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function sharedAdapters() {
  return {
    storageAdapter: new MockStorageAdapter(),
    chainAdapter: new MockChainAdapter(),
  };
}

// ── Basic asymmetric upload / retrieve ────────────────────────────────────────

describe("ML-KEM upload and retrieve", () => {
  it("upload with full keypair provider, retrieve with same provider", async () => {
    const adapters = sharedAdapters();
    const { provider } = MLKemEncryptionProvider.generateKeypair();

    const sdk = new DStorage({
      ...adapters,
      encryptionSeedProviders: [provider],
    });
    await sdk.init();

    const content = "post-quantum encrypted content";
    const { chainRefId } = await sdk.upload(enc(content));
    const { bytes } = await sdk.retrieveByRefId(chainRefId);
    expect(dec(bytes)).toBe(content);
  });

  it("upload with PK-only provider, retrieve with SK provider", async () => {
    const adapters = sharedAdapters();
    const { publicKey, secretKey } = MLKemEncryptionProvider.generateKeypair();

    // Uploader: only has PK
    const uploaderSdk = new DStorage({
      ...adapters,
      encryptionSeedProviders: [
        MLKemEncryptionProvider.fromPublicKey(publicKey),
      ],
    });
    await uploaderSdk.init();

    const content = "sealed for PQ recipient";
    const { chainRefId } = await uploaderSdk.upload(enc(content));

    // Retriever: has both PK + SK
    const readerSdk = new DStorage({
      ...adapters,
      encryptionSeedProviders: [
        MLKemEncryptionProvider.fromKeypair(publicKey, secretKey),
      ],
    });
    await readerSdk.init();

    const { bytes } = await readerSdk.retrieveByRefId(chainRefId);
    expect(dec(bytes)).toBe(content);
  });

  it("PK-only provider cannot retrieve (no SK)", async () => {
    const adapters = sharedAdapters();
    const { publicKey } = MLKemEncryptionProvider.generateKeypair();

    const sdk = new DStorage({
      ...adapters,
      encryptionSeedProviders: [
        MLKemEncryptionProvider.fromPublicKey(publicKey),
      ],
    });
    await sdk.init();

    const { chainRefId } = await sdk.upload(enc("secret"));

    // PK-only retriever
    const pkOnlySdk = new DStorage({
      ...adapters,
      encryptionSeedProviders: [
        MLKemEncryptionProvider.fromPublicKey(publicKey),
      ],
    });
    await pkOnlySdk.init();

    await expect(pkOnlySdk.retrieveByRefId(chainRefId)).rejects.toThrow();
  });

  it("fromPassword: deterministic keypair enables round-trip", async () => {
    const FAST_PARAMS = { N: 1024, r: 8, p: 1 };
    const adapters = sharedAdapters();

    const writerProvider = await MLKemEncryptionProvider.fromPassword(
      "Str0ng-PaSSw0rd!XY9",
      "dstorage:test:asym:v1",
      "mlkem768",
      FAST_PARAMS,
    );
    const readerProvider = await MLKemEncryptionProvider.fromPassword(
      "Str0ng-PaSSw0rd!XY9",
      "dstorage:test:asym:v1",
      "mlkem768",
      FAST_PARAMS,
    );

    const uploaderSdk = new DStorage({
      ...adapters,
      encryptionSeedProviders: [writerProvider],
    });
    await uploaderSdk.init();

    const content = "password-derived PQ keypair";
    const { chainRefId } = await uploaderSdk.upload(enc(content));

    const readerSdk = new DStorage({
      ...adapters,
      encryptionSeedProviders: [readerProvider],
    });
    await readerSdk.init();

    const { bytes } = await readerSdk.retrieveByRefId(chainRefId);
    expect(dec(bytes)).toBe(content);
  });
});

// ── Mixed symmetric + asymmetric envelope ─────────────────────────────────────

describe("mixed symmetric + asymmetric envelope", () => {
  it("either provider alone can retrieve content uploaded with both", async () => {
    const adapters = sharedAdapters();
    const {
      provider: mlkemProvider,
      publicKey,
      secretKey,
    } = MLKemEncryptionProvider.generateKeypair();
    const passwordProvider = new PasswordSeedProvider({
      password: "dstorage-asym-test-passphrase!",
      salt: "dstorage:asym:test:v1",
      params: { N: 1024, r: 8, p: 1 },
    });

    // Upload with both providers
    const uploaderSdk = new DStorage({
      ...adapters,
      encryptionSeedProviders: [mlkemProvider, passwordProvider],
    });
    await uploaderSdk.init();

    const content = "multi-key post-quantum content";
    const { chainRefId } = await uploaderSdk.upload(enc(content));

    // Retrieve with only ML-KEM
    const mlkemSdk = new DStorage({
      ...adapters,
      encryptionSeedProviders: [
        MLKemEncryptionProvider.fromKeypair(publicKey, secretKey),
      ],
    });
    await mlkemSdk.init();
    const byMlkem = await mlkemSdk.retrieveByRefId(chainRefId);
    expect(dec(byMlkem.bytes)).toBe(content);

    // Retrieve with only password
    const passwordSdk = new DStorage({
      ...adapters,
      encryptionSeedProviders: [
        new PasswordSeedProvider({
          password: "dstorage-asym-test-passphrase!",
          salt: "dstorage:asym:test:v1",
          params: { N: 1024, r: 8, p: 1 },
        }),
      ],
    });
    await passwordSdk.init();
    const byPassword = await passwordSdk.retrieveByRefId(chainRefId);
    expect(dec(byPassword.bytes)).toBe(content);
  });

  it("envelope has one wrapper per provider", async () => {
    const adapters = sharedAdapters();
    const { provider: mlkemProvider } =
      MLKemEncryptionProvider.generateKeypair();
    const passwordProvider = new PasswordSeedProvider({
      password: "dstorage-asym-test-passphrase!",
      salt: "dstorage:asym:test:v1",
      params: { N: 1024, r: 8, p: 1 },
    });

    const sdk = new DStorage({
      ...adapters,
      encryptionSeedProviders: [mlkemProvider, passwordProvider],
    });
    await sdk.init();

    const { chainRefId } = await sdk.upload(enc("envelope check"));
    const ref = await adapters.chainAdapter.readReference(chainRefId);
    const envelope = JSON.parse(ref.keyEnvelope);

    expect(envelope.v).toBe(1);
    expect(envelope.wrappers).toHaveLength(2);
    // ML-KEM wrapper has kemCiphertext; symmetric does not
    const mlkemWrapper = envelope.wrappers[0];
    expect(mlkemWrapper.kemCiphertext).toBeDefined();
    expect(mlkemWrapper.algorithm).toMatch(/^mlkem/);
    const symWrapper = envelope.wrappers[1];
    expect(symWrapper.kemCiphertext).toBeUndefined();
    expect(symWrapper.algorithm).toBe("xchacha20poly1305-v1");
  });

  it("unrelated provider cannot decrypt content from mixed envelope", async () => {
    const adapters = sharedAdapters();
    const { provider: mlkemProvider } =
      MLKemEncryptionProvider.generateKeypair();

    const sdk = new DStorage({
      ...adapters,
      encryptionSeedProviders: [mlkemProvider],
    });
    await sdk.init();

    const { chainRefId } = await sdk.upload(enc("secret"));

    // Different ML-KEM keypair — cannot unwrap
    const { provider: otherProvider } =
      MLKemEncryptionProvider.generateKeypair();
    const otherSdk = new DStorage({
      ...adapters,
      encryptionSeedProviders: [otherProvider],
    });
    await otherSdk.init();

    await expect(otherSdk.retrieveByRefId(chainRefId)).rejects.toThrow();
  });
});
