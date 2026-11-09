import { describe, it, expect, beforeEach } from "vitest";
import {
  encodeContractAddress,
  convertBigintToBytes,
} from "@midnight-ntwrk/compact-runtime";
import { pureCircuits } from "../../dataregistry/managed/contract/index.js";
import { DataRegistrySimulator } from "./dataregistry-simulator.js";
import {
  randomBytes,
  randomCoinPublicKeyHex,
  randomString,
  randomTimestamp,
} from "./utils.js";
import {
  SUPPORTED_CONTRACT_VERSION,
  validateContractVersion,
} from "../../../src/contract-api.js";

type TestUser = {
  secretKey: Uint8Array;
  pk: string;
};

const randomUser = (): TestUser => ({
  secretKey: randomBytes(32),
  pk: randomCoinPublicKeyHex(),
});

const randomEntry = () => ({
  storageId: randomString(32),
  encryptionScheme: "xchacha20poly1305-v1",
  storageProvider: "arweave",
  metadata: "document",
  writtenAt: randomTimestamp(),
});

describe("DataRegistry contract", () => {
  let owner: TestUser;
  let other: TestUser;
  let simulator: DataRegistrySimulator;

  beforeEach(async () => {
    owner = randomUser();
    other = randomUser();
    simulator = await DataRegistrySimulator.create(owner.pk);
  });

  describe("initial state", () => {
    it("starts with an empty references map", async () => {
      expect(simulator.getLedger().references.isEmpty()).toBe(true);
      expect(simulator.getLedger().references.size()).toBe(0n);
    });

    it("starts with refCounter at 1", async () => {
      // Counter is initialised to 1 in the constructor
      expect(simulator.getLedger().refCounter).toBe(1n);
    });

    it("has contractVersion equal to SUPPORTED_CONTRACT_VERSION", async () => {
      expect(simulator.getLedger().contractVersion).toBe(
        SUPPORTED_CONTRACT_VERSION,
      );
    });
  });

  describe("contract version validation", () => {
    it("validateContractVersion accepts the current contract version", async () => {
      const version = simulator.getLedger().contractVersion;
      expect(() =>
        validateContractVersion(version, "0xTestContract"),
      ).not.toThrow();
    });

    it("validateContractVersion throws for an unsupported version", async () => {
      expect(() =>
        validateContractVersion(
          SUPPORTED_CONTRACT_VERSION + 1n,
          "0xTestContract",
        ),
      ).toThrow("Unsupported contract version");
    });

    it("validateContractVersion error includes the version number and address", async () => {
      const addr = "0xDeadBeef";
      expect(() => validateContractVersion(99n, addr)).toThrow(addr);
      expect(() => validateContractVersion(99n, addr)).toThrow("99");
    });

    it("contractVersion is immutable — stays at SUPPORTED_CONTRACT_VERSION after all circuit calls", async () => {
      const entry = randomEntry();
      const refId = await simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
      );
      expect(simulator.getLedger().contractVersion).toBe(
        SUPPORTED_CONTRACT_VERSION,
      );

      await simulator.updateReference(
        refId,
        randomString(),
        "",
        "ipfs",
        "updated",
        randomTimestamp(),
      );
      expect(simulator.getLedger().contractVersion).toBe(
        SUPPORTED_CONTRACT_VERSION,
      );

      await simulator.removeReference(refId);
      expect(simulator.getLedger().contractVersion).toBe(
        SUPPORTED_CONTRACT_VERSION,
      );
    });
  });

  describe("storeReference", () => {
    it("stores a reference and returns a non-zero refId", async () => {
      const entry = randomEntry();
      const refId = await simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
      );

      expect(refId).toBeInstanceOf(Uint8Array);
      expect(refId.length).toBe(32);
      expect(refId.every((b) => b === 0)).toBe(false);
    });

    it("adds the entry to the references map", async () => {
      const entry = randomEntry();
      const refId = await simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
      );

      const ledger = simulator.getLedger();
      expect(ledger.references.size()).toBe(1n);
      expect(ledger.references.member(refId)).toBe(true);

      const stored = ledger.references.lookup(refId);
      expect(stored.storageId).toBe(entry.storageId);
      expect(stored.encryptionScheme).toBe(entry.encryptionScheme);
      expect(stored.storageProvider).toBe(entry.storageProvider);
      expect(stored.metadata).toBe(entry.metadata);
      expect(stored.writtenAt).toBe(entry.writtenAt);
    });

    it("increments refCounter after each store", async () => {
      expect(simulator.getLedger().refCounter).toBe(1n);

      const entry = randomEntry();
      await simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
      );

      expect(simulator.getLedger().refCounter).toBe(2n);

      await simulator.storeReference(
        randomString(),
        "",
        "ipfs",
        "",
        randomTimestamp(),
      );

      expect(simulator.getLedger().refCounter).toBe(3n);
    });

    it("generates unique refIds for successive stores", async () => {
      const entry1 = randomEntry();
      const entry2 = randomEntry();

      const refId1 = await simulator.storeReference(
        entry1.storageId,
        entry1.encryptionScheme,
        entry1.storageProvider,
        entry1.metadata,
        entry1.writtenAt,
      );
      const refId2 = await simulator.storeReference(
        entry2.storageId,
        entry2.encryptionScheme,
        entry2.storageProvider,
        entry2.metadata,
        entry2.writtenAt,
      );

      expect(Buffer.from(refId1).toString("hex")).not.toBe(
        Buffer.from(refId2).toString("hex"),
      );
    });

    it("allows multiple users to store references independently", async () => {
      const entry1 = randomEntry();
      const refId1 = await simulator.storeReference(
        entry1.storageId,
        entry1.encryptionScheme,
        entry1.storageProvider,
        entry1.metadata,
        entry1.writtenAt,
      );

      simulator.switchUser(other.pk);
      const entry2 = randomEntry();
      const refId2 = await simulator.storeReference(
        entry2.storageId,
        entry2.encryptionScheme,
        entry2.storageProvider,
        entry2.metadata,
        entry2.writtenAt,
      );

      const ledger = simulator.getLedger();
      expect(ledger.references.size()).toBe(2n);
      expect(ledger.references.member(refId1)).toBe(true);
      expect(ledger.references.member(refId2)).toBe(true);
    });

    it("stores public (unencrypted) references with empty encryptionScheme", async () => {
      const refId = await simulator.storeReference(
        "arweave-tx-id-abc123",
        "",
        "arweave",
        "public",
        randomTimestamp(),
      );

      const stored = simulator.getLedger().references.lookup(refId);
      expect(stored.encryptionScheme).toBe("");
    });
  });

  describe("removeReference", () => {
    it("removes a reference stored by the owner", async () => {
      const entry = randomEntry();
      const refId = await simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
      );

      expect(simulator.getLedger().references.member(refId)).toBe(true);

      await simulator.removeReference(refId);

      expect(simulator.getLedger().references.member(refId)).toBe(false);
      expect(simulator.getLedger().references.size()).toBe(0n);
    });

    it("throws when trying to remove a non-existent reference", async () => {
      const nonExistentRefId = randomBytes(32);
      await expect(simulator.removeReference(nonExistentRefId)).rejects.toThrow(
        "Reference not found",
      );
    });

    it("throws when a non-owner tries to remove another user's reference", async () => {
      const entry = randomEntry();
      // Owner stores with their secret
      const refId = await simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
        "",
        new Uint8Array(32),
        owner.secretKey,
      );

      // Switch to a different user and try to remove with a different secret
      simulator.switchUser(other.pk);

      await expect(
        simulator.removeReference(refId, other.secretKey),
      ).rejects.toThrow("Not the owner");
    });

    it("removes only the targeted reference, leaving others intact", async () => {
      const entry1 = randomEntry();
      const entry2 = randomEntry();
      const refId1 = await simulator.storeReference(
        entry1.storageId,
        entry1.encryptionScheme,
        entry1.storageProvider,
        entry1.metadata,
        entry1.writtenAt,
      );
      const refId2 = await simulator.storeReference(
        entry2.storageId,
        entry2.encryptionScheme,
        entry2.storageProvider,
        entry2.metadata,
        entry2.writtenAt,
      );

      await simulator.removeReference(refId1);

      const ledger = simulator.getLedger();
      expect(ledger.references.member(refId1)).toBe(false);
      expect(ledger.references.member(refId2)).toBe(true);
      expect(ledger.references.size()).toBe(1n);
    });
  });

  describe("updateReference", () => {
    it("updates all mutable fields of a reference", async () => {
      const entry = randomEntry();
      const refId = await simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
      );

      const newStorageId = randomString(32);
      const newEncryptionScheme = "ml-kem-768+xchacha20poly1305-v1";
      const newProvider = "ipfs";
      const newLabel = "updated-label";
      const newTimestamp = randomTimestamp();

      await simulator.updateReference(
        refId,
        newStorageId,
        newEncryptionScheme,
        newProvider,
        newLabel,
        newTimestamp,
      );

      const updated = simulator.getLedger().references.lookup(refId);
      expect(updated.storageId).toBe(newStorageId);
      expect(updated.encryptionScheme).toBe(newEncryptionScheme);
      expect(updated.storageProvider).toBe(newProvider);
      expect(updated.metadata).toBe(newLabel);
      expect(updated.writtenAt).toBe(newTimestamp);
    });

    it("preserves the ownerCommitment after update", async () => {
      const entry = randomEntry();
      const refId = await simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
      );

      const originalCommitment = simulator
        .getLedger()
        .references.lookup(refId).ownerCommitment;

      await simulator.updateReference(
        refId,
        randomString(),
        "",
        "ipfs",
        "new-label",
        randomTimestamp(),
      );

      const updatedCommitment = simulator
        .getLedger()
        .references.lookup(refId).ownerCommitment;

      expect(Buffer.from(updatedCommitment).toString("hex")).toBe(
        Buffer.from(originalCommitment).toString("hex"),
      );
    });

    it("throws when trying to update a non-existent reference", async () => {
      const nonExistentRefId = randomBytes(32);
      await expect(
        simulator.updateReference(
          nonExistentRefId,
          randomString(),
          "",
          "arweave",
          "",
          randomTimestamp(),
        ),
      ).rejects.toThrow("Reference not found");
    });

    it("throws when a non-owner tries to update another user's reference", async () => {
      const entry = randomEntry();
      // Owner stores with their secret
      const refId = await simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
        "",
        new Uint8Array(32),
        owner.secretKey,
      );

      simulator.switchUser(other.pk);

      await expect(
        simulator.updateReference(
          refId,
          randomString(),
          "",
          "ipfs",
          "hijacked",
          randomTimestamp(),
          "",
          new Uint8Array(32),
          other.secretKey,
        ),
      ).rejects.toThrow("Not the owner");
    });

    it("allows the owner to update their reference after another user stored a separate one", async () => {
      // Owner stores a reference with an explicit secret so it can be re-used after the user switch.
      const ownerEntry = randomEntry();
      const ownerRefId = await simulator.storeReference(
        ownerEntry.storageId,
        ownerEntry.encryptionScheme,
        ownerEntry.storageProvider,
        ownerEntry.metadata,
        ownerEntry.writtenAt,
        "",
        new Uint8Array(32),
        owner.secretKey,
      );

      // Other user stores their own reference
      simulator.switchUser(other.pk);
      const otherEntry = randomEntry();
      await simulator.storeReference(
        otherEntry.storageId,
        otherEntry.encryptionScheme,
        otherEntry.storageProvider,
        otherEntry.metadata,
        otherEntry.writtenAt,
      );

      // Owner switches back and updates their own reference using the same secret.
      simulator.switchUser(owner.pk);
      const newStorageId = randomString();
      await simulator.updateReference(
        ownerRefId,
        newStorageId,
        "",
        "arweave",
        "updated",
        randomTimestamp(),
        "",
        new Uint8Array(32),
        owner.secretKey,
      );

      const updated = simulator.getLedger().references.lookup(ownerRefId);
      expect(updated.storageId).toBe(newStorageId);
    });
  });

  describe("pure circuit verification", () => {
    it("returned refId matches deriveRefId(refCounter, contractAddress)", async () => {
      const instanceSalt = encodeContractAddress(simulator.contractAddress);

      // Capture the counter value before the store — the circuit uses it as-is
      const counterBefore = simulator.getLedger().refCounter;
      const counterBytes = convertBigintToBytes(32, counterBefore, "test");
      const expectedRefId = pureCircuits.deriveRefId(
        counterBytes,
        instanceSalt,
      );

      const entry = randomEntry();
      const actualRefId = await simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
      );

      expect(Buffer.from(actualRefId).toString("hex")).toBe(
        Buffer.from(expectedRefId).toString("hex"),
      );
    });

    it("verifies deriveRefId for successive stores (counter increments each time)", async () => {
      const instanceSalt = encodeContractAddress(simulator.contractAddress);
      const entry = randomEntry();

      for (let i = 0; i < 3; i++) {
        const counterBefore = simulator.getLedger().refCounter;
        const expectedRefId = pureCircuits.deriveRefId(
          convertBigintToBytes(32, counterBefore, "test"),
          instanceSalt,
        );

        const actualRefId = await simulator.storeReference(
          randomString(),
          entry.encryptionScheme,
          entry.storageProvider,
          entry.metadata,
          randomTimestamp(),
        );

        expect(Buffer.from(actualRefId).toString("hex")).toBe(
          Buffer.from(expectedRefId).toString("hex"),
        );
      }
    });

    it("stored ownerCommitment matches computeOwnerCommitment(ownerSecret, refId, contractAddress)", async () => {
      const instanceSalt = encodeContractAddress(simulator.contractAddress);
      const ownerSecret = owner.secretKey; // 32-byte witness secret

      const entry = randomEntry();
      const refId = await simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
        "",
        new Uint8Array(32),
        ownerSecret,
      );

      // The contract uses refId as the nonce in computeOwnerCommitment
      const expectedCommitment = simulator.computeOwnerCommitment(
        ownerSecret,
        refId,
        instanceSalt,
      );

      const storedCommitment = simulator
        .getLedger()
        .references.lookup(refId).ownerCommitment;

      expect(Buffer.from(storedCommitment).toString("hex")).toBe(
        Buffer.from(expectedCommitment).toString("hex"),
      );
    });

    it("ownerCommitment changes when a different ownerSecret is used", async () => {
      const instanceSalt = encodeContractAddress(simulator.contractAddress);
      const entry = randomEntry();

      // Owner stores with their secret
      const ownerSecret = owner.secretKey;
      const refId1 = await simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
        "",
        new Uint8Array(32),
        ownerSecret,
      );

      // Other user stores with a different secret
      const otherSecret = other.secretKey;
      simulator.switchUser(other.pk);
      const refId2 = await simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
        "",
        new Uint8Array(32),
        otherSecret,
      );

      // Verify both commitments match what computeOwnerCommitment produces for each secret
      const ownerCommitment = simulator.computeOwnerCommitment(
        ownerSecret,
        refId1,
        instanceSalt,
      );
      const otherCommitment = simulator.computeOwnerCommitment(
        otherSecret,
        refId2,
        instanceSalt,
      );

      expect(
        Buffer.from(
          simulator.getLedger().references.lookup(refId1).ownerCommitment,
        ).toString("hex"),
      ).toBe(Buffer.from(ownerCommitment).toString("hex"));

      expect(
        Buffer.from(
          simulator.getLedger().references.lookup(refId2).ownerCommitment,
        ).toString("hex"),
      ).toBe(Buffer.from(otherCommitment).toString("hex"));
    });
  });

  describe("keyEnvelope", () => {
    it("stores and retrieves a non-empty keyEnvelope", async () => {
      const entry = randomEntry();
      const envelope =
        '{"kdf":"scrypt","N":131072,"r":8,"p":1,"wrappedDek":"abc123"}';
      const refId = await simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
        envelope,
      );

      const stored = simulator.getLedger().references.lookup(refId);
      expect(stored.keyEnvelope).toBe(envelope);
    });

    it("stores empty keyEnvelope for public (unencrypted) uploads", async () => {
      const refId = await simulator.storeReference(
        "arweave-tx-id-abc123",
        "",
        "arweave",
        "public-doc",
        randomTimestamp(),
        "",
      );

      const stored = simulator.getLedger().references.lookup(refId);
      expect(stored.keyEnvelope).toBe("");
    });

    it("defaults keyEnvelope to empty string when not supplied", async () => {
      const entry = randomEntry();
      const refId = await simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
      );

      const stored = simulator.getLedger().references.lookup(refId);
      expect(stored.keyEnvelope).toBe("");
    });

    it("updateReference replaces keyEnvelope with a new value", async () => {
      const entry = randomEntry();
      const originalEnvelope = '{"kdf":"scrypt","wrappedDek":"original"}';
      const refId = await simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
        originalEnvelope,
      );

      const newEnvelope = '{"kdf":"scrypt","wrappedDek":"rotated"}';
      await simulator.updateReference(
        refId,
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
        newEnvelope,
      );

      const updated = simulator.getLedger().references.lookup(refId);
      expect(updated.keyEnvelope).toBe(newEnvelope);
    });

    it("updateReference can clear keyEnvelope by setting it to empty string", async () => {
      const entry = randomEntry();
      const refId = await simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
        '{"kdf":"scrypt","wrappedDek":"abc"}',
      );

      await simulator.updateReference(
        refId,
        entry.storageId,
        "",
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
        "",
      );

      const updated = simulator.getLedger().references.lookup(refId);
      expect(updated.keyEnvelope).toBe("");
    });

    it("two references store independent keyEnvelopes", async () => {
      const envelope1 = '{"kdf":"scrypt","wrappedDek":"first"}';
      const envelope2 = '{"kdf":"scrypt","wrappedDek":"second"}';

      const entry1 = randomEntry();
      const entry2 = randomEntry();

      const refId1 = await simulator.storeReference(
        entry1.storageId,
        entry1.encryptionScheme,
        entry1.storageProvider,
        entry1.metadata,
        entry1.writtenAt,
        envelope1,
      );
      const refId2 = await simulator.storeReference(
        entry2.storageId,
        entry2.encryptionScheme,
        entry2.storageProvider,
        entry2.metadata,
        entry2.writtenAt,
        envelope2,
      );

      expect(simulator.getLedger().references.lookup(refId1).keyEnvelope).toBe(
        envelope1,
      );
      expect(simulator.getLedger().references.lookup(refId2).keyEnvelope).toBe(
        envelope2,
      );
    });

    it("updating one reference's keyEnvelope does not affect another's", async () => {
      const envelope1 = '{"kdf":"scrypt","wrappedDek":"first"}';
      const envelope2 = '{"kdf":"scrypt","wrappedDek":"second"}';

      const entry1 = randomEntry();
      const entry2 = randomEntry();

      const refId1 = await simulator.storeReference(
        entry1.storageId,
        entry1.encryptionScheme,
        entry1.storageProvider,
        entry1.metadata,
        entry1.writtenAt,
        envelope1,
      );
      const refId2 = await simulator.storeReference(
        entry2.storageId,
        entry2.encryptionScheme,
        entry2.storageProvider,
        entry2.metadata,
        entry2.writtenAt,
        envelope2,
      );

      await simulator.updateReference(
        refId1,
        entry1.storageId,
        entry1.encryptionScheme,
        entry1.storageProvider,
        entry1.metadata,
        entry1.writtenAt,
        '{"kdf":"scrypt","wrappedDek":"rotated"}',
      );

      expect(simulator.getLedger().references.lookup(refId2).keyEnvelope).toBe(
        envelope2,
      );
    });
  });

  describe("zero-secret rejection", () => {
    let validSecret: Uint8Array;

    beforeEach(async () => {
      validSecret = randomBytes(32);
    });

    it("storeReference rejects an all-zeros ownerSecret", async () => {
      const entry = randomEntry();
      await expect(
        simulator.storeReference(
          entry.storageId,
          entry.encryptionScheme,
          entry.storageProvider,
          entry.metadata,
          entry.writtenAt,
          "",
          new Uint8Array(32), // contentHash (zeros OK)
          new Uint8Array(32), // ownerSecret (zeros must be rejected)
        ),
      ).rejects.toThrow("ownerSecret must not be zero");
    });

    it("removeReference rejects an all-zeros ownerSecret", async () => {
      const refId = await simulator.storeReference(
        randomString(32),
        "xchacha20poly1305-v1",
        "arweave",
        "doc",
        randomTimestamp(),
        "",
        new Uint8Array(32),
        validSecret,
      );
      await expect(
        simulator.removeReference(refId, new Uint8Array(32)),
      ).rejects.toThrow("ownerSecret must not be zero");
    });

    it("updateReference rejects an all-zeros ownerSecret", async () => {
      const refId = await simulator.storeReference(
        randomString(32),
        "xchacha20poly1305-v1",
        "arweave",
        "doc",
        randomTimestamp(),
        "",
        new Uint8Array(32),
        validSecret,
      );
      await expect(
        simulator.updateReference(
          refId,
          randomString(),
          "",
          "arweave",
          "",
          randomTimestamp(),
          "",
          new Uint8Array(32), // contentHash (zeros OK)
          new Uint8Array(32), // ownerSecret (zeros must be rejected)
        ),
      ).rejects.toThrow("ownerSecret must not be zero");
    });

    it("updateReference rejects an all-zeros newOwnerSecret", async () => {
      const refId = await simulator.storeReference(
        randomString(32),
        "xchacha20poly1305-v1",
        "arweave",
        "doc",
        randomTimestamp(),
        "",
        new Uint8Array(32),
        validSecret,
      );
      await expect(
        simulator.updateReference(
          refId,
          randomString(),
          "",
          "arweave",
          "",
          randomTimestamp(),
          "",
          new Uint8Array(32), // contentHash
          validSecret,
          new Uint8Array(32), // newOwnerSecret (zeros must be rejected)
        ),
      ).rejects.toThrow("newOwnerSecret must not be zero");
    });

    it("updateReference throws when newOwnerSecret is absent from private state", async () => {
      const refId = await simulator.storeReference(
        randomString(32),
        "xchacha20poly1305-v1",
        "arweave",
        "doc",
        randomTimestamp(),
        "",
        new Uint8Array(32),
        validSecret,
      );
      await expect(
        simulator.contract.impureCircuits.updateReference(
          simulator.contextFor("updateReference", {
            ownerSecret: validSecret,
          }),
          refId,
          randomString(),
          "",
          "arweave",
          "",
          randomTimestamp(),
          "",
          new Uint8Array(32),
        ),
      ).rejects.toThrow(
        "[dStorage/midnight] newOwnerSecret is not set in private state",
      );
    });
  });

  describe("ownership enforcement across circuits", () => {
    it("owner can remove then store again (refId changes)", async () => {
      const entry = randomEntry();
      const refId1 = await simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
      );

      await simulator.removeReference(refId1);
      expect(simulator.getLedger().references.size()).toBe(0n);

      const entry2 = randomEntry();
      const refId2 = await simulator.storeReference(
        entry2.storageId,
        entry2.encryptionScheme,
        entry2.storageProvider,
        entry2.metadata,
        entry2.writtenAt,
      );

      expect(simulator.getLedger().references.size()).toBe(1n);
      expect(Buffer.from(refId1).toString("hex")).not.toBe(
        Buffer.from(refId2).toString("hex"),
      );
    });

    it("different users get different ownerCommitments for same storageId", async () => {
      const storageId = randomString(32);
      const ts = randomTimestamp();

      const refId1 = await simulator.storeReference(
        storageId,
        "xchacha20poly1305-v1",
        "arweave",
        "doc",
        ts,
      );

      simulator.switchUser(other.pk);
      const refId2 = await simulator.storeReference(
        storageId,
        "xchacha20poly1305-v1",
        "arweave",
        "doc",
        ts,
      );

      const commitment1 = simulator
        .getLedger()
        .references.lookup(refId1).ownerCommitment;
      const commitment2 = simulator
        .getLedger()
        .references.lookup(refId2).ownerCommitment;

      expect(Buffer.from(commitment1).toString("hex")).not.toBe(
        Buffer.from(commitment2).toString("hex"),
      );
    });
  });
});
