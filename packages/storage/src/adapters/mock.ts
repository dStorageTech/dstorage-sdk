/**
 * @dstorage/storage — adapters/mock.ts
 *
 * Mock storage adapter that uses localStorage (browser) or an in-memory Map (Node.js).
 * Perfect for development, testing, and demos — no tokens or external accounts needed.
 *
 * ⚠️  Not for production: data is local to the device and not decentralised.
 */

import type {
  Logger,
  StorageAdapter,
  StorageProviderName,
  UploadResult,
} from "../types.js";

// In Node.js (no localStorage), fall back to an in-memory map.
const memoryStore = new Map<string, string>();

function generateId(): string {
  // Use crypto.randomUUID if available, otherwise a simple fallback
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `mock_${crypto.randomUUID()}`;
  }
  return `mock_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function uint8ArrayToBase64(arr: Uint8Array): string {
  let binary = "";
  const chunkSize = 8 * 1024;
  for (let i = 0; i < arr.length; i += chunkSize) {
    binary += String.fromCharCode(...arr.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    arr[i] = binary.charCodeAt(i);
  }
  return arr;
}

function storeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage not available (e.g. Node.js) — fall back to memory
    memoryStore.set(key, value);
  }
}

function storeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // localStorage not available (e.g. Node.js) — fall back to memory
    return memoryStore.get(key) ?? null;
  }
}

export class MockStorageAdapter implements StorageAdapter {
  readonly name: StorageProviderName = "mock";
  readonly providerName: string = "Mock-Storage-Adapter";
  private readonly logger: Logger | undefined;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  async upload(
    data: Uint8Array,
    metadata: Record<string, string> = {},
  ): Promise<UploadResult> {
    const id = generateId();
    const cost = await this.estimateCost(data);

    const entry = JSON.stringify({
      data: uint8ArrayToBase64(data),
      metadata,
      uploadedAt: Date.now(),
    });
    storeSet(`dstorage:blob:${id}`, entry);

    this.logger?.log(
      "dStorage/mock",
      `Uploaded ${data.byteLength} bytes → id: ${id}`,
    );

    return {
      id,
      provider: this.name,
      cost,
      uploadedAt: Date.now(),
    };
  }

  async retrieve(id: string): Promise<Uint8Array> {
    const raw = storeGet(`dstorage:blob:${id}`);

    if (!raw) {
      throw new Error(
        `[dStorage/mock] No data found for id: ${id}. Was it uploaded in this session?`,
      );
    }

    const entry = JSON.parse(raw) as { data: string };
    this.logger?.log("dStorage/mock", `Retrieved id: ${id}`);
    return base64ToUint8Array(entry.data);
  }

  async estimateCost(data: Uint8Array): Promise<string> {
    return `${data.byteLength}`; // mock — 1 unit per byte
  }

  /** List all stored IDs (useful for debugging) */
  listAll(): string[] {
    const ids: string[] = [];

    // Always include in-memory items (Node.js fallback when localStorage is unavailable)
    for (const k of memoryStore.keys()) {
      if (k.startsWith("dstorage:blob:"))
        ids.push(k.replace("dstorage:blob:", ""));
    }

    // Also include browser localStorage items when available
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith("dstorage:blob:"))
          ids.push(k.replace("dstorage:blob:", ""));
      }
    } catch {
      // localStorage not accessible — already covered by memoryStore above
    }

    return ids;
  }
}
