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
      const fetchMock = mockFetch({});
      vi.stubGlobal("fetch", fetchMock);

      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
      });
      const ref: ChainReference = { ...makeRef("wr1"), refId: "ref_abc123" };
      const result = await adapter.writeReference(ref);

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${WRITE_URL}/ref_abc123`);
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

    it("uses writtenAt from the ref (response body is ignored)", async () => {
      vi.stubGlobal("fetch", mockFetch({}));

      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
      });
      const ref = makeRef("wr3");
      const result = await adapter.writeReference(ref);
      expect(result.writtenAt).toBe(ref.writtenAt);
    });

    it("generates a non-empty refId when none is provided", async () => {
      vi.stubGlobal("fetch", mockFetch({}));

      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
      });
      const result = await adapter.writeReference(makeRef("wr_gen"));
      expect(typeof result.refId).toBe("string");
      expect(result.refId.length).toBeGreaterThan(0);
    });

    it("does not include blockHeight (response body is not parsed)", async () => {
      vi.stubGlobal("fetch", mockFetch({ blockHeight: 42 }));

      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
      });
      const result = await adapter.writeReference(makeRef("wr4"));
      expect(result.blockHeight).toBeUndefined();
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

  // ── updateReference ─────────────────────────────────────────────────────────

  describe("updateReference", () => {
    const makeUpdate = (): import("../types.js").ChainReferenceUpdate => ({
      storageId: "updated_store_id",
      encryptionScheme: "xchacha20poly1305-v1",
      storageProvider: "mock",
      writtenAt: 1_700_000_001_000,
      keyEnvelope: '{"v":2}',
    });

    it("PUTs to {writeUrl}/{refId} with update as JSON body", async () => {
      const fetchMock = mockFetch({});
      vi.stubGlobal("fetch", fetchMock);

      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
      });
      await adapter.updateReference("ref_123", makeUpdate());

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${WRITE_URL}/ref_123`);
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
        "application/json",
      );
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body["storageId"]).toBe("updated_store_id");
    });

    it("does not transmit ownerSecret", async () => {
      vi.stubGlobal("fetch", mockFetch({}));

      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
      });
      await adapter.updateReference(
        "ref_123",
        makeUpdate(),
        new Uint8Array(32).fill(9),
      );

      const [, init] = (
        vi.mocked(fetch) as unknown as {
          mock: { calls: [string, RequestInit][] };
        }
      ).mock.calls[0]!;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body).not.toHaveProperty("ownerSecret");
    });

    it("throws with [dStorage/http-gateway-chain] prefix on non-2xx", async () => {
      vi.stubGlobal("fetch", mockFetch({}, 500));

      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
      });
      await expect(
        adapter.updateReference("ref_err", makeUpdate()),
      ).rejects.toThrow(
        "[dStorage/http-gateway-chain] updateReference failed: HTTP 500",
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
      await expect(
        adapter.updateReference("ref_net", makeUpdate()),
      ).rejects.toThrow("[dStorage/http-gateway-chain] updateReference failed");
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

    it("throws when server returns empty object {}", async () => {
      vi.stubGlobal("fetch", mockFetch({}));
      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
      });
      await expect(adapter.readReference("ref_bad")).rejects.toThrow(
        "[dStorage/http-gateway-chain] readReference failed: invalid response shape",
      );
    });

    it("throws when server returns wrong-shape object", async () => {
      vi.stubGlobal("fetch", mockFetch({ foo: "bar", count: 42 }));
      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
      });
      await expect(adapter.readReference("ref_bad")).rejects.toThrow(
        "[dStorage/http-gateway-chain] readReference failed: invalid response shape",
      );
    });

    it("throws when server returns non-JSON body", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () => Promise.reject(new SyntaxError("Unexpected token")),
        }),
      );
      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
      });
      await expect(adapter.readReference("ref_bad")).rejects.toThrow(
        "[dStorage/http-gateway-chain] readReference failed: invalid JSON response",
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

    it("throws when server returns non-array (empty object)", async () => {
      vi.stubGlobal("fetch", mockFetch({}));
      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
        listUrl: LIST_URL,
      });
      await expect(adapter.listReferences()).rejects.toThrow(
        "[dStorage/http-gateway-chain] listReferences failed: expected array in response",
      );
    });

    it("throws when server returns array with empty item {}", async () => {
      vi.stubGlobal("fetch", mockFetch([{}]));
      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
        listUrl: LIST_URL,
      });
      await expect(adapter.listReferences()).rejects.toThrow(
        "[dStorage/http-gateway-chain] listReferences failed: invalid item shape in response",
      );
    });

    it("throws when server returns array with wrong-shape item", async () => {
      vi.stubGlobal("fetch", mockFetch([{ foo: "bar", storageId: "s1" }]));
      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
        listUrl: LIST_URL,
      });
      await expect(adapter.listReferences()).rejects.toThrow(
        "[dStorage/http-gateway-chain] listReferences failed: invalid item shape in response",
      );
    });

    it("throws when server returns non-JSON body", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () => Promise.reject(new SyntaxError("Unexpected token")),
        }),
      );
      const adapter = new HttpGatewayChainAdapter({
        writeUrl: WRITE_URL,
        readUrl: READ_URL,
        listUrl: LIST_URL,
      });
      await expect(adapter.listReferences()).rejects.toThrow(
        "[dStorage/http-gateway-chain] listReferences failed: invalid JSON response",
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
