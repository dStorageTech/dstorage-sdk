import { describe, it, expect } from "vitest";
import {
  getContractsForChain,
  getContractByAddress,
  getCircuit,
  CATEGORY_LABELS,
} from "../contracts.js";

// ── getContractsForChain ──────────────────────────────────────────────────────

describe("getContractsForChain", () => {
  it("returns an array", () => {
    expect(Array.isArray(getContractsForChain("mock"))).toBe(true);
  });

  it('returns mock contracts for "mock" chain', () => {
    const contracts = getContractsForChain("mock");
    expect(contracts.length).toBeGreaterThan(0);
    for (const c of contracts) {
      expect(c.chain).toBe("mock");
    }
  });

  it('returns midnight contracts for "midnight" chain', () => {
    const contracts = getContractsForChain("midnight");
    expect(contracts.length).toBeGreaterThan(0);
    for (const c of contracts) {
      expect(c.chain).toBe("midnight");
    }
  });

  it("mock chain has contracts in multiple categories", () => {
    const contracts = getContractsForChain("mock");
    const categories = new Set(contracts.map((c) => c.category));
    expect(categories.size).toBeGreaterThan(1);
  });

  it("midnight chain has contracts in multiple categories", () => {
    const contracts = getContractsForChain("midnight");
    const categories = new Set(contracts.map((c) => c.category));
    expect(categories.size).toBeGreaterThan(1);
  });

  it("returns empty array for unknown chain", () => {
    // @ts-expect-error — intentional: testing unknown chain
    expect(getContractsForChain("solana")).toHaveLength(0);
  });

  it("each contract has address, name, description, category, chain, circuits", () => {
    for (const contract of getContractsForChain("mock")) {
      expect(contract).toHaveProperty("address");
      expect(contract).toHaveProperty("name");
      expect(contract).toHaveProperty("description");
      expect(contract).toHaveProperty("category");
      expect(contract).toHaveProperty("chain");
      expect(contract).toHaveProperty("circuits");
    }
  });

  it("circuits is a non-empty array for every contract", () => {
    for (const contract of getContractsForChain("mock")) {
      expect(Array.isArray(contract.circuits)).toBe(true);
      expect(contract.circuits.length).toBeGreaterThan(0);
    }
  });

  it("every circuit has id, name, description, inputParams", () => {
    for (const contract of [
      ...getContractsForChain("mock"),
      ...getContractsForChain("midnight"),
    ]) {
      for (const circuit of contract.circuits) {
        expect(circuit).toHaveProperty("id");
        expect(circuit).toHaveProperty("name");
        expect(circuit).toHaveProperty("description");
        expect(circuit).toHaveProperty("inputParams");
        expect(Array.isArray(circuit.inputParams)).toBe(true);
      }
    }
  });
});

// ── getContractByAddress ──────────────────────────────────────────────────────

describe("getContractByAddress", () => {
  it("returns a contract for a known mock address", () => {
    const [first] = getContractsForChain("mock");
    const found = getContractByAddress(first!.address);
    expect(found).toBeDefined();
    expect(found!.address).toBe(first!.address);
  });

  it("returns a contract for a known midnight address", () => {
    const [first] = getContractsForChain("midnight");
    const found = getContractByAddress(first!.address);
    expect(found).toBeDefined();
    expect(found!.address).toBe(first!.address);
  });

  it("returns undefined for an unknown address", () => {
    expect(getContractByAddress("0xUnknown")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(getContractByAddress("")).toBeUndefined();
  });

  it("lookup round-trips correctly for all mock contracts", () => {
    for (const contract of getContractsForChain("mock")) {
      const found = getContractByAddress(contract.address);
      expect(found).toBeDefined();
      expect(found!.name).toBe(contract.name);
    }
  });

  it("lookup round-trips correctly for all midnight contracts", () => {
    for (const contract of getContractsForChain("midnight")) {
      const found = getContractByAddress(contract.address);
      expect(found).toBeDefined();
      expect(found!.name).toBe(contract.name);
    }
  });
});

// ── getCircuit ────────────────────────────────────────────────────────────────

describe("getCircuit", () => {
  it("returns a circuit for a known contract + circuitId", () => {
    const [contract] = getContractsForChain("mock");
    const [circuit] = contract!.circuits;
    const found = getCircuit(contract!.address, circuit!.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(circuit!.id);
  });

  it('every contract has a "storeReference" circuit', () => {
    for (const contract of [
      ...getContractsForChain("mock"),
      ...getContractsForChain("midnight"),
    ]) {
      const found = getCircuit(contract.address, "storeReference");
      expect(found).toBeDefined();
      expect(found!.id).toBe("storeReference");
    }
  });

  it('every contract has a "grantAccess" circuit', () => {
    for (const contract of [
      ...getContractsForChain("mock"),
      ...getContractsForChain("midnight"),
    ]) {
      const found = getCircuit(contract.address, "grantAccess");
      expect(found).toBeDefined();
    }
  });

  it("returns undefined for unknown circuitId", () => {
    const [contract] = getContractsForChain("mock");
    expect(getCircuit(contract!.address, "nonExistentCircuit")).toBeUndefined();
  });

  it("returns undefined for unknown contract address", () => {
    expect(getCircuit("0xUnknown", "storeReference")).toBeUndefined();
  });

  it("storeReference circuit has storageId as an input param", () => {
    const [contract] = getContractsForChain("mock");
    const circuit = getCircuit(contract!.address, "storeReference");
    expect(circuit!.inputParams.some((p) => p.includes("storageId"))).toBe(
      true,
    );
  });

  it("grantAccess circuit has refId and grantee as input params", () => {
    const [contract] = getContractsForChain("mock");
    const circuit = getCircuit(contract!.address, "grantAccess");
    expect(circuit!.inputParams.some((p) => p.includes("refId"))).toBe(true);
    expect(circuit!.inputParams.some((p) => p.includes("grantee"))).toBe(true);
  });
});

// ── CATEGORY_LABELS ───────────────────────────────────────────────────────────

describe("CATEGORY_LABELS", () => {
  const expectedCategories = [
    "social",
    "storage",
    "identity",
    "compliance",
    "finance",
  ] as const;

  it("has a label for all 5 categories", () => {
    for (const cat of expectedCategories) {
      expect(CATEGORY_LABELS).toHaveProperty(cat);
    }
  });

  it("each label is a non-empty string", () => {
    for (const cat of expectedCategories) {
      expect(typeof CATEGORY_LABELS[cat]).toBe("string");
      expect(CATEGORY_LABELS[cat].length).toBeGreaterThan(0);
    }
  });
});
