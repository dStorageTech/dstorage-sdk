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
  ChainWriteResult,
  ChainAdapterLogger,
  DataReferenceSummary,
  ChainQuote,
  WalletBalances,
} from "../types.js";
import { bytesToBase64url } from "@dstorage/crypto";

const COMPONENT = "[dStorage/http-gateway-chain]";

function generateRefId(): string {
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `ref_${id}`;
}

export interface HttpGatewayChainAdapterConfig {
  /** POST base URL — refId is appended as a path segment and the serialised ChainReference is sent as a JSON body: POST {writeUrl}/{refId} */
  writeUrl: string;
  /** GET base URL — refId is appended as a path segment: GET {readUrl}/{refId} */
  readUrl: string;
  /** Optional GET endpoint for listReferences. Throws if absent when called. */
  listUrl?: string;
  /**
   * Optional DELETE endpoint for removeReference.
   * DELETE {deleteUrl}/{refId} is called with a JSON body containing the
   * base64url-encoded ownerSecret (if provided).
   * Throws if absent when called.
   */
  deleteUrl?: string;
  logger?: ChainAdapterLogger;
}

export class HttpGatewayChainAdapter implements ChainAdapter {
  readonly name: ChainProviderName = "httpgateway";
  readonly providerName = "HTTP-Gateway-Chain-Adapter";

  private readonly logger: ChainAdapterLogger | undefined;

  constructor(private readonly config: HttpGatewayChainAdapterConfig) {
    this.logger = config.logger;
  }

  async writeReference(ref: ChainReference): Promise<ChainWriteResult> {
    // ownerSecret is an internal ZK witness — never transmit it
    const { ownerSecret: _omit, ...payload } = ref;
    const refId = ref.refId ?? generateRefId();
    const url = `${this.config.writeUrl}/${encodeURIComponent(refId)}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw new Error(`${COMPONENT} writeReference failed: ${String(err)}`);
    }

    if (!res.ok) {
      throw new Error(
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

  async readReference(refId: string): Promise<ChainReference> {
    const url = `${this.config.readUrl}/${encodeURIComponent(refId)}`;

    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      throw new Error(`${COMPONENT} readReference failed: ${String(err)}`);
    }

    if (!res.ok) {
      throw new Error(
        `${COMPONENT} readReference failed: HTTP ${res.status} ${res.statusText}`,
      );
    }

    return (await res.json()) as ChainReference;
  }

  async listReferences(): Promise<DataReferenceSummary[]> {
    if (!this.config.listUrl) {
      throw new Error(
        `${COMPONENT} listReferences failed: listUrl is missing from config`,
      );
    }

    let res: Response;
    try {
      res = await fetch(this.config.listUrl);
    } catch (err) {
      throw new Error(`${COMPONENT} listReferences failed: ${String(err)}`);
    }

    if (!res.ok) {
      throw new Error(
        `${COMPONENT} listReferences failed: HTTP ${res.status} ${res.statusText}`,
      );
    }

    return (await res.json()) as DataReferenceSummary[];
  }

  async removeReference(
    refId: string,
    ownerSecret?: Uint8Array,
  ): Promise<void> {
    if (!this.config.deleteUrl) {
      throw new Error(
        `${COMPONENT} removeReference failed: deleteUrl is missing from config`,
      );
    }

    const url = `${this.config.deleteUrl}/${encodeURIComponent(refId)}`;
    const body: { ownerSecret?: string } =
      ownerSecret !== undefined
        ? { ownerSecret: bytesToBase64url(ownerSecret) }
        : {};

    let res: Response;
    try {
      res = await fetch(url, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`${COMPONENT} removeReference failed: ${String(err)}`);
    }

    if (!res.ok) {
      throw new Error(
        `${COMPONENT} removeReference failed: HTTP ${res.status} ${res.statusText}`,
      );
    }
  }

  getContractAddress(): string {
    return this.config.writeUrl;
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
