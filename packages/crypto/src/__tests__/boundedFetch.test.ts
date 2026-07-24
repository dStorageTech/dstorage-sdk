import { describe, it, expect, vi } from "vitest";
import { readResponseTextWithLimit } from "../boundedFetch.js";
import { DStorageError } from "../errors.js";

const CODE = 99999;
const COMPONENT = "[dStorage/test] readResponseTextWithLimit";

function chunksFrom(text: string, chunkSize: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(bytes.slice(i, i + chunkSize));
  }
  return chunks;
}

function makeStreamResponse(
  text: string,
  opts: { chunkSize?: number; contentLength?: string | null } = {},
): Response {
  const chunkSize = opts.chunkSize ?? 8;
  const chunks = chunksFrom(text, chunkSize);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return {
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-length"
          ? (opts.contentLength ?? null)
          : null,
    },
    body: stream,
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

function makeNoBodyResponse(
  text: string,
  opts: { contentLength?: string | null } = {},
): Response {
  return {
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-length"
          ? (opts.contentLength ?? null)
          : null,
    },
    body: undefined,
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

describe("readResponseTextWithLimit", () => {
  describe("streaming path (res.body present)", () => {
    it("returns the full decoded text when under the limit", async () => {
      const text = "hello world";
      const res = makeStreamResponse(text);
      const result = await readResponseTextWithLimit(res, {
        maxBytes: 1024,
        code: CODE,
        component: COMPONENT,
      });
      expect(result).toBe(text);
    });

    it("aborts mid-stream once accumulated bytes exceed the limit, even with no Content-Length", async () => {
      const text = "x".repeat(1000);
      const res = makeStreamResponse(text, { chunkSize: 16 });
      await expect(
        readResponseTextWithLimit(res, {
          maxBytes: 100,
          code: CODE,
          component: COMPONENT,
        }),
      ).rejects.toMatchObject({
        code: CODE,
        message: expect.stringContaining(COMPONENT),
      });
    });

    it("throws before reading any chunk when Content-Length already exceeds the limit", async () => {
      const text = "small body";
      const res = makeStreamResponse(text, { contentLength: "999999" });
      const readSpy = vi.spyOn(res.body!, "getReader");
      await expect(
        readResponseTextWithLimit(res, {
          maxBytes: 100,
          code: CODE,
          component: COMPONENT,
        }),
      ).rejects.toMatchObject({ code: CODE });
      expect(readSpy).not.toHaveBeenCalled();
    });

    it("thrown error is a DStorageError with the caller-supplied code", async () => {
      const res = makeStreamResponse("x".repeat(1000), { chunkSize: 16 });
      const err = await readResponseTextWithLimit(res, {
        maxBytes: 100,
        code: CODE,
        component: COMPONENT,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DStorageError);
    });
  });

  describe("fallback path (res.body absent)", () => {
    it("returns the full text when under the limit", async () => {
      const text = "hello world";
      const res = makeNoBodyResponse(text);
      const result = await readResponseTextWithLimit(res, {
        maxBytes: 1024,
        code: CODE,
        component: COMPONENT,
      });
      expect(result).toBe(text);
    });

    it("throws a post-hoc size error when the text exceeds the limit", async () => {
      const res = makeNoBodyResponse("x".repeat(1000));
      await expect(
        readResponseTextWithLimit(res, {
          maxBytes: 100,
          code: CODE,
          component: COMPONENT,
        }),
      ).rejects.toMatchObject({ code: CODE });
    });

    it("throws before reading text when Content-Length already exceeds the limit", async () => {
      const res = makeNoBodyResponse("small body", {
        contentLength: "999999",
      });
      const textSpy = vi.spyOn(res, "text");
      await expect(
        readResponseTextWithLimit(res, {
          maxBytes: 100,
          code: CODE,
          component: COMPONENT,
        }),
      ).rejects.toMatchObject({ code: CODE });
      expect(textSpy).not.toHaveBeenCalled();
    });
  });
});
