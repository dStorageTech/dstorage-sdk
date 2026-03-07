import { describe, it, expect } from "vitest";
import { AutonomiStorageAdapter } from "../adapters/autonomi.js";

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
      const retrieved = await adapter.retrieve(id);
      expect(retrieved).toEqual(data);
    });

    it("retrieves arbitrary binary data unchanged", async () => {
      const adapter = new AutonomiStorageAdapter();
      const data = new Uint8Array([0, 1, 2, 128, 255]);
      const { id } = await adapter.upload(data);
      const retrieved = await adapter.retrieve(id);
      expect(retrieved).toEqual(data);
    });

    it("throws for unknown id", async () => {
      const adapter = new AutonomiStorageAdapter();
      await expect(adapter.retrieve("autonomi_nonexistent")).rejects.toThrow(
        "[dStorage/autonomi]",
      );
    });

    it("multiple items: each id retrieves its own data", async () => {
      const adapter = new AutonomiStorageAdapter();
      const r1 = await adapter.upload(enc("content A"));
      const r2 = await adapter.upload(enc("content B"));
      expect(await adapter.retrieve(r1.id)).toEqual(enc("content A"));
      expect(await adapter.retrieve(r2.id)).toEqual(enc("content B"));
    });
  });

  // ── estimateCost ──────────────────────────────────────────────────────────

  describe("estimateCost", () => {
    it("returns the byte length of the data as cost", async () => {
      const adapter = new AutonomiStorageAdapter();
      const data = enc("some data");
      const cost = await adapter.estimateCost(data);
      expect(cost).toBe(`${data.byteLength}`);
    });

    it("returns different costs for different data sizes", async () => {
      const adapter = new AutonomiStorageAdapter();
      const costSmall = await adapter.estimateCost(enc("x"));
      const costLarge = await adapter.estimateCost(new Uint8Array(1_000_000));
      expect(costSmall).not.toBe(costLarge);
    });

    it("returns '0' for empty input", async () => {
      const adapter = new AutonomiStorageAdapter();
      const cost = await adapter.estimateCost(new Uint8Array(0));
      expect(cost).toBe("0");
    });
  });
});
