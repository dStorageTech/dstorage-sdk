/**
 * @dstorage/storage — adapters/mock.ts
 *
 * Mock storage adapter that uses localStorage (browser) or an in-memory Map (Node.js).
 * Perfect for development, testing, and demos — no tokens or external accounts needed.
 *
 * ⚠️  Not for production: data is local to the device and not decentralised.
 */

import type { StorageAdapter, StorageProviderName, UploadResult } from '../types.js';

// In Node.js (no localStorage), fall back to an in-memory map.
const memoryStore = new Map<string, string>();

function generateId(): string {
  // Use crypto.randomUUID if available, otherwise a simple fallback
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `mock_${crypto.randomUUID()}`;
  }
  return `mock_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function storeSet(key: string, value: string): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(key, value);
  } else {
    memoryStore.set(key, value);
  }
}

function storeGet(key: string): string | null {
  if (typeof localStorage !== 'undefined') {
    return localStorage.getItem(key);
  }
  return memoryStore.get(key) ?? null;
}

export class MockStorageAdapter implements StorageAdapter {
  readonly name: StorageProviderName = 'mock';

  async upload(
    data: string,
    metadata: Record<string, string> = {}
  ): Promise<UploadResult> {
    const id = generateId();

    const entry = JSON.stringify({ data, metadata, uploadedAt: Date.now() });
    storeSet(`dstorage:blob:${id}`, entry);

    console.log(`[dStorage/mock] Uploaded ${data.length} chars → id: ${id}`);

    return {
      id,
      provider: 'mock',
      cost: '0 (mock)',
      uploadedAt: Date.now(),
    };
  }

  async retrieve(id: string): Promise<string> {
    const raw = storeGet(`dstorage:blob:${id}`);

    if (!raw) {
      throw new Error(
        `[dStorage/mock] No data found for id: ${id}. Was it uploaded in this session?`
      );
    }

    const entry = JSON.parse(raw) as { data: string };
    console.log(`[dStorage/mock] Retrieved id: ${id}`);
    return entry.data;
  }

  async estimateCost(_data: string): Promise<string> {
    return '0 (mock — no real storage cost)';
  }

  /** List all stored IDs (useful for debugging in the demo app) */
  listAll(): string[] {
    if (typeof localStorage !== 'undefined') {
      return Object.keys(localStorage)
        .filter((k) => k.startsWith('dstorage:blob:'))
        .map((k) => k.replace('dstorage:blob:', ''));
    }
    return [...memoryStore.keys()]
      .filter((k) => k.startsWith('dstorage:blob:'))
      .map((k) => k.replace('dstorage:blob:', ''));
  }
}
