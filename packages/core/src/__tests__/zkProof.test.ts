import { describe, it, expect, vi, afterEach } from "vitest";
import { simulateZkProof, INSURANCE_CLAIMS } from "../zkProof.js";
import type { ZkClaim, ZkProofProgress } from "../zkProof.js";

afterEach(() => vi.useRealTimers());

// ── INSURANCE_CLAIMS registry ─────────────────────────────────────────────────

describe("INSURANCE_CLAIMS", () => {
  it("has exactly 4 claims", () => {
    expect(INSURANCE_CLAIMS).toHaveLength(4);
  });

  it("every claim has id, label, description, recordField, exampleValue", () => {
    for (const claim of INSURANCE_CLAIMS) {
      expect(claim).toHaveProperty("id");
      expect(claim).toHaveProperty("label");
      expect(claim).toHaveProperty("description");
      expect(claim).toHaveProperty("recordField");
      expect(claim).toHaveProperty("exampleValue");
    }
  });

  it('contains "active_coverage" claim', () => {
    const claim = INSURANCE_CLAIMS.find((c) => c.id === "active_coverage");
    expect(claim).toBeDefined();
  });

  it('contains "deductible_met" claim', () => {
    const claim = INSURANCE_CLAIMS.find((c) => c.id === "deductible_met");
    expect(claim).toBeDefined();
  });

  it("all claim ids are unique", () => {
    const ids = INSURANCE_CLAIMS.map((c) => c.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("all labels are non-empty strings", () => {
    for (const claim of INSURANCE_CLAIMS) {
      expect(typeof claim.label).toBe("string");
      expect(claim.label.length).toBeGreaterThan(0);
    }
  });

  it("all descriptions mention privacy or data", () => {
    for (const claim of INSURANCE_CLAIMS) {
      const lower = claim.description.toLowerCase();
      const hasSensibleDesc =
        lower.includes("without") ||
        lower.includes("prov") ||
        lower.includes("data") ||
        lower.includes("reveal");
      expect(hasSensibleDesc).toBe(true);
    }
  });
});

// ── simulateZkProof ───────────────────────────────────────────────────────────

describe("simulateZkProof", () => {
  const claim: ZkClaim = INSURANCE_CLAIMS[0]!;

  it("returns an object with all required fields", async () => {
    vi.useFakeTimers();
    const phases: string[] = [];
    const p = simulateZkProof(claim, "ref_abc", "midnight", (prog) =>
      phases.push(prog.phase),
    );
    await vi.runAllTimersAsync();
    const proof = await p;

    expect(proof).toHaveProperty("claim");
    expect(proof).toHaveProperty("commitment");
    expect(proof).toHaveProperty("nullifier");
    expect(proof).toHaveProperty("publicInputs");
    expect(proof).toHaveProperty("verificationKey");
    expect(proof).toHaveProperty("proofValid");
    expect(proof).toHaveProperty("privacyGuarantee");
  });

  it("proof.claim matches the input claim", async () => {
    vi.useFakeTimers();
    const p = simulateZkProof(claim, "ref_abc", "midnight", () => {});
    await vi.runAllTimersAsync();
    const proof = await p;
    expect(proof.claim.id).toBe(claim.id);
    expect(proof.claim.label).toBe(claim.label);
  });

  it("proofValid is true", async () => {
    vi.useFakeTimers();
    const p = simulateZkProof(claim, "ref_abc", "midnight", () => {});
    await vi.runAllTimersAsync();
    const proof = await p;
    expect(proof.proofValid).toBe(true);
  });

  it('privacyGuarantee is "data_never_revealed"', async () => {
    vi.useFakeTimers();
    const p = simulateZkProof(claim, "ref_abc", "midnight", () => {});
    await vi.runAllTimersAsync();
    const proof = await p;
    expect(proof.privacyGuarantee).toBe("data_never_revealed");
  });

  it('commitment starts with "0x"', async () => {
    vi.useFakeTimers();
    const p = simulateZkProof(claim, "ref_abc", "midnight", () => {});
    await vi.runAllTimersAsync();
    const proof = await p;
    expect(proof.commitment.startsWith("0x")).toBe(true);
  });

  it('nullifier starts with "0x"', async () => {
    vi.useFakeTimers();
    const p = simulateZkProof(claim, "ref_abc", "midnight", () => {});
    await vi.runAllTimersAsync();
    const proof = await p;
    expect(proof.nullifier.startsWith("0x")).toBe(true);
  });

  it("commitment is a 66-character hex string", async () => {
    vi.useFakeTimers();
    const p = simulateZkProof(claim, "ref_abc", "midnight", () => {});
    await vi.runAllTimersAsync();
    const proof = await p;
    expect(proof.commitment).toHaveLength(66);
    expect(proof.commitment).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("nullifier is a 66-character hex string", async () => {
    vi.useFakeTimers();
    const p = simulateZkProof(claim, "ref_abc", "midnight", () => {});
    await vi.runAllTimersAsync();
    const proof = await p;
    expect(proof.nullifier).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("commitment and nullifier are different", async () => {
    vi.useFakeTimers();
    const p = simulateZkProof(claim, "ref_abc", "midnight", () => {});
    await vi.runAllTimersAsync();
    const proof = await p;
    expect(proof.commitment).not.toBe(proof.nullifier);
  });

  it("two proofs produce different commitments (randomness)", async () => {
    vi.useFakeTimers();
    const p1 = simulateZkProof(claim, "ref_abc", "midnight", () => {});
    const p2 = simulateZkProof(claim, "ref_abc", "midnight", () => {});
    await vi.runAllTimersAsync();
    const [proof1, proof2] = await Promise.all([p1, p2]);
    expect(proof1.commitment).not.toBe(proof2.commitment);
  });

  it("publicInputs.claimId matches the claim id", async () => {
    vi.useFakeTimers();
    const p = simulateZkProof(claim, "ref_special", "midnight", () => {});
    await vi.runAllTimersAsync();
    const proof = await p;
    expect(proof.publicInputs.claimId).toBe(claim.id);
  });

  it("publicInputs.sourceRefId matches the input refId", async () => {
    vi.useFakeTimers();
    const p = simulateZkProof(claim, "ref_special", "midnight", () => {});
    await vi.runAllTimersAsync();
    const proof = await p;
    expect(proof.publicInputs.sourceRefId).toBe("ref_special");
  });

  it("publicInputs.chain matches the input chain", async () => {
    vi.useFakeTimers();
    const p = simulateZkProof(claim, "ref_abc", "ethereum", () => {});
    await vi.runAllTimersAsync();
    const proof = await p;
    expect(proof.publicInputs.chain).toBe("ethereum");
  });

  it("publicInputs.expiresAt is approximately 24 hours from generatedAt", async () => {
    vi.useFakeTimers();
    const p = simulateZkProof(claim, "ref_abc", "midnight", () => {});
    await vi.runAllTimersAsync();
    const proof = await p;
    const diffMs =
      proof.publicInputs.expiresAt - proof.publicInputs.generatedAt;
    expect(diffMs).toBeCloseTo(24 * 60 * 60 * 1000, -3); // within 1 second
  });

  it('verificationKey starts with "vk_"', async () => {
    vi.useFakeTimers();
    const p = simulateZkProof(claim, "ref_abc", "midnight", () => {});
    await vi.runAllTimersAsync();
    const proof = await p;
    expect(proof.verificationKey.startsWith("vk_")).toBe(true);
  });

  it("onProgress is called with phases: reading, witness, proving, committing, done", async () => {
    vi.useFakeTimers();
    const phases: ZkProofProgress["phase"][] = [];
    const p = simulateZkProof(claim, "ref_abc", "midnight", (prog) =>
      phases.push(prog.phase),
    );
    await vi.runAllTimersAsync();
    await p;

    expect(phases).toContain("reading");
    expect(phases).toContain("witness");
    expect(phases).toContain("proving");
    expect(phases).toContain("committing");
    expect(phases).toContain("done");
  });

  it("phases arrive in the correct order", async () => {
    vi.useFakeTimers();
    const phases: ZkProofProgress["phase"][] = [];
    const p = simulateZkProof(claim, "ref_abc", "midnight", (prog) =>
      phases.push(prog.phase),
    );
    await vi.runAllTimersAsync();
    await p;

    const order: ZkProofProgress["phase"][] = [
      "reading",
      "witness",
      "proving",
      "committing",
      "done",
    ];
    for (let i = 0; i < order.length - 1; i++) {
      const idx1 = phases.indexOf(order[i]!);
      const idx2 = phases.indexOf(order[i + 1]!);
      expect(idx1).toBeLessThan(idx2);
    }
  });

  it("each progress update has a non-empty label", async () => {
    vi.useFakeTimers();
    const updates: ZkProofProgress[] = [];
    const p = simulateZkProof(claim, "ref_abc", "midnight", (prog) =>
      updates.push(prog),
    );
    await vi.runAllTimersAsync();
    await p;

    for (const update of updates) {
      expect(typeof update.label).toBe("string");
      expect(update.label.length).toBeGreaterThan(0);
    }
  });

  it("works with all INSURANCE_CLAIMS", async () => {
    vi.useFakeTimers();
    const promises = INSURANCE_CLAIMS.map((c) =>
      simulateZkProof(c, "ref_multi", "midnight", () => {}),
    );
    await vi.runAllTimersAsync();
    const proofs = await Promise.all(promises);
    expect(proofs).toHaveLength(INSURANCE_CLAIMS.length);
    for (const proof of proofs) {
      expect(proof.proofValid).toBe(true);
    }
  });
});
