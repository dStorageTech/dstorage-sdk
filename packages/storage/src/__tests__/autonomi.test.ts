import { describe, it, expect } from "vitest";
import { AutonomiStorageAdapter } from "../adapters/autonomi.js";
import { StorageErrorCode } from "../errors.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("AutonomiStorageAdapter", () => {
  it('name is "autonomi"', () => {
    const adapter = new AutonomiStorageAdapter();
    expect(adapter.name).toBe("autonomi");
  });

  // ── upload ───────────────────────────────────────────────────────────────

  describe("upload", () => {
    it("returns an UploadResult with all required fields", async () => {
      const adapter = new AutonomiStorageAdapter();
      const result = await adapter.upload(enc("hello autonomi"));
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("provider", "autonomi");
      expect(result).toHaveProperty("uploadedAt");
    });

    it('id starts with "autonomi_"', async () => {
      const adapter = new AutonomiStorageAdapter();
      const result = await adapter.upload(enc("data"));
      expect(result.id.startsWith("autonomi_")).toBe(true);
    });

    it("each upload returns a unique id", async () => {
      const adapter = new AutonomiStorageAdapter();
      const r1 = await adapter.upload(enc("a"));
      const r2 = await adapter.upload(enc("b"));
      expect(r1.id).not.toBe(r2.id);
    });

    it("uploads arbitrary binary data without error", async () => {
      const adapter = new AutonomiStorageAdapter();
      const result = await adapter.upload(new Uint8Array([0, 1, 2, 255]));
      expect(result.id).toBeDefined();
    });
  });

  // ── retrieve ─────────────────────────────────────────────────────────────

  describe("retrieve", () => {
    it("returns the exact bytes that were uploaded", async () => {
      const adapter = new AutonomiStorageAdapter();
      const data = enc("exact content match");
      const { id } = await adapter.upload(data);
      const { bytes } = await adapter.retrieve(id);
      expect(bytes).toEqual(data);
    });

    it("retrieves arbitrary binary data unchanged", async () => {
      const adapter = new AutonomiStorageAdapter();
      const data = new Uint8Array([0, 1, 2, 128, 255]);
      const { id } = await adapter.upload(data);
      const { bytes } = await adapter.retrieve(id);
      expect(bytes).toEqual(data);
    });

    it("throws for unknown id", async () => {
      const adapter = new AutonomiStorageAdapter();
      await expect(
        adapter.retrieve("autonomi_nonexistent"),
      ).rejects.toMatchObject({
        code: StorageErrorCode.AUTONOMI_DATA_NOT_FOUND,
        message: expect.stringContaining("[dStorage/autonomi]"),
      });
    });

    it("multiple items: each id retrieves its own data", async () => {
      const adapter = new AutonomiStorageAdapter();
      const r1 = await adapter.upload(enc("content A"));
      const r2 = await adapter.upload(enc("content B"));
      expect((await adapter.retrieve(r1.id)).bytes).toEqual(enc("content A"));
      expect((await adapter.retrieve(r2.id)).bytes).toEqual(enc("content B"));
    });
  });

  // ── estimateCost ──────────────────────────────────────────────────────────

  describe("estimateCost", () => {
    it("returns a StorageQuote with amount equal to byte length", async () => {
      const adapter = new AutonomiStorageAdapter();
      const data = enc("some data");
      const quote = await adapter.estimateCost(data.byteLength);
      expect(quote).toMatchObject({
        token: "ANT",
        amount: `${data.byteLength}`,
        provider: "autonomi",
      });
    });

    it("returns different amounts for different data sizes", async () => {
      const adapter = new AutonomiStorageAdapter();
      const small = await adapter.estimateCost(enc("x").byteLength);
      const large = await adapter.estimateCost(1_000_000);
      expect(small.amount).not.toBe(large.amount);
    });

    it("returns '0' amount for empty input", async () => {
      const adapter = new AutonomiStorageAdapter();
      const quote = await adapter.estimateCost(0);
      expect(quote.amount).toBe("0");
    });
  });
});
