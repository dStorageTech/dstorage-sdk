/**
 * @dstorage/chain — adapters/mock.ts
 *
 * Mock chain adapter — simulates on-chain reference storage using
 * localStorage (browser) or in-memory Map (Node.js).
 *
 * Mimics exactly what the Midnight adapter will do:
 *   - writeReference()   → stores a pointer to encrypted off-chain data
 *   - grantAccess()      → records a permission entry
 *   - revokeAccess()     → removes the permission
 *   - hasAccess()        → checks the permission registry
 *
 * ⚠️  Not for production: not decentralised, not immutable.
 */

import type {
  ChainAdapter,
  ChainPermission,
  ChainProviderName,
  ChainReference,
  ChainWriteResult,
} from '../types.js';

// ── Storage helpers ───────────────────────────────────────────────────────────

const refs = new Map<string, ChainReference>();
const permissions = new Map<string, Set<string>>();

function generateRefId(): string {
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `ref_${id}`;
}

function persist(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage not available in this environment (e.g. Node.js)
  }
}

function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    // localStorage not available in this environment (e.g. Node.js)
  }
  return null;
}

export class MockChainAdapter implements ChainAdapter {
  readonly name: ChainProviderName = 'mock';

  constructor() {
    // Rehydrate from localStorage if available (browser only; no-op in Node.js)
    const savedRefs = load<Record<string, ChainReference>>('dstorage:chain:refs');
    if (savedRefs) {
      for (const [k, v] of Object.entries(savedRefs)) refs.set(k, v);
    }
  }

  async writeReference(ref: ChainReference): Promise<ChainWriteResult> {
    const refId = generateRefId();
    const entry: ChainReference = { ...ref, createdAt: Date.now() };
    refs.set(refId, entry);

    // Persist to localStorage
    const allRefs = Object.fromEntries(refs);
    persist('dstorage:chain:refs', allRefs);

    console.log(`[dStorage/mock-chain] Reference written → refId: ${refId}`);
    return { refId, provider: 'mock', writtenAt: Date.now() };
  }

  async readReference(refId: string): Promise<ChainReference> {
    const ref = refs.get(refId);
    if (!ref) throw new Error(`[dStorage/mock-chain] No reference found for refId: ${refId}`);
    return ref;
  }

  async grantAccess(permission: ChainPermission): Promise<string> {
    const { refId, grantee } = permission;

    if (!permissions.has(refId)) permissions.set(refId, new Set());
    permissions.get(refId)!.add(grantee);

    // Persist
    const allPerms: Record<string, string[]> = {};
    for (const [k, v] of permissions.entries()) allPerms[k] = [...v];
    persist('dstorage:chain:perms', allPerms);

    const permId = `perm_${refId}_${grantee}`;
    console.log(`[dStorage/mock-chain] Access granted: ${grantee} → ${refId}`);
    return permId;
  }

  async revokeAccess(refId: string, grantee: string): Promise<void> {
    permissions.get(refId)?.delete(grantee);
    console.log(`[dStorage/mock-chain] Access revoked: ${grantee} → ${refId}`);
  }

  async hasAccess(refId: string, wallet: string): Promise<boolean> {
    const ref = refs.get(refId);
    // Owner always has access
    if (ref?.owner === wallet) return true;
    return permissions.get(refId)?.has(wallet) ?? false;
  }

  /** List all references (useful for demo UI) */
  getAllReferences(): Array<{ refId: string; ref: ChainReference }> {
    return [...refs.entries()].map(([refId, ref]) => ({ refId, ref }));
  }

  // ── DataRegistry deployment stubs ─────────────────────────────────────────

  setContractAddress(_address: string): void {
    // No-op for mock — contract address is not used
  }

  async deployDataRegistry(): Promise<string> {
    const addr = `mock_contract_${Date.now()}`;
    console.log(`[dStorage/mock-chain] DataRegistry deployed at: ${addr}`);
    return addr;
  }

  async getEncryptionKey(): Promise<CryptoKey> {
    // Generate a random ephemeral key — fine for mocking purposes
    return globalThis.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }
}
