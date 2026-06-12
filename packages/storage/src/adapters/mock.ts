/**
 * @dstorage/storage — adapters/mock.ts
 *
 * Mock storage adapter that uses localStorage (browser) or an in-memory Map (Node.js).
 * Perfect for development, testing, and demos — no tokens or external accounts needed.
 *
 * ⚠️  Not for production: data is local to the device and not decentralised.
 */

import type {
  StorageAdapterLogger,
  StorageAdapter,
  StorageProviderName,
  StorageUploadResult,
  StorageQuote,
} from "../types.js";
import {
  MockPaymentAdapter,
  ManagedPaymentAdapter,
  PaymentAdapter,
} from "@dstorage/payment";
import { DStorageError } from "@dstorage/crypto";
import { StorageErrorCode } from "../errors.js";

export interface MockStorageAdapterConfig {
  logger?: StorageAdapterLogger;
  signingServerUrl?: string;
  authToken?: string;
}

// In Node.js (no localStorage), fall back to an in-memory map.
const memoryStore = new Map<string, string>();

/** Encode a Uint8Array to a base64url string (browser-safe, no Buffer). */
function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function generateId(): string {
  // Generate 32 random bytes and encode as base64url (43 chars).
  // This format is compatible with Midnight's Bytes<32> contract field and
  // matches the Arweave txId format, so it works with all chain adapters.
  const bytes = new Uint8Array(32);
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.getRandomValues === "function"
  ) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++)
      bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytesToBase64url(bytes);
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
  readonly paymentAdapter: PaymentAdapter;
  private readonly logger: StorageAdapterLogger | undefined;

  constructor(config: MockStorageAdapterConfig = {}) {
    this.logger = config.logger;
    if (config.signingServerUrl) {
      if (!config.authToken?.trim()) {
        throw new DStorageError(
          StorageErrorCode.MOCK_AUTH_TOKEN_REQUIRED,
          "[dStorage/mock-storage] authToken is required when signingServerUrl is provided.",
        );
      }
      this.paymentAdapter = new ManagedPaymentAdapter({
        network: "managedmock",
        type: "storage",
        signingServerUrl: config.signingServerUrl,
        authToken: config.authToken,
        ...(config.logger !== undefined ? { logger: config.logger } : {}),
      });
    } else {
      this.paymentAdapter = new MockPaymentAdapter({ type: "storage" });
    }
  }

  async store(
    data: Uint8Array,
    metadata: Record<string, string> = {},
  ): Promise<StorageUploadResult> {
    const id = generateId();
    const cost = await this.estimateCost(data.byteLength);

    await this.paymentAdapter.pay({
      network: this.name,
      dataSizeBytes: data.byteLength,
      expiresAt: Date.now() + 600_000,
    });

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

  async retrieve(
    id: string,
  ): Promise<{ bytes: Uint8Array; tags: Record<string, string> }> {
    const raw = storeGet(`dstorage:blob:${id}`);

    if (!raw) {
      throw new DStorageError(
        StorageErrorCode.MOCK_DATA_NOT_FOUND,
        `[dStorage/mock] No data found for id: ${id}. Was it uploaded in this session?`,
      );
    }

    const entry = JSON.parse(raw) as {
      data: string;
      metadata?: Record<string, string>;
    };
    this.logger?.log("dStorage/mock", `Retrieved id: ${id}`);
    return {
      bytes: base64ToUint8Array(entry.data),
      tags: entry.metadata ?? {},
    };
  }

  async estimateCost(dataSizeBytes: number): Promise<StorageQuote> {
    return {
      token: "MOCK",
      amount: `${dataSizeBytes}`,
      provider: this.name,
      dataSizeBytes,
      expiresAt: Date.now() + 5 * 60_000,
    };
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

  /** For unit tests only — return the raw bytes stored at `id`. */
  get(id: string): Uint8Array | undefined {
    const raw = storeGet(`dstorage:blob:${id}`);
    if (!raw) return undefined;
    const entry = JSON.parse(raw) as { data: string };
    return base64ToUint8Array(entry.data);
  }

  /** For unit tests only — overwrite the bytes stored at `id` (keeps original metadata). */
  set(id: string, bytes: Uint8Array): void {
    const key = `dstorage:blob:${id}`;
    const raw = storeGet(key);
    const existing = raw
      ? (JSON.parse(raw) as { metadata: unknown; uploadedAt: number })
      : { metadata: {}, uploadedAt: Date.now() };
    storeSet(
      key,
      JSON.stringify({
        data: uint8ArrayToBase64(bytes),
        metadata: existing.metadata,
        uploadedAt: existing.uploadedAt,
      }),
    );
  }
}
