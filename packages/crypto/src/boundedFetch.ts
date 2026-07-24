/**
 * @dstorage/crypto — boundedFetch.ts
 * Shared helper for reading a fetch Response body with a hard size cap —
 * used by chain/storage HTTP adapters to avoid a hostile or misbehaving
 * gateway exhausting memory with an oversized response.
 */

import { DStorageError } from "./errors.js";

export interface BoundedTextReadOptions {
  /** Maximum number of bytes/characters allowed in the response body. */
  maxBytes: number;
  /** Error code to throw (caller-owned, package-specific) when the cap is exceeded. */
  code: number;
  /** Prefix identifying the caller/operation in the thrown error message. */
  component: string;
}

/**
 * Reads a fetch Response body as text, aborting once the accumulated size
 * exceeds `maxBytes`.
 *
 * Uses a streaming reader when the Response exposes `.body` (always true for
 * real `fetch()` responses), so a gateway that omits or lies about
 * `Content-Length` (e.g. chunked transfer encoding) can't force an unbounded
 * read — the read is aborted as soon as the limit is crossed, before the
 * full body is buffered. Falls back to a single `.text()` read + post-hoc
 * length check only when `.body` is unavailable (e.g. non-streaming
 * environments or simple test doubles).
 */
export async function readResponseTextWithLimit(
  res: Response,
  opts: BoundedTextReadOptions,
): Promise<string> {
  const contentLength = res.headers?.get?.("content-length");
  if (contentLength) {
    const len = Number(contentLength);
    if (Number.isFinite(len) && len > opts.maxBytes) {
      throw new DStorageError(
        opts.code,
        `${opts.component} failed: response Content-Length (${len} bytes) exceeds ` +
          `the maximum allowed size of ${opts.maxBytes} bytes.`,
      );
    }
  }

  if (!res.body) {
    const text = await res.text();
    if (text.length > opts.maxBytes) {
      throw new DStorageError(
        opts.code,
        `${opts.component} failed: response body exceeds the maximum allowed size ` +
          `of ${opts.maxBytes} bytes.`,
      );
    }
    return text;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > opts.maxBytes) {
        throw new DStorageError(
          opts.code,
          `${opts.component} failed: response body exceeds the maximum allowed size ` +
            `of ${opts.maxBytes} bytes.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}
