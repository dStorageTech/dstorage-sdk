/**
 * @dstorage/chain — adapters/httpGateway.ts
 *
 * HTTP Gateway chain adapter — delegates reference storage to a remote REST
 * service. Useful for testing, staging environments, or custom backends that
 * expose a simple HTTP API instead of a blockchain node.
 */

import type {
  ChainAdapter,
  ChainProviderName,
  ChainReference,
  ChainReferenceUpdate,
  ChainWriteResult,
  ChainAdapterLogger,
  DataReferenceSummary,
  ChainQuote,
} from "../types.js";
import { bytesToBase64url, DStorageError } from "@dstorage/crypto";
import { ChainErrorCode } from "../errors.js";

const COMPONENT = "[dStorage/http-gateway-chain]";

function generateRefId(): string {
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `ref_${id}`;
}

export interface HttpGatewayChainAdapterConfig {
  /** Scheme + host (+ optional port) shared by all endpoints. e.g. "http://localhost:3200" */
  baseUrl: string;
  /** Path appended to baseUrl for write (POST /{refId}) and update operations. e.g. "/api/refs" */
  writePath: string;
  /** Path appended to baseUrl for read (GET /{refId}) operations. */
  readPath: string;
  /** Path appended to baseUrl for listReferences (GET) operations. */
  listPath: string;
  /** Path appended to baseUrl for removeReference (DELETE /{refId}) operations. */
  deletePath: string;
  /**
   * Optional custom fetch implementation. Useful when the gateway uses a custom CA
   * or client certificate: supply an undici Agent configured with the appropriate
   * `ca`, `cert`, and `key` options. Defaults to `globalThis.fetch` when omitted.
   */
  customFetch?: typeof fetch;
  logger?: ChainAdapterLogger;
}

export class HttpGatewayChainAdapter implements ChainAdapter {
  readonly name: ChainProviderName = "httpgateway";
  readonly providerName = "HTTP-Gateway-Chain-Adapter";

  private readonly logger: ChainAdapterLogger | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly writeUrl: string;
  private readonly readUrl: string;
  private readonly listUrl: string;
  private readonly deleteUrl: string;

  constructor(config: HttpGatewayChainAdapterConfig) {
    this.logger = config.logger;
    this.fetchFn = config.customFetch ?? globalThis.fetch.bind(globalThis);
    this.writeUrl = `${config.baseUrl}${config.writePath}`;
    this.readUrl = `${config.baseUrl}${config.readPath}`;
    this.listUrl = `${config.baseUrl}${config.listPath}`;
    this.deleteUrl = `${config.baseUrl}${config.deletePath}`;
  }

  async writeReference(ref: ChainReference): Promise<ChainWriteResult> {
    // ownerSecret is an internal ZK witness — never transmit it
    const { ownerSecret: _omit, ...payload } = ref;
    const refId = ref.refId ?? generateRefId();
    const url = `${this.writeUrl}/${encodeURIComponent(refId)}`;

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw new DStorageError(
        ChainErrorCode.GATEWAY_WRITE_FAILED,
        `${COMPONENT} writeReference failed: ${String(err)}`,
        { cause: err },
      );
    }

    if (!res.ok) {
      throw new DStorageError(
        ChainErrorCode.GATEWAY_WRITE_HTTP_ERROR,
        `${COMPONENT} writeReference failed: HTTP ${res.status} ${res.statusText}`,
      );
    }

    this.logger?.log(COMPONENT, `writeReference succeeded: refId=${refId}`);

    return {
      refId,
      provider: "httpgateway",
      writtenAt: ref.writtenAt,
    };
  }

  async updateReference(
    refId: string,
    update: ChainReferenceUpdate,
    _ownerSecret?: Uint8Array,
    _newOwnerSecret?: Uint8Array,
  ): Promise<void> {
    const url = `${this.writeUrl}/${encodeURIComponent(refId)}`;

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });
    } catch (err) {
      throw new DStorageError(
        ChainErrorCode.GATEWAY_UPDATE_FAILED,
        `${COMPONENT} updateReference failed: ${String(err)}`,
        { cause: err },
      );
    }

    if (!res.ok) {
      throw new DStorageError(
        ChainErrorCode.GATEWAY_UPDATE_HTTP_ERROR,
        `${COMPONENT} updateReference failed: HTTP ${res.status} ${res.statusText}`,
      );
    }

    this.logger?.log(COMPONENT, `updateReference succeeded: refId=${refId}`);
  }

  async readReference(refId: string): Promise<ChainReference> {
    const url = `${this.readUrl}/${encodeURIComponent(refId)}`;

    let res: Response;
    try {
      res = await this.fetchFn(url);
    } catch (err) {
      throw new DStorageError(
        ChainErrorCode.GATEWAY_READ_FAILED,
        `${COMPONENT} readReference failed: ${String(err)}`,
        { cause: err },
      );
    }

    if (!res.ok) {
      throw new DStorageError(
        ChainErrorCode.GATEWAY_READ_HTTP_ERROR,
        `${COMPONENT} readReference failed: HTTP ${res.status} ${res.statusText}`,
      );
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new DStorageError(
        ChainErrorCode.GATEWAY_READ_INVALID_JSON,
        `${COMPONENT} readReference failed: invalid JSON response`,
      );
    }
    const d = data as Record<string, unknown>;
    if (
      data === null ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      typeof d.storageProvider !== "string" ||
      typeof d.writtenAt !== "number" ||
      typeof d.keyEnvelope !== "string"
    ) {
      throw new DStorageError(
        ChainErrorCode.GATEWAY_READ_INVALID_SHAPE,
        `${COMPONENT} readReference failed: invalid response shape`,
      );
    }
    return data as ChainReference;
  }

  async listReferences(): Promise<DataReferenceSummary[]> {
    let res: Response;
    try {
      res = await this.fetchFn(this.listUrl);
    } catch (err) {
      throw new DStorageError(
        ChainErrorCode.GATEWAY_LIST_FAILED,
        `${COMPONENT} listReferences failed: ${String(err)}`,
        { cause: err },
      );
    }

    if (!res.ok) {
      throw new DStorageError(
        ChainErrorCode.GATEWAY_LIST_HTTP_ERROR,
        `${COMPONENT} listReferences failed: HTTP ${res.status} ${res.statusText}`,
      );
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new DStorageError(
        ChainErrorCode.GATEWAY_LIST_INVALID_JSON,
        `${COMPONENT} listReferences failed: invalid JSON response`,
      );
    }
    if (!Array.isArray(data)) {
      throw new DStorageError(
        ChainErrorCode.GATEWAY_LIST_NOT_ARRAY,
        `${COMPONENT} listReferences failed: expected array in response`,
      );
    }
    const valid: DataReferenceSummary[] = [];
    for (let i = 0; i < data.length; i++) {
      const item = data[i];
      const it = item as Record<string, unknown>;
      if (
        item === null ||
        typeof item !== "object" ||
        typeof it["refId"] !== "string" ||
        typeof it["storageProvider"] !== "string" ||
        typeof it["keyEnvelope"] !== "string"
      ) {
        this.logger?.warn(
          COMPONENT,
          `listReferences: skipping item at index ${i} — invalid shape (refId=${typeof it["refId"]}, storageProvider=${typeof it["storageProvider"]}, keyEnvelope=${typeof it["keyEnvelope"]})`,
        );
        continue;
      }
      valid.push(item as DataReferenceSummary);
    }
    return valid;
  }

  async removeReference(
    refId: string,
    ownerSecret?: Uint8Array,
  ): Promise<void> {
    const url = `${this.deleteUrl}/${encodeURIComponent(refId)}`;
    const body: { ownerSecret?: string } =
      ownerSecret !== undefined
        ? { ownerSecret: bytesToBase64url(ownerSecret) }
        : {};

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new DStorageError(
        ChainErrorCode.GATEWAY_REMOVE_FAILED,
        `${COMPONENT} removeReference failed: ${String(err)}`,
        { cause: err },
      );
    }

    if (!res.ok) {
      throw new DStorageError(
        ChainErrorCode.GATEWAY_REMOVE_HTTP_ERROR,
        `${COMPONENT} removeReference failed: HTTP ${res.status} ${res.statusText}`,
      );
    }
  }

  getContractAddress(): string {
    return this.writeUrl;
  }

  async estimateCost(): Promise<ChainQuote> {
    return {
      token: "MOCK",
      amount: "0",
      network: "httpgateway",
      expiresAt: Date.now() + 60_000,
    };
  }
}
