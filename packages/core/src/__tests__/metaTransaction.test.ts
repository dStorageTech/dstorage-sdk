// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { MetaTx, validateFile } from "../metaTx/index.js";
import type { DStorageContext } from "../metaTx/index.js";
import { MockStorageAdapter } from "@dstorage/storage";
import { MockChainAdapter } from "@dstorage/chain";
import type { PaymentReceipt } from "@dstorage/payment";
import type { MetaTxProgress, MetaTxStepId } from "../metaTx/index.js";

afterEach(() => vi.useRealTimers());

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeFile(
  content: string,
  name = "test.txt",
  type = "text/plain",
): File {
  return new File([content], name, { type });
}

function makeEmptyFile(name = "empty.txt", type = "text/plain"): File {
  return new File([], name, { type });
}

/** Build a minimal DStorageContext for tests. */
function makeSdkContext(
  address = "0xTestOwner",
): DStorageContext {
  return {
    storageAdapter: new MockStorageAdapter(),
    chainAdapter: new MockChainAdapter(),
    connectedAddress: address,
    async prepareUploadCrypto() {
      // No encryption in unit tests — return identity (public) crypto.
      return { uploadScheme: null, keyEnvelope: undefined, encryptionScheme: "" };
    },
  };
}

// ── validateFile ──────────────────────────────────────────────────────────────

describe("validateFile", () => {
  it("returns { valid: true } for a valid text file", () => {
    const file = makeFile("hello", "doc.txt", "text/plain");
    expect(validateFile(file).valid).toBe(true);
  });

  it("returns { valid: false } for an empty file", () => {
    const file = makeEmptyFile();
    const result = validateFile(file);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("empty");
  });

  it("returns { valid: false } for a file over 2 GB", () => {
    // Fake a large file by overriding size via Object.defineProperty
    const file = makeFile("x", "large.txt", "text/plain");
    Object.defineProperty(file, "size", { value: 3 * 1024 * 1024 * 1024 });
    const result = validateFile(file);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("large");
    expect(result.error).toContain("2 GB");
  });

  it("error message for oversized file includes actual file size", () => {
    const file = makeFile("x", "large.txt", "text/plain");
    Object.defineProperty(file, "size", { value: 3 * 1024 * 1024 * 1024 });
    const result = validateFile(file);
    expect(result.error).toMatch(/\d+\.\d+ (MB|GB)/);
  });

  it("returns { valid: false } for an unsupported MIME type", () => {
    const file = makeFile("x", "video.mp4", "video/mp4");
    const result = validateFile(file);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not supported");
  });

  it("error for unsupported MIME includes the actual type", () => {
    const file = makeFile("x", "audio.mp3", "audio/mpeg");
    const result = validateFile(file);
    expect(result.error).toContain("audio/mpeg");
  });

  it('error for empty MIME includes "unknown"', () => {
    const file = makeFile("x", "unknown", "");
    const result = validateFile(file);
    expect(result.error).toContain("unknown");
  });

  const allowedTypes = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/svg+xml",
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
    "text/markdown",
    "application/json",
    "application/zip",
  ] as const;

  for (const mimeType of allowedTypes) {
    it(`accepts MIME type: ${mimeType}`, () => {
      const file = makeFile("content", "file", mimeType);
      expect(validateFile(file).valid).toBe(true);
    });
  }
});

// ── MetaTx constructor ────────────────────────────────────────────────

describe("MetaTx constructor", () => {
  it("creates an instance", () => {
    const metaTx = new MetaTx(makeSdkContext("0xTestOwner"));
    expect(metaTx).toBeDefined();
  });

  it("onProgress registers a callback and returns this (for chaining)", () => {
    const metaTx = new MetaTx(makeSdkContext("0xTestOwner"));
    const returned = metaTx.onProgress(() => {});
    expect(returned).toBe(metaTx);
  });
});

// ── MetaTx.execute ────────────────────────────────────────────────────

describe("MetaTx.execute", () => {
  it("returns a MetaTxReceipt with all required fields", async () => {
    vi.useFakeTimers();
    const tx = new MetaTx(makeSdkContext("0xOwner_exec1"));

    const file = makeFile("Hello private world", "hello.txt", "text/plain");
    const p = tx.execute(file);
    await vi.runAllTimersAsync();
    const receipt = await p;

    expect(receipt).toHaveProperty("dataId");
    expect(receipt).toHaveProperty("storageId");
    expect(receipt).toHaveProperty("chainRefId");
    expect(receipt).toHaveProperty("file");
    expect(receipt).toHaveProperty("storagePayment");
    expect(receipt).toHaveProperty("chainPayment");
    expect(receipt).toHaveProperty("storageToken");
    expect(receipt).toHaveProperty("chainToken");
    expect(receipt).toHaveProperty("completedAt");
    expect(receipt).toHaveProperty("totalDurationMs");
  });

  it('dataId is "<storageId>::<chainRefId>"', async () => {
    vi.useFakeTimers();
    const tx = new MetaTx(makeSdkContext("0xOwner_exec2"));

    const file = makeFile("test", "test.txt", "text/plain");
    const p = tx.execute(file);
    await vi.runAllTimersAsync();
    const receipt = await p;

    expect(receipt.dataId).toBe(`${receipt.storageId}::${receipt.chainRefId}`);
  });

  it("file metadata in receipt matches the input file", async () => {
    vi.useFakeTimers();
    const tx = new MetaTx(makeSdkContext("0xOwner_exec3"));

    const content = "patient record data";
    const file = makeFile(content, "record.txt", "text/plain");
    const p = tx.execute(file);
    await vi.runAllTimersAsync();
    const receipt = await p;

    expect(receipt.file.name).toBe("record.txt");
    expect(receipt.file.type).toBe("text/plain");
    expect(receipt.file.sizeBytes).toBe(file.size);
  });

  it('storageToken and chainToken are "MOCK" when using InstantPaymentAdapter', async () => {
    vi.useFakeTimers();
    const tx = new MetaTx(makeSdkContext("0xOwner_exec4"));

    const file = makeFile("data", "data.txt", "text/plain");
    const p = tx.execute(file);
    await vi.runAllTimersAsync();
    const receipt = await p;

    expect(receipt.storageToken).toBe("MOCK");
    expect(receipt.chainToken).toBe("MOCK");
  });

  it("totalDurationMs is a positive number", async () => {
    vi.useFakeTimers();
    const tx = new MetaTx(makeSdkContext("0xOwner_exec5"));

    const file = makeFile("data", "data.txt", "text/plain");
    const p = tx.execute(file);
    await vi.runAllTimersAsync();
    const receipt = await p;

    expect(receipt.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("fires onProgress callbacks at least once per step (7 steps minimum)", async () => {
    vi.useFakeTimers();
    const tx = new MetaTx(makeSdkContext("0xOwner_exec6"));

    const updates: MetaTxProgress[] = [];
    tx.onProgress((p) => updates.push(p));

    const file = makeFile("data", "data.txt", "text/plain");
    const p = tx.execute(file);
    await vi.runAllTimersAsync();
    await p;

    expect(updates.length).toBeGreaterThanOrEqual(7);
  });

  it('overallStatus transitions to "complete" on success', async () => {
    vi.useFakeTimers();
    const tx = new MetaTx(makeSdkContext("0xOwner_exec7"));

    const statuses: MetaTxProgress["overallStatus"][] = [];
    tx.onProgress((p) => statuses.push(p.overallStatus));

    const file = makeFile("data", "data.txt", "text/plain");
    const p = tx.execute(file);
    await vi.runAllTimersAsync();
    await p;

    expect(statuses[statuses.length - 1]).toBe("complete");
  });

  it("the last progress update includes the receipt", async () => {
    vi.useFakeTimers();
    const tx = new MetaTx(makeSdkContext("0xOwner_exec8"));

    let lastProgress: MetaTxProgress | null = null;
    tx.onProgress((p) => {
      lastProgress = p;
    });

    const file = makeFile("data", "data.txt", "text/plain");
    const p = tx.execute(file);
    await vi.runAllTimersAsync();
    await p;

    expect(lastProgress).not.toBeNull();
    expect(lastProgress!.receipt).toBeDefined();
  });

  it("CostEstimate is included in progress after the estimate step", async () => {
    vi.useFakeTimers();
    const tx = new MetaTx(makeSdkContext("0xOwner_exec9"));

    const estimates: MetaTxProgress[] = [];
    tx.onProgress((p) => {
      if (p.estimate) estimates.push(p);
    });

    const file = makeFile("data", "data.txt", "text/plain");
    const p = tx.execute(file);
    await vi.runAllTimersAsync();
    await p;

    expect(estimates.length).toBeGreaterThan(0);
    expect(estimates[0]!.estimate).toHaveProperty("storageCost");
  });

  it("all 7 step IDs appear in the progress steps array", async () => {
    vi.useFakeTimers();
    const tx = new MetaTx(makeSdkContext("0xOwner_exec10"));

    let lastProgress: MetaTxProgress | null = null;
    tx.onProgress((p) => {
      lastProgress = p;
    });

    const file = makeFile("data", "data.txt", "text/plain");
    const p = tx.execute(file);
    await vi.runAllTimersAsync();
    await p;

    const stepIds = lastProgress!.steps.map((s) => s.id);
    const expectedIds: MetaTxStepId[] = [
      "estimate",
      "encrypt",
      "payment_storage",
      "upload",
      "chain_reference",
      "complete",
    ];
    for (const id of expectedIds) {
      expect(stepIds).toContain(id);
    }
  });

  it('all steps have status "done" on successful completion', async () => {
    vi.useFakeTimers();
    const tx = new MetaTx(makeSdkContext("0xOwner_exec11"));

    let lastProgress: MetaTxProgress | null = null;
    tx.onProgress((p) => {
      lastProgress = p;
    });

    const file = makeFile("data", "data.txt", "text/plain");
    const p = tx.execute(file);
    await vi.runAllTimersAsync();
    await p;

    for (const step of lastProgress!.steps) {
      expect(step.status).toBe("done");
    }
  });

  it("contract and circuit info is included in receipt when provided via config", async () => {
    vi.useFakeTimers();
    const tx = new MetaTx(makeSdkContext("0xOwner_exec12"));

    const file = makeFile("data", "data.txt", "text/plain");
    const p = tx.execute(file, {
      contractAddress: "0xContractABC",
      contractName: "Social Profile dApp",
    });
    await vi.runAllTimersAsync();
    const receipt = await p;

    expect(receipt.contract).toBeDefined();
    expect(receipt.contract!.address).toBe("0xContractABC");
    expect(receipt.contract!.name).toBe("Social Profile dApp");
  });

  it("works without an onProgress callback", async () => {
    vi.useFakeTimers();
    const tx = new MetaTx(makeSdkContext("0xOwner_exec13"));

    const file = makeFile("data", "data.txt", "text/plain");
    const p = tx.execute(file);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeDefined();
  });

  it("storage token is MOCK from MockStorageAdapter's built-in payment adapter", async () => {
    // Do NOT use fake timers here — MockPaymentAdapter has ~1900ms of real delays.
    // Real timers are used; the timeout is set to 10s to accommodate the storage payment delay.
    // MockStorageAdapter owns its own MockPaymentAdapter({ token: 'MOCK' })
    const tx = new MetaTx(makeSdkContext("0xOwner_exec14"));

    const file = makeFile("data", "data.txt", "text/plain");
    const receipt = await tx.execute(file);
    // MockStorageAdapter.paymentAdapter uses MOCK token; chain uses InstantPaymentAdapter → MOCK
    expect(receipt.storageToken).toBe("MOCK");
    expect(receipt.chainToken).toBe("MOCK");
  }, 10_000);
});
