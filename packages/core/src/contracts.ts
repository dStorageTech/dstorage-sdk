/**
 * @dstorage/core — contracts.ts
 *
 * Contract registry for dStorage SDK.
 *
 * These are dApp contracts that integrate dStorage — they use the SDK to
 * store encrypted user data off-chain and write references on-chain.
 *
 * In production, contracts are deployed on the target chain and their
 * addresses are known at integration time. For the MVP, we use mocked
 * addresses to demonstrate the full selection flow.
 *
 * Each contract exposes a set of circuits (Midnight) / functions (EVM) —
 * these are the operations the user is invoking as part of the meta-transaction.
 */

import type { ChainProviderName } from '@dstorage/chain';

// ── Circuit definition ────────────────────────────────────────────────────────

export interface CircuitDefinition {
  /** Unique identifier — matches the function/circuit name in the contract */
  id: string;
  /** Human-readable name */
  name: string;
  /** What this circuit does */
  description: string;
  /** Informational list of input parameters */
  inputParams: string[];
}

// ── Contract definition ───────────────────────────────────────────────────────

export interface ContractDefinition {
  /** On-chain contract address */
  address: string;
  /** Human-readable dApp name */
  name: string;
  /** What this dApp does */
  description: string;
  /** Category tag */
  category: 'social' | 'storage' | 'identity' | 'compliance' | 'finance';
  /** Which chain this contract is deployed on */
  chain: ChainProviderName;
  /** Available circuits / callable functions */
  circuits: CircuitDefinition[];
}

// ── Common circuits (shared across contract types) ────────────────────────────

const STORE_REFERENCE: CircuitDefinition = {
  id: 'storeReference',
  name: 'Store Reference',
  description: 'Write an encrypted data pointer and owner metadata on-chain',
  inputParams: ['storageId: String', 'storageProvider: String', 'owner: Address', 'label: String'],
};

const GRANT_ACCESS: CircuitDefinition = {
  id: 'grantAccess',
  name: 'Grant Access',
  description: 'Grant a recipient wallet read permission for a specific data reference',
  inputParams: ['refId: String', 'grantee: Address', 'expiresAt?: Timestamp'],
};

const REVOKE_ACCESS: CircuitDefinition = {
  id: 'revokeAccess',
  name: 'Revoke Access',
  description: 'Remove a previously granted read permission from a wallet',
  inputParams: ['refId: String', 'grantee: Address'],
};

const PROVE_OWNERSHIP: CircuitDefinition = {
  id: 'proveOwnership',
  name: 'Prove Ownership',
  description: 'Generate a ZK proof that you own a data reference without revealing its contents',
  inputParams: ['refId: String', 'ownerSecret: PrivateKey'],
};

const VERIFY_DATA: CircuitDefinition = {
  id: 'verifyData',
  name: 'Verify Data Integrity',
  description: 'Verify that retrieved data matches its on-chain cryptographic commitment',
  inputParams: ['refId: String', 'dataHash: Bytes32'],
};

const UPDATE_REFERENCE: CircuitDefinition = {
  id: 'updateReference',
  name: 'Update Reference',
  description: 'Replace an existing data reference with a new encrypted version',
  inputParams: ['refId: String', 'newStorageId: String', 'newDataHash: Bytes32'],
};

const VERIFY_COMPLIANCE: CircuitDefinition = {
  id: 'verifyCompliance',
  name: 'Verify Compliance',
  description: 'Prove a data field satisfies a regulatory rule without revealing the value (e.g. age ≥ 18)',
  inputParams: ['refId: String', 'fieldPath: String', 'complianceRule: String'],
};

// ── Mock contract registry ────────────────────────────────────────────────────

const MOCK_CONTRACTS: ContractDefinition[] = [
  // ── Mock chain contracts ──────────────────────────────────────────────────
  {
    address: '0xMock1A2B3C4D5E6F7G8H9I0J',
    name: 'Social Profile dApp',
    description: 'Decentralised user profile system. Stores encrypted profile data off-chain and links it on-chain for cross-dApp portability.',
    category: 'social',
    chain: 'mock',
    circuits: [STORE_REFERENCE, GRANT_ACCESS, REVOKE_ACCESS, PROVE_OWNERSHIP, UPDATE_REFERENCE],
  },
  {
    address: '0xMock2B3C4D5E6F7G8H9I0J1K',
    name: 'Document Vault',
    description: 'Secure document storage for dApps. Encrypt, store, and selectively share sensitive documents with cryptographic access control.',
    category: 'storage',
    chain: 'mock',
    circuits: [STORE_REFERENCE, GRANT_ACCESS, REVOKE_ACCESS, VERIFY_DATA, UPDATE_REFERENCE],
  },
  {
    address: '0xMock3C4D5E6F7G8H9I0J1K2L',
    name: 'Identity Registry',
    description: 'Self-sovereign identity registry. Users control their own identity credentials with ZK-provable selective disclosure.',
    category: 'identity',
    chain: 'mock',
    circuits: [STORE_REFERENCE, PROVE_OWNERSHIP, VERIFY_COMPLIANCE, GRANT_ACCESS, REVOKE_ACCESS],
  },
  {
    address: '0xMock4D5E6F7G8H9I0J1K2L3M',
    name: 'Compliance Vault',
    description: 'Regulatory compliance data management. Store KYC/AML documents and prove compliance without exposing personal data to operators.',
    category: 'compliance',
    chain: 'mock',
    circuits: [STORE_REFERENCE, VERIFY_COMPLIANCE, PROVE_OWNERSHIP, GRANT_ACCESS],
  },

  // ── Midnight chain contracts ──────────────────────────────────────────────
  {
    address: 'midnight:1qaz2wsx3edc4rfv5tgb6yhn',
    name: 'Midnight Social Profile',
    description: 'ZK-native social profile on Midnight Network. Wallet-derived keys encrypt profile fields; ZK proofs enable selective attribute sharing.',
    category: 'social',
    chain: 'midnight',
    circuits: [STORE_REFERENCE, GRANT_ACCESS, REVOKE_ACCESS, PROVE_OWNERSHIP, UPDATE_REFERENCE],
  },
  {
    address: 'midnight:2wsx3edc4rfv5tgb6yhn7ujm',
    name: 'Midnight Document Vault',
    description: 'Privacy-native document vault on Midnight. Compact contract stores only encrypted references — operators never access raw documents.',
    category: 'storage',
    chain: 'midnight',
    circuits: [STORE_REFERENCE, GRANT_ACCESS, REVOKE_ACCESS, VERIFY_DATA, UPDATE_REFERENCE],
  },
  {
    address: 'midnight:3edc4rfv5tgb6yhn7ujm8ik',
    name: 'Midnight Identity Registry',
    description: 'Midnight identity registry using ZK proofs for compliance without exposure. GDPR-compliant by design — regulators get proofs, not data.',
    category: 'identity',
    chain: 'midnight',
    circuits: [STORE_REFERENCE, PROVE_OWNERSHIP, VERIFY_COMPLIANCE, GRANT_ACCESS, REVOKE_ACCESS],
  },
  {
    address: 'midnight:4rfv5tgb6yhn7ujm8ik9ol',
    name: 'Midnight Compliance Vault',
    description: 'Institutional-grade compliance vault on Midnight. KYC/AML documents stored encrypted; ZK circuits prove regulatory conditions without data exposure.',
    category: 'compliance',
    chain: 'midnight',
    circuits: [STORE_REFERENCE, VERIFY_COMPLIANCE, PROVE_OWNERSHIP, GRANT_ACCESS],
  },
];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get all contracts available for a given chain.
 */
export function getContractsForChain(
  chain: ChainProviderName
): ContractDefinition[] {
  return MOCK_CONTRACTS.filter((c) => c.chain === chain);
}

/**
 * Look up a contract by its address.
 */
export function getContractByAddress(
  address: string
): ContractDefinition | undefined {
  return MOCK_CONTRACTS.find((c) => c.address === address);
}

/**
 * Get a specific circuit from a contract by its id.
 */
export function getCircuit(
  contractAddress: string,
  circuitId: string
): CircuitDefinition | undefined {
  const contract = getContractByAddress(contractAddress);
  return contract?.circuits.find((c) => c.id === circuitId);
}

/** Category display labels */
export const CATEGORY_LABELS: Record<ContractDefinition['category'], string> = {
  social:     '👤 Social',
  storage:    '🗄 Storage',
  identity:   '🪪 Identity',
  compliance: '📋 Compliance',
  finance:    '💰 Finance',
};

export type { ChainProviderName };
