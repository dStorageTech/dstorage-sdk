/**
 * KeypairEncryptionAdapter tests.
 *
 * Verifies that KeypairEncryptionAdapter can be used alongside symmetric
 * adapters in the encryptionAdapters list, and that the upload/retrieve
 * flow works correctly with PK-only upload and SK-based retrieval.
 */

import { describe, it, expect } from "vitest";
import { DStorage } from "../dStorage.js";
import { MockStorageAdapter } from "@dstorage/storage";
import { MockChainAdapter } from "@dstorage/chain";
import {
  KeypairEncryptionAdapter,
  PasswordEncryptionAdapter,
} from "@dstorage/encryption";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const CTX = "test-context";

function sharedAdapters() {
  return {
    storageAdapter: new MockStorageAdapter(),
    chainAdapter: new MockChainAdapter(),
  };
}

// ── Basic asymmetric upload / retrieve ────────────────────────────────────────

describe("ML-KEM upload and retrieve", () => {
  it("upload with full keypair adapter, retrieve with same adapter", async () => {
    const adapters = sharedAdapters();
    const { adapter } = KeypairEncryptionAdapter.generateKeypair(CTX);

    const sdk = new DStorage({
      ...adapters,
      encryptionAdapters: [adapter],
    });
    await sdk.init();

    const content = "post-quantum encrypted content";
    const { chainRefId } = await sdk.upload(enc(content));
    const { bytes } = await sdk.retrieveByRefId(chainRefId);
    expect(dec(bytes)).toBe(content);
  });

  it("upload with PK-only adapter, retrieve with SK adapter", async () => {
    const adapters = sharedAdapters();
    const { publicKey, secretKey } =
      KeypairEncryptionAdapter.generateKeypair(CTX);

    // Uploader: only has PK
    const uploaderSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [
        KeypairEncryptionAdapter.fromPublicKey(publicKey, CTX),
      ],
    });
    await uploaderSdk.init();

    const content = "sealed for PQ recipient";
    const { chainRefId } = await uploaderSdk.upload(enc(content));

    // Retriever: has both PK + SK
    const readerSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [
        KeypairEncryptionAdapter.fromKeypair(publicKey, secretKey, CTX),
      ],
    });
    await readerSdk.init();

    const { bytes } = await readerSdk.retrieveByRefId(chainRefId);
    expect(dec(bytes)).toBe(content);
  });

  it("PK-only adapter cannot retrieve (no SK)", async () => {
    const adapters = sharedAdapters();
    const { publicKey } = KeypairEncryptionAdapter.generateKeypair(CTX);

    const sdk = new DStorage({
      ...adapters,
      encryptionAdapters: [
        KeypairEncryptionAdapter.fromPublicKey(publicKey, CTX),
      ],
    });
    await sdk.init();

    const { chainRefId } = await sdk.upload(enc("secret"));

    // PK-only retriever
    const pkOnlySdk = new DStorage({
      ...adapters,
      encryptionAdapters: [
        KeypairEncryptionAdapter.fromPublicKey(publicKey, CTX),
      ],
    });
    await pkOnlySdk.init();

    await expect(pkOnlySdk.retrieveByRefId(chainRefId)).rejects.toThrow();
  });

  it("fromPassword: deterministic keypair enables round-trip", async () => {
    const FAST_PARAMS = { N: 1024, r: 8, p: 1 };
    const adapters = sharedAdapters();

    const writerProvider = await KeypairEncryptionAdapter.fromPassword(
      "Str0ng-PaSSw0rd!XY9",
      "dstorage:test:asym:v1",
      CTX,
      "mlkem768",
      FAST_PARAMS,
    );
    const readerProvider = await KeypairEncryptionAdapter.fromPassword(
      "Str0ng-PaSSw0rd!XY9",
      "dstorage:test:asym:v1",
      CTX,
      "mlkem768",
      FAST_PARAMS,
    );

    const uploaderSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [writerProvider],
    });
    await uploaderSdk.init();

    const content = "password-derived PQ keypair";
    const { chainRefId } = await uploaderSdk.upload(enc(content));

    const readerSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [readerProvider],
    });
    await readerSdk.init();

    const { bytes } = await readerSdk.retrieveByRefId(chainRefId);
    expect(dec(bytes)).toBe(content);
  });
});

// ── Mixed symmetric + asymmetric envelope ─────────────────────────────────────

describe("mixed symmetric + asymmetric envelope", () => {
  it("either adapter alone can retrieve content uploaded with both", async () => {
    const adapters = sharedAdapters();
    const {
      adapter: keypairAdapter,
      publicKey,
      secretKey,
    } = KeypairEncryptionAdapter.generateKeypair(CTX);
    const passwordProvider = new PasswordEncryptionAdapter({
      password: "dstorage-asym-test-passphrase!",
      salt: "dstorage:asym:test:v1",
      params: { N: 1024, r: 8, p: 1 },
    });

    // Upload with both adapters
    const uploaderSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [keypairAdapter, passwordProvider],
    });
    await uploaderSdk.init();

    const content = "multi-key post-quantum content";
    const { chainRefId } = await uploaderSdk.upload(enc(content));

    // Retrieve with only ML-KEM
    const mlkemSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [
        KeypairEncryptionAdapter.fromKeypair(publicKey, secretKey, CTX),
      ],
    });
    await mlkemSdk.init();
    const byMlkem = await mlkemSdk.retrieveByRefId(chainRefId);
    expect(dec(byMlkem.bytes)).toBe(content);

    // Retrieve with only password
    const passwordSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
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

  it("envelope has one wrapper per adapter", async () => {
    const adapters = sharedAdapters();
    const { adapter: keypairAdapter } =
      KeypairEncryptionAdapter.generateKeypair(CTX);
    const passwordProvider = new PasswordEncryptionAdapter({
      password: "dstorage-asym-test-passphrase!",
      salt: "dstorage:asym:test:v1",
      params: { N: 1024, r: 8, p: 1 },
    });

    const sdk = new DStorage({
      ...adapters,
      encryptionAdapters: [keypairAdapter, passwordProvider],
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

  it("unrelated adapter cannot decrypt content from mixed envelope", async () => {
    const adapters = sharedAdapters();
    const { adapter: keypairAdapter } =
      KeypairEncryptionAdapter.generateKeypair(CTX);

    const sdk = new DStorage({
      ...adapters,
      encryptionAdapters: [keypairAdapter],
    });
    await sdk.init();

    const { chainRefId } = await sdk.upload(enc("secret"));

    // Different ML-KEM keypair — cannot unwrap
    const { adapter: otherAdapter } =
      KeypairEncryptionAdapter.generateKeypair(CTX);
    const otherSdk = new DStorage({
      ...adapters,
      encryptionAdapters: [otherAdapter],
    });
    await otherSdk.init();

    await expect(otherSdk.retrieveByRefId(chainRefId)).rejects.toThrow();
  });
});
