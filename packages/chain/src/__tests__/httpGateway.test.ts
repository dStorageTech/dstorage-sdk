import { describe, it, expect, vi, afterEach } from "vitest";
import { HttpGatewayChainAdapter } from "../adapters/httpGateway.js";
import type { ChainReference } from "../types.js";
import { ChainErrorCode } from "../errors.js";

const BASE_URL = "https://example.com";
const WRITE_PATH = "/chain/write";
const READ_PATH = "/chain/read";
const LIST_PATH = "/chain/list";
const DELETE_PATH = "/chain/delete";

// Derived full URLs — used only for assertions, never for construction
const WRITE_URL = `${BASE_URL}${WRITE_PATH}`;
const READ_URL = `${BASE_URL}${READ_PATH}`;
const LIST_URL = `${BASE_URL}${LIST_PATH}`;
const DELETE_URL = `${BASE_URL}${DELETE_PATH}`;

const BASE_CONFIG = {
  baseUrl: BASE_URL,
  writePath: WRITE_PATH,
  readPath: READ_PATH,
  listPath: LIST_PATH,
  deletePath: DELETE_PATH,
};

function makeRef(suffix: string): ChainReference {
  return {
    storageId: `store_${suffix}`,
    storageProvider: "mock",
    writtenAt: 1_700_000_000_000,
    keyEnvelope: '{"v":1}',
  };
}

function mockLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
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
  // ── headers ─────────────────────────────────────────────────────────────────

  describe("headers", () => {
    const TOKEN_HEADERS = {
      Authorization: "Bearer mytoken",
      "X-Api-Key": "abc123",
    };
    const CONFIG_WITH_HEADERS = { ...BASE_CONFIG, headers: TOKEN_HEADERS };

    it("includes extra headers in writeReference POST", async () => {
      const fetchMock = mockFetch({});
      vi.stubGlobal("fetch", fetchMock);
      const adapter = new HttpGatewayChainAdapter(CONFIG_WITH_HEADERS);
      await adapter.writeReference({ ...makeRef("h1"), refId: "ref_h1" });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer mytoken");
      expect(headers["X-Api-Key"]).toBe("abc123");
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("includes extra headers in updateReference POST", async () => {
      vi.stubGlobal("fetch", mockFetch({}));
      const adapter = new HttpGatewayChainAdapter(CONFIG_WITH_HEADERS);
      await adapter.updateReference("ref_h2", {
        storageId: "s",
        encryptionScheme: "",
        storageProvider: "mock",
        writtenAt: 0,
        keyEnvelope: "{}",
      });
      const [, init] = (
        vi.mocked(fetch) as unknown as {
          mock: { calls: [string, RequestInit][] };
        }
      ).mock.calls[0]!;
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer mytoken");
    });

    it("includes extra headers in readReference GET", async () => {
      vi.stubGlobal("fetch", mockFetch(makeRef("h3")));
      const adapter = new HttpGatewayChainAdapter(CONFIG_WITH_HEADERS);
      await adapter.readReference("ref_h3");
      const [, init] = (
        vi.mocked(fetch) as unknown as {
          mock: { calls: [string, RequestInit][] };
        }
      ).mock.calls[0]!;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer mytoken");
    });

    it("includes extra headers in listReferences GET", async () => {
      vi.stubGlobal("fetch", mockFetch([]));
      const adapter = new HttpGatewayChainAdapter(CONFIG_WITH_HEADERS);
      await adapter.listReferences();
      const [, init] = (
        vi.mocked(fetch) as unknown as {
          mock: { calls: [string, RequestInit][] };
        }
      ).mock.calls[0]!;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer mytoken");
    });

    it("includes extra headers in removeReference DELETE", async () => {
      vi.stubGlobal("fetch", mockFetch(null));
      const adapter = new HttpGatewayChainAdapter(CONFIG_WITH_HEADERS);
      await adapter.removeReference("ref_h4");
      const [, init] = (
        vi.mocked(fetch) as unknown as {
          mock: { calls: [string, RequestInit][] };
        }
      ).mock.calls[0]!;
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer mytoken");
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("sends no extra headers when headers is omitted", async () => {
      const fetchMock = mockFetch({});
      vi.stubGlobal("fetch", fetchMock);
      const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
      await adapter.writeReference({ ...makeRef("h5"), refId: "ref_h5" });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers).not.toHaveProperty("Authorization");
      expect(headers["Content-Type"]).toBe("application/json");
    });
  });

  it('name is "httpgateway"', () => {
    const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
    expect(adapter.name).toBe("httpgateway");
  });

  it("getContractAddress returns writeUrl", () => {
    const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
    expect(adapter.getContractAddress()).toBe(WRITE_URL);
  });

  it("estimateCost returns zero MOCK quote", async () => {
    const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
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

      const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
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

      const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
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

      const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
      const ref = makeRef("wr3");
      const result = await adapter.writeReference(ref);
      expect(result.writtenAt).toBe(ref.writtenAt);
    });

    it("generates a non-empty refId when none is provided", async () => {
      vi.stubGlobal("fetch", mockFetch({}));

      const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
      const result = await adapter.writeReference(makeRef("wr_gen"));
      expect(typeof result.refId).toBe("string");
      expect(result.refId.length).toBeGreaterThan(0);
    });

    it("does not include blockHeight (response body is not parsed)", async () => {
      vi.stubGlobal("fetch", mockFetch({ blockHeight: 42 }));

      const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
      const result = await adapter.writeReference(makeRef("wr4"));
      expect(result.blockHeight).toBeUndefined();
    });

    it("throws with [dStorage/http-gateway-chain] prefix on non-2xx", async () => {
      vi.stubGlobal("fetch", mockFetch({}, 500));

      const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
      await expect(
        adapter.writeReference(makeRef("wr5")),
      ).rejects.toMatchObject({
        code: ChainErrorCode.GATEWAY_WRITE_HTTP_ERROR,
        message: expect.stringContaining(
          "[dStorage/http-gateway-chain] writeReference failed: HTTP 500",
        ),
      });
    });

    it("throws with [dStorage/http-gateway-chain] prefix on network error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("connection refused")),
      );

      const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
      await expect(
        adapter.writeReference(makeRef("wr6")),
      ).rejects.toMatchObject({
        code: ChainErrorCode.GATEWAY_WRITE_FAILED,
        message: expect.stringContaining(
          "[dStorage/http-gateway-chain] writeReference failed",
        ),
      });
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

      const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
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

      const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
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

      const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
      await expect(
        adapter.updateReference("ref_err", makeUpdate()),
      ).rejects.toMatchObject({
        code: ChainErrorCode.GATEWAY_UPDATE_HTTP_ERROR,
        message: expect.stringContaining(
          "[dStorage/http-gateway-chain] updateReference failed: HTTP 500",
        ),
      });
    });

    it("throws with [dStorage/http-gateway-chain] prefix on network error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("connection refused")),
      );

      const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
      await expect(
        adapter.updateReference("ref_net", makeUpdate()),
      ).rejects.toMatchObject({
        code: ChainErrorCode.GATEWAY_UPDATE_FAILED,
        message: expect.stringContaining(
          "[dStorage/http-gateway-chain] updateReference failed",
        ),
      });
    });
  });

  // ── readReference ───────────────────────────────────────────────────────────

  describe("readReference", () => {
    it("GETs {readUrl}/{refId} and returns ChainReference", async () => {
      const stored = makeRef("rr1");
      const fetchMock = mockFetch(stored);
      vi.stubGlobal("fetch", fetchMock);

      const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
      const result = await adapter.readReference("ref_rr1");

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe(`${READ_URL}/ref_rr1`);
      expect(result).toEqual(stored);
    });

    it("percent-encodes the refId in the URL", async () => {
      const fetchMock = mockFetch(makeRef("rr2"));
      vi.stubGlobal("fetch", fetchMock);

      const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
      await adapter.readReference("ref/with spaces&special=chars");

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe(`${READ_URL}/ref%2Fwith%20spaces%26special%3Dchars`);
    });

    it("throws with [dStorage/http-gateway-chain] prefix on non-2xx", async () => {
      vi.stubGlobal("fetch", mockFetch({}, 404));

      const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
      await expect(adapter.readReference("ref_missing")).rejects.toMatchObject({
        code: ChainErrorCode.GATEWAY_READ_HTTP_ERROR,
        message: expect.stringContaining(
          "[dStorage/http-gateway-chain] readReference failed: HTTP 404",
        ),
      });
    });

    it("throws when server returns empty object {}", async () => {
      vi.stubGlobal("fetch", mockFetch({}));
      const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
      await expect(adapter.readReference("ref_bad")).rejects.toMatchObject({
        code: ChainErrorCode.GATEWAY_READ_INVALID_SHAPE,
        message: expect.stringContaining(
          "[dStorage/http-gateway-chain] readReference failed: invalid response shape",
        ),
      });
    });

    it("throws when server returns wrong-shape object", async () => {
      vi.stubGlobal("fetch", mockFetch({ foo: "bar", count: 42 }));
      const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
      await expect(adapter.readReference("ref_bad")).rejects.toMatchObject({
        code: ChainErrorCode.GATEWAY_READ_INVALID_SHAPE,
        message: expect.stringContaining(
          "[dStorage/http-gateway-chain] readReference failed: invalid response shape",
        ),
      });
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
      const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
      await expect(adapter.readReference("ref_bad")).rejects.toMatchObject({
        code: ChainErrorCode.GATEWAY_READ_INVALID_JSON,
        message: expect.stringContaining(
          "[dStorage/http-gateway-chain] readReference failed: invalid JSON response",
        ),
      });
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

      const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
      const result = await adapter.listReferences();

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe(LIST_URL);
      expect(result).toEqual(summaries);
    });

    it("throws with [dStorage/http-gateway-chain] prefix on non-2xx", async () => {
      vi.stubGlobal("fetch", mockFetch({}, 503));

      const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
      await expect(adapter.listReferences()).rejects.toMatchObject({
        code: ChainErrorCode.GATEWAY_LIST_HTTP_ERROR,
        message: expect.stringContaining(
          "[dStorage/http-gateway-chain] listReferences failed: HTTP 503",
        ),
      });
    });

    it("throws when server returns non-array (empty object)", async () => {
      vi.stubGlobal("fetch", mockFetch({}));
      const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
      await expect(adapter.listReferences()).rejects.toMatchObject({
        code: ChainErrorCode.GATEWAY_LIST_NOT_ARRAY,
        message: expect.stringContaining(
          "[dStorage/http-gateway-chain] listReferences failed: expected array in response",
        ),
      });
    });

    it("skips invalid item {} and returns empty array, warns via logger", async () => {
      vi.stubGlobal("fetch", mockFetch([{}]));
      const logger = mockLogger();
      const adapter = new HttpGatewayChainAdapter({ ...BASE_CONFIG, logger });
      const result = await adapter.listReferences();
      expect(result).toEqual([]);
      expect(logger.warn).toHaveBeenCalledOnce();
      expect(logger.warn.mock.calls[0]![0]).toBe(
        "[dStorage/http-gateway-chain]",
      );
    });

    it("skips wrong-shape item and returns empty array, warns via logger", async () => {
      vi.stubGlobal("fetch", mockFetch([{ foo: "bar", storageId: "s1" }]));
      const logger = mockLogger();
      const adapter = new HttpGatewayChainAdapter({ ...BASE_CONFIG, logger });
      const result = await adapter.listReferences();
      expect(result).toEqual([]);
      expect(logger.warn).toHaveBeenCalledOnce();
    });

    it("returns valid items and warns once when array has valid and invalid entries", async () => {
      const validItem = {
        refId: "ref_mix1",
        storageId: "store_mix1",
        storageProvider: "mock",
        encryptionScheme: null,
        keyEnvelope: "{}",
        ownerCommitment: "aa".repeat(32),
      };
      const validItem2 = {
        refId: "ref_mix2",
        storageId: "store_mix2",
        storageProvider: "mock",
        encryptionScheme: null,
        keyEnvelope: "{}",
        ownerCommitment: "bb".repeat(32),
      };
      vi.stubGlobal("fetch", mockFetch([validItem, {}, validItem2]));
      const logger = mockLogger();
      const adapter = new HttpGatewayChainAdapter({ ...BASE_CONFIG, logger });
      const result = await adapter.listReferences();
      expect(result).toEqual([validItem, validItem2]);
      expect(logger.warn).toHaveBeenCalledOnce();
    });

    it("silently skips bad items when no logger is configured", async () => {
      vi.stubGlobal("fetch", mockFetch([{}]));
      const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
      await expect(adapter.listReferences()).resolves.toEqual([]);
    });

    it("does not warn when all items are valid", async () => {
      const summaries = [
        {
          refId: "ref_ok",
          storageId: "store_ok",
          storageProvider: "mock",
          encryptionScheme: null,
          keyEnvelope: "{}",
          ownerCommitment: "cc".repeat(32),
        },
      ];
      vi.stubGlobal("fetch", mockFetch(summaries));
      const logger = mockLogger();
      const adapter = new HttpGatewayChainAdapter({ ...BASE_CONFIG, logger });
      await adapter.listReferences();
      expect(logger.warn).not.toHaveBeenCalled();
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
      const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
      await expect(adapter.listReferences()).rejects.toMatchObject({
        code: ChainErrorCode.GATEWAY_LIST_INVALID_JSON,
        message: expect.stringContaining(
          "[dStorage/http-gateway-chain] listReferences failed: invalid JSON response",
        ),
      });
    });
  });

  // ── removeReference ─────────────────────────────────────────────────────────

  describe("removeReference", () => {
    it("DELETEs {deleteUrl}/{refId} with empty body when no ownerSecret", async () => {
      const fetchMock = mockFetch(null);
      vi.stubGlobal("fetch", fetchMock);

      const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
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

      const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
      const ownerSecret = new Uint8Array(32).fill(0xab);
      await adapter.removeReference("ref_del2", ownerSecret);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { ownerSecret: string };
      expect(typeof body.ownerSecret).toBe("string");
      expect(body.ownerSecret.length).toBeGreaterThan(0);
    });

    it("throws with [dStorage/http-gateway-chain] prefix on non-2xx", async () => {
      vi.stubGlobal("fetch", mockFetch({}, 403));

      const adapter = new HttpGatewayChainAdapter(BASE_CONFIG);
      await expect(adapter.removeReference("ref_del4")).rejects.toMatchObject({
        code: ChainErrorCode.GATEWAY_REMOVE_HTTP_ERROR,
        message: expect.stringContaining(
          "[dStorage/http-gateway-chain] removeReference failed: HTTP 403",
        ),
      });
    });
  });
});
