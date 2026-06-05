import { describe, it, expect, vi, afterEach } from "vitest";
import { HttpGatewayChainAdapter } from "../adapters/httpGateway.js";
import type { ChainReference } from "../types.js";

const WRITE_URL = "https://example.com/chain/write";
const READ_URL = "https://example.com/chain/read";
const LIST_URL = "https://example.com/chain/list";
const DELETE_URL = "https://example.com/chain/delete";

function makeRef(suffix: string): ChainReference {
  return {
    storageId: `store_${suffix}`,
    storageProvider: "mock",
    writtenAt: 1_700_000_000_000,
    keyEnvelope: '{"v":1}',
  };
}

function mockFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(body),
  });
}

afterEach(() => vi.restoreAllMocks());

describe("HttpGatewayChainAdapter", () => {
  it('name is "httpgateway"', () => {
    const adapter = new HttpGatewayChainAdapter({
      writeUrl: WRITE_URL,
      readUrl: READ_URL,
    });
    expect(adapter.name).toBe("httpgateway");
  });

  it("getContractAddress returns writeUrl", () => {
    const adapter = new HttpGatewayChainAdapter({
      writeUrl: WRITE_URL,
      readUrl: READ_URL,
    });
    expect(adapter.getContractAddress()).toBe(WRITE_URL);
  });

  it("estimateCost returns zero MOCK quote", async () => {
    const adapter = new HttpGatewayChainAdapter({
      writeUrl: WRITE_URL,
      readUrl: READ_URL,
    });
    const quote = await adapter.estimateCost();
    expect(quote.token).toBe("MOCK");
    expect(quote.amount).toBe("0");
    expect(quote.network).toBe("httpgateway");
    expect(quote.expiresAt).toBeGreaterThan(Date.now());
  });

  // ── writeReference ──────────────────────────────────────────────────────────

  describe("writeReference", () => {
    it("POSTs to writeUrl with JSON body and returns ChainWriteResult", async () => {
      const fetchMock = mockFetch({ refId: "ref_abc123" });
      vi.stubGlobal("fetch", fetchMock);

      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
      });
      const ref = makeRef("wr1");
      const result = await adapter.writeReference(ref);

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(WRITE_URL);
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
        "application/json",
      );

      expect(result.refId).toBe("ref_abc123");
      expect(result.provider).toBe("httpgateway");
      expect(result.writtenAt).toBe(ref.writtenAt);
    });

    it("strips ownerSecret from the POST body", async () => {
      const fetchMock = mockFetch({ refId: "ref_nosecret" });
      vi.stubGlobal("fetch", fetchMock);

      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
      });
      const ref: ChainReference = {
        ...makeRef("wr2"),
        ownerSecret: new Uint8Array(32).fill(1),
      };
      await adapter.writeReference(ref);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const sent = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(sent).not.toHaveProperty("ownerSecret");
    });

    it("uses writtenAt from server response when provided", async () => {
      const serverWrittenAt = 1_800_000_000_000;
      const fetchMock = mockFetch({
        refId: "ref_ts",
        writtenAt: serverWrittenAt,
      });
      vi.stubGlobal("fetch", fetchMock);

      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
      });
      const result = await adapter.writeReference(makeRef("wr3"));
      expect(result.writtenAt).toBe(serverWrittenAt);
    });

    it("includes blockHeight when server returns it", async () => {
      const fetchMock = mockFetch({ refId: "ref_bh", blockHeight: 42 });
      vi.stubGlobal("fetch", fetchMock);

      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
      });
      const result = await adapter.writeReference(makeRef("wr4"));
      expect(result.blockHeight).toBe(42);
    });

    it("throws with [dStorage/http-gateway-chain] prefix on non-2xx", async () => {
      vi.stubGlobal("fetch", mockFetch({}, 500));

      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
      });
      await expect(adapter.writeReference(makeRef("wr5"))).rejects.toThrow(
        "[dStorage/http-gateway-chain] writeReference failed: HTTP 500",
      );
    });

    it("throws with [dStorage/http-gateway-chain] prefix on network error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("connection refused")),
      );

      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
      });
      await expect(adapter.writeReference(makeRef("wr6"))).rejects.toThrow(
        "[dStorage/http-gateway-chain] writeReference failed",
      );
    });
  });

  // ── readReference ───────────────────────────────────────────────────────────

  describe("readReference", () => {
    it("GETs {readUrl}/{refId} and returns ChainReference", async () => {
      const stored = makeRef("rr1");
      const fetchMock = mockFetch(stored);
      vi.stubGlobal("fetch", fetchMock);

      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
      });
      const result = await adapter.readReference("ref_rr1");

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe(`${READ_URL}/ref_rr1`);
      expect(result).toEqual(stored);
    });

    it("percent-encodes the refId in the URL", async () => {
      const fetchMock = mockFetch(makeRef("rr2"));
      vi.stubGlobal("fetch", fetchMock);

      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
      });
      await adapter.readReference("ref/with spaces&special=chars");

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe(`${READ_URL}/ref%2Fwith%20spaces%26special%3Dchars`);
    });

    it("throws with [dStorage/http-gateway-chain] prefix on non-2xx", async () => {
      vi.stubGlobal("fetch", mockFetch({}, 404));

      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
      });
      await expect(adapter.readReference("ref_missing")).rejects.toThrow(
        "[dStorage/http-gateway-chain] readReference failed: HTTP 404",
      );
    });
  });

  // ── listReferences ──────────────────────────────────────────────────────────

  describe("listReferences", () => {
    it("GETs listUrl and returns DataReferenceSummary[]", async () => {
      const summaries = [
        {
          refId: "ref_l1",
          storageId: "store_l1",
          storageProvider: "mock",
          encryptionScheme: null,
          keyEnvelope: "{}",
          ownerCommitment: "aa".repeat(32),
        },
      ];
      const fetchMock = mockFetch(summaries);
      vi.stubGlobal("fetch", fetchMock);

      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
        listUrl: LIST_URL,
      });
      const result = await adapter.listReferences();

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe(LIST_URL);
      expect(result).toEqual(summaries);
    });

    it("throws when listUrl is absent from config", async () => {
      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
      });
      await expect(adapter.listReferences()).rejects.toThrow(
        "[dStorage/http-gateway-chain] listReferences failed: listUrl is missing from config",
      );
    });

    it("throws with [dStorage/http-gateway-chain] prefix on non-2xx", async () => {
      vi.stubGlobal("fetch", mockFetch({}, 503));

      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
        listUrl: LIST_URL,
      });
      await expect(adapter.listReferences()).rejects.toThrow(
        "[dStorage/http-gateway-chain] listReferences failed: HTTP 503",
      );
    });
  });

  // ── removeReference ─────────────────────────────────────────────────────────

  describe("removeReference", () => {
    it("DELETEs {deleteUrl}/{refId} with empty body when no ownerSecret", async () => {
      const fetchMock = mockFetch(null);
      vi.stubGlobal("fetch", fetchMock);

      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
        deleteUrl: DELETE_URL,
      });
      await adapter.removeReference("ref_del1");

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${DELETE_URL}/ref_del1`);
      expect(init.method).toBe("DELETE");
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body).not.toHaveProperty("ownerSecret");
    });

    it("includes base64url-encoded ownerSecret in body when provided", async () => {
      const fetchMock = mockFetch(null);
      vi.stubGlobal("fetch", fetchMock);

      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
        deleteUrl: DELETE_URL,
      });
      const ownerSecret = new Uint8Array(32).fill(0xab);
      await adapter.removeReference("ref_del2", ownerSecret);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { ownerSecret: string };
      expect(typeof body.ownerSecret).toBe("string");
      expect(body.ownerSecret.length).toBeGreaterThan(0);
    });

    it("throws when deleteUrl is absent from config", async () => {
      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
      });
      await expect(adapter.removeReference("ref_del3")).rejects.toThrow(
        "[dStorage/http-gateway-chain] removeReference failed: deleteUrl is missing from config",
      );
    });

    it("throws with [dStorage/http-gateway-chain] prefix on non-2xx", async () => {
      vi.stubGlobal("fetch", mockFetch({}, 403));

      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
        deleteUrl: DELETE_URL,
      });
      await expect(adapter.removeReference("ref_del4")).rejects.toThrow(
        "[dStorage/http-gateway-chain] removeReference failed: HTTP 403",
      );
    });
  });
});
