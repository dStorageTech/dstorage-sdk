import { describe, it, expect, beforeEach } from "vitest";
import {
  setNetworkId,
  NetworkId,
} from "@midnight-ntwrk/midnight-js-network-id";
import {
  encodeContractAddress,
  convertFieldToBytes,
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

setNetworkId("undeployed" as NetworkId);

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

  beforeEach(() => {
    owner = randomUser();
    other = randomUser();
    simulator = new DataRegistrySimulator(owner.pk);
  });

  describe("initial state", () => {
    it("starts with an empty references map", () => {
      expect(simulator.getLedger().references.isEmpty()).toBe(true);
      expect(simulator.getLedger().references.size()).toBe(0n);
    });

    it("starts with refCounter at 1", () => {
      // Counter is initialised to 1 in the constructor
      expect(simulator.getLedger().refCounter).toBe(1n);
    });

    it("has contractVersion equal to SUPPORTED_CONTRACT_VERSION", () => {
      expect(simulator.getLedger().contractVersion).toBe(
        SUPPORTED_CONTRACT_VERSION,
      );
    });
  });

  describe("contract version validation", () => {
    it("validateContractVersion accepts the current contract version", () => {
      const version = simulator.getLedger().contractVersion;
      expect(() =>
        validateContractVersion(version, "0xTestContract"),
      ).not.toThrow();
    });

    it("validateContractVersion throws for an unsupported version", () => {
      expect(() =>
        validateContractVersion(
          SUPPORTED_CONTRACT_VERSION + 1n,
          "0xTestContract",
        ),
      ).toThrow("Unsupported contract version");
    });

    it("validateContractVersion error includes the version number and address", () => {
      const addr = "0xDeadBeef";
      expect(() => validateContractVersion(99n, addr)).toThrow(addr);
      expect(() => validateContractVersion(99n, addr)).toThrow("99");
    });

    it("contractVersion is immutable — stays at SUPPORTED_CONTRACT_VERSION after all circuit calls", () => {
      const entry = randomEntry();
      const refId = simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
      );
      expect(simulator.getLedger().contractVersion).toBe(
        SUPPORTED_CONTRACT_VERSION,
      );

      simulator.updateReference(
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

      simulator.removeReference(refId);
      expect(simulator.getLedger().contractVersion).toBe(
        SUPPORTED_CONTRACT_VERSION,
      );
    });
  });

  describe("storeReference", () => {
    it("stores a reference and returns a non-zero refId", () => {
      const entry = randomEntry();
      const refId = simulator.storeReference(
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

    it("adds the entry to the references map", () => {
      const entry = randomEntry();
      const refId = simulator.storeReference(
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

    it("increments refCounter after each store", () => {
      expect(simulator.getLedger().refCounter).toBe(1n);

      const entry = randomEntry();
      simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
      );

      expect(simulator.getLedger().refCounter).toBe(2n);

      simulator.storeReference(
        randomString(),
        "",
        "ipfs",
        "",
        randomTimestamp(),
      );

      expect(simulator.getLedger().refCounter).toBe(3n);
    });

    it("generates unique refIds for successive stores", () => {
      const entry1 = randomEntry();
      const entry2 = randomEntry();

      const refId1 = simulator.storeReference(
        entry1.storageId,
        entry1.encryptionScheme,
        entry1.storageProvider,
        entry1.metadata,
        entry1.writtenAt,
      );
      const refId2 = simulator.storeReference(
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

    it("allows multiple users to store references independently", () => {
      const entry1 = randomEntry();
      const refId1 = simulator.storeReference(
        entry1.storageId,
        entry1.encryptionScheme,
        entry1.storageProvider,
        entry1.metadata,
        entry1.writtenAt,
      );

      simulator.switchUser(other.pk);
      const entry2 = randomEntry();
      const refId2 = simulator.storeReference(
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

    it("stores public (unencrypted) references with empty encryptionScheme", () => {
      const refId = simulator.storeReference(
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
    it("removes a reference stored by the owner", () => {
      const entry = randomEntry();
      const refId = simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
      );

      expect(simulator.getLedger().references.member(refId)).toBe(true);

      simulator.removeReference(refId);

      expect(simulator.getLedger().references.member(refId)).toBe(false);
      expect(simulator.getLedger().references.size()).toBe(0n);
    });

    it("throws when trying to remove a non-existent reference", () => {
      const nonExistentRefId = randomBytes(32);
      expect(() => simulator.removeReference(nonExistentRefId)).toThrow(
        "Reference not found",
      );
    });

    it("throws when a non-owner tries to remove another user's reference", () => {
      const entry = randomEntry();
      // Owner stores with their secret
      const refId = simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
        "",
        owner.secretKey,
      );

      // Switch to a different user and try to remove with a different secret
      simulator.switchUser(other.pk);

      expect(() => simulator.removeReference(refId, other.secretKey)).toThrow(
        "Not the owner",
      );
    });

    it("removes only the targeted reference, leaving others intact", () => {
      const entry1 = randomEntry();
      const entry2 = randomEntry();
      const refId1 = simulator.storeReference(
        entry1.storageId,
        entry1.encryptionScheme,
        entry1.storageProvider,
        entry1.metadata,
        entry1.writtenAt,
      );
      const refId2 = simulator.storeReference(
        entry2.storageId,
        entry2.encryptionScheme,
        entry2.storageProvider,
        entry2.metadata,
        entry2.writtenAt,
      );

      simulator.removeReference(refId1);

      const ledger = simulator.getLedger();
      expect(ledger.references.member(refId1)).toBe(false);
      expect(ledger.references.member(refId2)).toBe(true);
      expect(ledger.references.size()).toBe(1n);
    });
  });

  describe("updateReference", () => {
    it("updates all mutable fields of a reference", () => {
      const entry = randomEntry();
      const refId = simulator.storeReference(
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

      simulator.updateReference(
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

    it("preserves the ownerCommitment after update", () => {
      const entry = randomEntry();
      const refId = simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
      );

      const originalCommitment = simulator
        .getLedger()
        .references.lookup(refId).ownerCommitment;

      simulator.updateReference(
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

    it("throws when trying to update a non-existent reference", () => {
      const nonExistentRefId = randomBytes(32);
      expect(() =>
        simulator.updateReference(
          nonExistentRefId,
          randomString(),
          "",
          "arweave",
          "",
          randomTimestamp(),
        ),
      ).toThrow("Reference not found");
    });

    it("throws when a non-owner tries to update another user's reference", () => {
      const entry = randomEntry();
      // Owner stores with their secret
      const refId = simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
        "",
        owner.secretKey,
      );

      simulator.switchUser(other.pk);

      expect(() =>
        simulator.updateReference(
          refId,
          randomString(),
          "",
          "ipfs",
          "hijacked",
          randomTimestamp(),
          "",
          other.secretKey,
        ),
      ).toThrow("Not the owner");
    });

    it("allows the owner to update their reference after another user stored a separate one", () => {
      // Owner stores a reference with an explicit secret so it can be re-used after the user switch.
      const ownerEntry = randomEntry();
      const ownerRefId = simulator.storeReference(
        ownerEntry.storageId,
        ownerEntry.encryptionScheme,
        ownerEntry.storageProvider,
        ownerEntry.metadata,
        ownerEntry.writtenAt,
        "",
        owner.secretKey,
      );

      // Other user stores their own reference
      simulator.switchUser(other.pk);
      const otherEntry = randomEntry();
      simulator.storeReference(
        otherEntry.storageId,
        otherEntry.encryptionScheme,
        otherEntry.storageProvider,
        otherEntry.metadata,
        otherEntry.writtenAt,
      );

      // Owner switches back and updates their own reference using the same secret.
      simulator.switchUser(owner.pk);
      const newStorageId = randomString();
      simulator.updateReference(
        ownerRefId,
        newStorageId,
        "",
        "arweave",
        "updated",
        randomTimestamp(),
        "",
        owner.secretKey,
      );

      const updated = simulator.getLedger().references.lookup(ownerRefId);
      expect(updated.storageId).toBe(newStorageId);
    });
  });

  describe("pure circuit verification", () => {
    it("returned refId matches deriveRefId(refCounter, contractAddress)", () => {
      const instanceSalt = encodeContractAddress(simulator.contractAddress);

      // Capture the counter value before the store — the circuit uses it as-is
      const counterBefore = simulator.getLedger().refCounter;
      const counterBytes = convertFieldToBytes(32, counterBefore, "test");
      const expectedRefId = pureCircuits.deriveRefId(
        counterBytes,
        instanceSalt,
      );

      const entry = randomEntry();
      const actualRefId = simulator.storeReference(
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

    it("verifies deriveRefId for successive stores (counter increments each time)", () => {
      const instanceSalt = encodeContractAddress(simulator.contractAddress);
      const entry = randomEntry();

      for (let i = 0; i < 3; i++) {
        const counterBefore = simulator.getLedger().refCounter;
        const expectedRefId = pureCircuits.deriveRefId(
          convertFieldToBytes(32, counterBefore, "test"),
          instanceSalt,
        );

        const actualRefId = simulator.storeReference(
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

    it("stored ownerCommitment matches computeOwnerCommitment(ownerSecret, refId, contractAddress)", () => {
      const instanceSalt = encodeContractAddress(simulator.contractAddress);
      const ownerSecret = owner.secretKey; // 32-byte witness secret

      const entry = randomEntry();
      const refId = simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
        "",
        ownerSecret,
      );

      // The contract uses refId as the nonce in computeOwnerCommitment
      const expectedCommitment = pureCircuits.computeOwnerCommitment(
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

    it("ownerCommitment changes when a different ownerSecret is used", () => {
      const instanceSalt = encodeContractAddress(simulator.contractAddress);
      const entry = randomEntry();

      // Owner stores with their secret
      const ownerSecret = owner.secretKey;
      const refId1 = simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
        "",
        ownerSecret,
      );

      // Other user stores with a different secret
      const otherSecret = other.secretKey;
      simulator.switchUser(other.pk);
      const refId2 = simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
        "",
        otherSecret,
      );

      // Verify both commitments match what computeOwnerCommitment produces for each secret
      const ownerCommitment = pureCircuits.computeOwnerCommitment(
        ownerSecret,
        refId1,
        instanceSalt,
      );
      const otherCommitment = pureCircuits.computeOwnerCommitment(
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
    it("stores and retrieves a non-empty keyEnvelope", () => {
      const entry = randomEntry();
      const envelope =
        '{"kdf":"scrypt","N":131072,"r":8,"p":1,"wrappedDek":"abc123"}';
      const refId = simulator.storeReference(
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

    it("stores empty keyEnvelope for public (unencrypted) uploads", () => {
      const refId = simulator.storeReference(
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

    it("defaults keyEnvelope to empty string when not supplied", () => {
      const entry = randomEntry();
      const refId = simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
      );

      const stored = simulator.getLedger().references.lookup(refId);
      expect(stored.keyEnvelope).toBe("");
    });

    it("updateReference replaces keyEnvelope with a new value", () => {
      const entry = randomEntry();
      const originalEnvelope = '{"kdf":"scrypt","wrappedDek":"original"}';
      const refId = simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
        originalEnvelope,
      );

      const newEnvelope = '{"kdf":"scrypt","wrappedDek":"rotated"}';
      simulator.updateReference(
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

    it("updateReference can clear keyEnvelope by setting it to empty string", () => {
      const entry = randomEntry();
      const refId = simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
        '{"kdf":"scrypt","wrappedDek":"abc"}',
      );

      simulator.updateReference(
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

    it("two references store independent keyEnvelopes", () => {
      const envelope1 = '{"kdf":"scrypt","wrappedDek":"first"}';
      const envelope2 = '{"kdf":"scrypt","wrappedDek":"second"}';

      const entry1 = randomEntry();
      const entry2 = randomEntry();

      const refId1 = simulator.storeReference(
        entry1.storageId,
        entry1.encryptionScheme,
        entry1.storageProvider,
        entry1.metadata,
        entry1.writtenAt,
        envelope1,
      );
      const refId2 = simulator.storeReference(
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

    it("updating one reference's keyEnvelope does not affect another's", () => {
      const envelope1 = '{"kdf":"scrypt","wrappedDek":"first"}';
      const envelope2 = '{"kdf":"scrypt","wrappedDek":"second"}';

      const entry1 = randomEntry();
      const entry2 = randomEntry();

      const refId1 = simulator.storeReference(
        entry1.storageId,
        entry1.encryptionScheme,
        entry1.storageProvider,
        entry1.metadata,
        entry1.writtenAt,
        envelope1,
      );
      const refId2 = simulator.storeReference(
        entry2.storageId,
        entry2.encryptionScheme,
        entry2.storageProvider,
        entry2.metadata,
        entry2.writtenAt,
        envelope2,
      );

      simulator.updateReference(
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

    beforeEach(() => {
      validSecret = randomBytes(32);
    });

    it("storeReference rejects an all-zeros ownerSecret", () => {
      const entry = randomEntry();
      expect(() =>
        simulator.storeReference(
          entry.storageId,
          entry.encryptionScheme,
          entry.storageProvider,
          entry.metadata,
          entry.writtenAt,
          "",
          new Uint8Array(32),
        ),
      ).toThrow("ownerSecret must not be zero");
    });

    it("removeReference rejects an all-zeros ownerSecret", () => {
      const refId = simulator.storeReference(
        randomString(32),
        "xchacha20poly1305-v1",
        "arweave",
        "doc",
        randomTimestamp(),
        "",
        validSecret,
      );
      expect(() =>
        simulator.removeReference(refId, new Uint8Array(32)),
      ).toThrow("ownerSecret must not be zero");
    });

    it("updateReference rejects an all-zeros ownerSecret", () => {
      const refId = simulator.storeReference(
        randomString(32),
        "xchacha20poly1305-v1",
        "arweave",
        "doc",
        randomTimestamp(),
        "",
        validSecret,
      );
      expect(() =>
        simulator.updateReference(
          refId,
          randomString(),
          "",
          "arweave",
          "",
          randomTimestamp(),
          "",
          new Uint8Array(32),
        ),
      ).toThrow("ownerSecret must not be zero");
    });

    it("updateReference rejects an all-zeros newOwnerSecret", () => {
      const refId = simulator.storeReference(
        randomString(32),
        "xchacha20poly1305-v1",
        "arweave",
        "doc",
        randomTimestamp(),
        "",
        validSecret,
      );
      expect(() =>
        simulator.updateReference(
          refId,
          randomString(),
          "",
          "arweave",
          "",
          randomTimestamp(),
          "",
          validSecret,
          new Uint8Array(32),
        ),
      ).toThrow("newOwnerSecret must not be zero");
    });

    it("updateReference throws when newOwnerSecret is absent from private state", () => {
      const refId = simulator.storeReference(
        randomString(32),
        "xchacha20poly1305-v1",
        "arweave",
        "doc",
        randomTimestamp(),
        "",
        validSecret,
      );
      simulator.circuitContext.currentPrivateState = {
        ownerSecret: validSecret,
      };
      expect(() =>
        simulator.contract.impureCircuits.updateReference(
          simulator.circuitContext,
          refId,
          randomString(),
          "",
          "arweave",
          "",
          randomTimestamp(),
          "",
        ),
      ).toThrow(
        "[dStorage/midnight] newOwnerSecret is not set in private state",
      );
    });
  });

  describe("ownership enforcement across circuits", () => {
    it("owner can remove then store again (refId changes)", () => {
      const entry = randomEntry();
      const refId1 = simulator.storeReference(
        entry.storageId,
        entry.encryptionScheme,
        entry.storageProvider,
        entry.metadata,
        entry.writtenAt,
      );

      simulator.removeReference(refId1);
      expect(simulator.getLedger().references.size()).toBe(0n);

      const entry2 = randomEntry();
      const refId2 = simulator.storeReference(
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

    it("different users get different ownerCommitments for same storageId", () => {
      const storageId = randomString(32);
      const ts = randomTimestamp();

      const refId1 = simulator.storeReference(
        storageId,
        "xchacha20poly1305-v1",
        "arweave",
        "doc",
        ts,
      );

      simulator.switchUser(other.pk);
      const refId2 = simulator.storeReference(
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
