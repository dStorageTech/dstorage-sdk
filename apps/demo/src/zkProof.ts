/**
 * ZK Proof simulation layer for the dStorage demo app.
 *
 * Simulates the structure and flow of a real ZK proof as Midnight Compact
 * circuits would produce it. The proof proves a claim about encrypted data
 * WITHOUT revealing the underlying record.
 *
 * Real implementation (Sprint 2+):
 *   - Midnight Compact circuit: proveInsuranceEligibility(record, claim) → proof
 *   - Proof contains: commitment, nullifier, public inputs, verification key
 *   - Verifier calls: verifyProof(proof, verificationKey) → bool on-chain
 *
 * Here we simulate the cryptographic structure with realistic fields and delays.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** The claim being proved — what the patient asserts without revealing data */
export interface ZkClaim {
  id: string;
  label: string;
  description: string;
  /** The field in the record this claim is derived from */
  recordField: string;
  /** Example value in the record (never revealed to verifier) */
  exampleValue: string;
}

/** Available claims for insurance records */
export const INSURANCE_CLAIMS: ZkClaim[] = [
  {
    id: "active_coverage",
    label: "Has Active Coverage",
    description:
      "Proves insurance policy is currently active without revealing policy number, provider, or personal details",
    recordField: "policy_status",
    exampleValue: "ACTIVE",
  },
  {
    id: "coverage_type_inpatient",
    label: "Inpatient Coverage Included",
    description:
      "Proves the policy includes inpatient hospital coverage without revealing coverage limits or premium",
    recordField: "coverage_types",
    exampleValue: "inpatient, outpatient, specialist",
  },
  {
    id: "no_prior_auth_required",
    label: "No Prior Auth Required",
    description:
      "Proves prior authorisation is not required for standard procedures",
    recordField: "prior_auth_required",
    exampleValue: "false",
  },
  {
    id: "deductible_met",
    label: "Annual Deductible Met",
    description:
      "Proves the annual deductible has been met without revealing the deductible amount or YTD spending",
    recordField: "deductible_met",
    exampleValue: "true",
  },
];

/** The proof object — what gets sent to the verifier */
export interface ZkProofResult {
  /** The claim that was proved */
  claim: ZkClaim;
  /** Cryptographic commitment to the private data (hash) */
  commitment: string;
  /** Nullifier — prevents double-use of the same proof */
  nullifier: string;
  /** Public inputs the verifier can check */
  publicInputs: {
    claimId: string;
    claimLabel: string;
    /** On-chain reference ID of the source record */
    sourceRefId: string;
    /** Chain the proof was generated on */
    chain: string;
    /** Unix timestamp the proof was generated */
    generatedAt: number;
    /** Expiry — proof valid for 24 hours */
    expiresAt: number;
  };
  /** Simulated verification key — in production this is a ZK SNARK/STARK vkey */
  verificationKey: string;
  /** Whether the claim evaluates to true */
  proofValid: boolean;
  /** The proof was generated without revealing the underlying record */
  privacyGuarantee: "data_never_revealed";
}

export interface ZkProofProgress {
  phase: "reading" | "witness" | "proving" | "committing" | "done" | "error";
  label: string;
  detail?: string;
}

// ── Simulator ─────────────────────────────────────────────────────────────────

/**
 * Simulate generating a ZK proof from a stored encrypted record.
 *
 * The flow:
 *   1. Read encrypted record from storage (decrypt locally)
 *   2. Generate witness from the relevant field
 *   3. Run simulated ZK proving algorithm
 *   4. Commit proof to chain
 *   5. Return proof object for transmission to verifier
 *
 * The verifier NEVER receives the decrypted record — only the proof.
 */
export async function simulateZkProof(
  claim: ZkClaim,
  sourceRefId: string,
  chain: string,
  onProgress: (p: ZkProofProgress) => void,
): Promise<ZkProofResult> {
  onProgress({
    phase: "reading",
    label: "Reading encrypted record…",
    detail: "Decrypting locally — data stays on device",
  });
  await sleep(700);

  onProgress({
    phase: "witness",
    label: "Generating witness…",
    detail: `Extracting field: ${claim.recordField}`,
  });
  await sleep(900);

  onProgress({
    phase: "proving",
    label: "Running ZK proving circuit…",
    detail: "Midnight Compact: proveInsuranceEligibility()",
  });
  await sleep(1200);

  onProgress({
    phase: "committing",
    label: "Committing proof on-chain…",
    detail: "Writing commitment + nullifier to Midnight",
  });
  await sleep(600);

  const now = Date.now();
  const proof: ZkProofResult = {
    claim,
    commitment: `0x${randomHex(64)}`,
    nullifier: `0x${randomHex(64)}`,
    publicInputs: {
      claimId: claim.id,
      claimLabel: claim.label,
      sourceRefId,
      chain,
      generatedAt: now,
      expiresAt: now + 24 * 60 * 60 * 1000,
    },
    verificationKey: `vk_${randomHex(32)}`,
    proofValid: true,
    privacyGuarantee: "data_never_revealed",
  };

  onProgress({
    phase: "done",
    label: "Proof generated",
    detail: `Commitment: ${proof.commitment.slice(0, 18)}…`,
  });

  return proof;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function randomHex(len: number): string {
  return Array.from({ length: len }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
