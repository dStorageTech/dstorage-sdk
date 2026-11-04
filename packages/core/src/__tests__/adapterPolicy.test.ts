/**
 * @dstorage/core — adapter policy tests
 *
 * Covers the storagePolicy/chainPolicy hooks: ordering, retries, abort,
 * continue, onComplete, the limits on each operation, and the errors a policy
 * can end an operation with.
 */
import { describe, it, expect, vi } from "vitest";
import { DStorage } from "../dStorage.js";
import { runWithPolicy, MAX_ATTEMPTS_PER_CANDIDATE } from "../adapterPolicy.js";
import type { PolicyRun } from "../adapterPolicy.js";
import { MockStorageAdapter } from "@dstorage/storage";
import { MidnightSimulatorChainAdapter } from "@dstorage/chain";
import { PasswordEncryptionAdapter } from "@dstorage/encryption";
import { DStorageError } from "@dstorage/crypto";
import {
  AdapterPolicyError,
  CoreErrorCode,
  StorePartialError,
  isAdapterPolicyError,
} from "../errors.js";
import type { AdapterFailure } from "../errors.js";
import type { DStorageConfig } from "../types.js";

const enc = (s: string) => new TextEncoder().encode(s);

const encryption = () =>
  new PasswordEncryptionAdapter({
    password: "dstorage-test-passphrase-v1!",
    salt: "adapter-policy",
    params: { N: 32768, r: 8, p: 1 },
  });

function brokenStorage() {
  const adapter = new MockStorageAdapter();
  vi.spyOn(adapter, "store").mockRejectedValue(new Error("storage down"));
  return adapter;
}

async function sdk(config: Partial<DStorageConfig>) {
  const ds = new DStorage({
    storageAdapters: [new MockStorageAdapter()],
    chainAdapters: [new MidnightSimulatorChainAdapter()],
    encryptionAdapters: [encryption()],
    ...config,
  });
  await ds.init();
  return ds;
}

type Target = { name: string; fn: () => Promise<string> };

/** A run over named targets, for exercising the engine without an SDK. */
function engineRun(
  targets: Target[],
  policy: PolicyRun<Target, string>["policy"],
  rules: Partial<PolicyRun<Target, string>["rules"]> = {},
): PolicyRun<Target, string> {
  return {
    kind: "storage",
    operation: "store",
    policy,
    candidates: targets.map((target, index) => ({
      target,
      info: {
        adapter: {
          index,
          name: target.name,
          providerName: target.name,
        },
      },
    })),
    attempt: (target) => target.fn(),
    rules: {
      allowContinue: true,
      pinned: false,
      commits: false,
      defaultOnFailure: "next",
      ...rules,
    },
    sleep: vi.fn(async () => {}),
  };
}

const exhausted = () => new DStorageError(1, "[dStorage] all failed");
const ok = (name: string): Target => ({
  name,
  fn: vi.fn(async () => name),
});
const failing = (name: string, message = `${name} down`): Target => ({
  name,
  fn: vi.fn(async () => {
    throw new Error(message);
  }),
});

describe("constructor validation", () => {
  it("rejects a hook that isn't a function", () => {
    expect(
      () =>
        new DStorage({
          storageAdapters: [new MockStorageAdapter()],
          storagePolicy: { onFailure: "next" } as never,
        }),
    ).toThrowError(
      expect.objectContaining({
        code: CoreErrorCode.CONFIG_POLICY_INVALID,
        message: expect.stringContaining("storagePolicy.onFailure"),
      }),
    );
  });

  it("rejects a policy that isn't an object", () => {
    expect(
      () =>
        new DStorage({
          storageAdapters: [new MockStorageAdapter()],
          chainPolicy: "stop" as never,
        }),
    ).toThrowError(
      expect.objectContaining({ code: CoreErrorCode.CONFIG_POLICY_INVALID }),
    );
  });

  it("rejects more adapters than a reference can record as copies", () => {
    const adapters = Array.from({ length: 18 }, () => new MockStorageAdapter());
    expect(
      () =>
        new DStorage({
          storageAdapters: adapters,
          storagePolicy: { onSuccess: () => "continue" },
        }),
    ).toThrowError(
      expect.objectContaining({ code: CoreErrorCode.CONFIG_POLICY_INVALID }),
    );
  });
});

describe("engine: no policy", () => {
  it("stops at the first success", async () => {
    const [a, b] = [ok("a"), ok("b")];
    const { result, successes } = await runWithPolicy(
      engineRun([a, b], undefined),
      exhausted,
    );
    expect(result).toBe("a");
    expect(successes).toHaveLength(1);
    expect(b.fn).not.toHaveBeenCalled();
  });

  it("keeps failure entries to adapterName and error", async () => {
    const buildError = vi.fn((_failures: AdapterFailure[]) => exhausted());
    await expect(
      runWithPolicy(
        engineRun([failing("a"), failing("b")], undefined),
        buildError,
      ),
    ).rejects.toThrow("all failed");
    const failures = buildError.mock.calls[0]![0];
    expect(failures.map((f) => Object.keys(f).sort())).toEqual([
      ["adapterName", "error"],
      ["adapterName", "error"],
    ]);
  });

  it("rethrows a single candidate's error as is", async () => {
    await expect(
      runWithPolicy(engineRun([failing("a")], undefined), exhausted),
    ).rejects.toThrow("a down");
  });
});

describe("engine: order", () => {
  it("reorders and filters candidates", async () => {
    const [a, b, c] = [ok("a"), ok("b"), ok("c")];
    const { result } = await runWithPolicy(
      engineRun([a, b, c], {
        order: ({ candidates }) => [candidates[2]!, candidates[0]!],
      }),
      exhausted,
    );
    expect(result).toBe("c");
    expect(a.fn).not.toHaveBeenCalled();
    expect(b.fn).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty array", () => []],
    ["something other than an array", () => "a"],
    ["a candidate twice", (ctx: any) => [ctx.candidates[0], ctx.candidates[0]]],
    [
      "an object not from ctx.candidates",
      (ctx: any) => [{ ...ctx.candidates[0] }],
    ],
  ])("treats returning %s as an invalid decision", async (_label, order) => {
    await expect(
      runWithPolicy(engineRun([ok("a")], { order: order as never }), exhausted),
    ).rejects.toMatchObject({
      code: CoreErrorCode.ADAPTER_POLICY_INVALID_DECISION,
      hook: "order",
    });
  });

  it("isn't called for a pinned operation", async () => {
    const order = vi.fn();
    await runWithPolicy(
      engineRun([ok("a")], { order }, { pinned: true }),
      exhausted,
    );
    expect(order).not.toHaveBeenCalled();
  });
});

describe("engine: onFailure", () => {
  it("retries with the requested delay, then succeeds", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValue("a");
    const run = engineRun([{ name: "a", fn }], {
      onFailure: () => ({ action: "retry", delayMs: 250 }),
    });
    const { result } = await runWithPolicy(run, exhausted);
    expect(result).toBe("a");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(run.sleep).toHaveBeenCalledWith(250);
  });

  it("numbers attempts from 1 per candidate", async () => {
    const seen: Array<[string, number]> = [];
    await runWithPolicy(
      engineRun([failing("a"), ok("b")], {
        onFailure: ({ adapter, attempt }) => {
          seen.push([adapter.name, attempt]);
          return attempt < 2 ? { action: "retry" } : "next";
        },
      }),
      exhausted,
    );
    expect(seen).toEqual([
      ["a", 1],
      ["a", 2],
    ]);
  });

  it("rethrows the last error when one candidate fails after retries", async () => {
    let call = 0;
    const target: Target = {
      name: "a",
      fn: async () => {
        throw new Error(`failure ${++call}`);
      },
    };
    await expect(
      runWithPolicy(
        engineRun([target], {
          onFailure: ({ attempt }) =>
            attempt < 3 ? { action: "retry" } : "next",
        }),
        exhausted,
      ),
    ).rejects.toThrow("failure 3");
  });

  it("stops a hook that always retries at the attempt limit", async () => {
    const target = failing("a");
    await expect(
      runWithPolicy(
        engineRun([target], { onFailure: () => ({ action: "retry" }) }),
        exhausted,
      ),
    ).rejects.toMatchObject({
      code: CoreErrorCode.ADAPTER_POLICY_INVALID_DECISION,
    });
    expect(target.fn).toHaveBeenCalledTimes(MAX_ATTEMPTS_PER_CANDIDATE);
  });

  it.each([-1, 1.5, Number.NaN, 2_147_483_648, "100"])(
    "rejects a delayMs of %s",
    async (delayMs) => {
      await expect(
        runWithPolicy(
          engineRun([failing("a")], {
            onFailure: () => ({ action: "retry", delayMs: delayMs as number }),
          }),
          exhausted,
        ),
      ).rejects.toMatchObject({
        code: CoreErrorCode.ADAPTER_POLICY_INVALID_DECISION,
      });
    },
  );

  it("aborts without trying later candidates, listing the failures", async () => {
    const later = ok("b");
    const err = await runWithPolicy(
      engineRun([failing("a"), later], { onFailure: () => "abort" }),
      exhausted,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterPolicyError);
    expect((err as AdapterPolicyError).code).toBe(
      CoreErrorCode.ADAPTER_POLICY_ABORTED,
    );
    expect((err as AdapterPolicyError).failures).toHaveLength(1);
    expect((err as AdapterPolicyError).cause).toMatchObject([
      { adapterName: "a", attempt: 1, adapterIndex: 0 },
    ]);
    expect(later.fn).not.toHaveBeenCalled();
  });

  it("treats an unknown decision as invalid", async () => {
    await expect(
      runWithPolicy(
        engineRun([failing("a")], { onFailure: () => undefined as never }),
        exhausted,
      ),
    ).rejects.toMatchObject({
      code: CoreErrorCode.ADAPTER_POLICY_INVALID_DECISION,
      hook: "onFailure",
    });
  });
});

describe("engine: hook errors", () => {
  it("reports a throwing hook distinctly and doesn't fall back", async () => {
    const later = ok("b");
    const boom = new Error("hook bug");
    await expect(
      runWithPolicy(
        engineRun([failing("a"), later], {
          onFailure: () => {
            throw boom;
          },
        }),
        exhausted,
      ),
    ).rejects.toMatchObject({
      code: CoreErrorCode.ADAPTER_POLICY_HOOK_FAILED,
      hook: "onFailure",
      cause: boom,
    });
    expect(later.fn).not.toHaveBeenCalled();
  });

  it("supports async hooks", async () => {
    const { result } = await runWithPolicy(
      engineRun([failing("a"), ok("b")], {
        onFailure: async () => "next" as const,
      }),
      exhausted,
    );
    expect(result).toBe("b");
  });

  it("lets a nested policy decision end the outer operation", async () => {
    const nested = new AdapterPolicyError(
      CoreErrorCode.ADAPTER_POLICY_ABORTED,
      "[dStorage] nested abort",
      {
        kind: "storage",
        operation: "retrieveChunk",
        successes: [],
        failures: [],
        committed: false,
      },
    );
    const later = ok("b");
    await expect(
      runWithPolicy(
        engineRun(
          [
            {
              name: "a",
              fn: async () => {
                throw nested;
              },
            },
            later,
          ],
          undefined,
        ),
        exhausted,
      ),
    ).rejects.toBe(nested);
    expect(later.fn).not.toHaveBeenCalled();
  });
});

describe("engine: onSuccess and onComplete", () => {
  it("collects every success on continue, with the first as primary", async () => {
    const { result, successes } = await runWithPolicy(
      engineRun([ok("a"), failing("b"), ok("c")], {
        onSuccess: () => "continue",
      }),
      exhausted,
    );
    expect(result).toBe("a");
    expect(successes.map((s) => s.result)).toEqual(["a", "c"]);
  });

  it("doesn't call onSuccess where continue can't apply", async () => {
    const onSuccess = vi.fn(() => "continue" as const);
    const later = ok("b");
    const { result } = await runWithPolicy(
      engineRun([ok("a"), later], { onSuccess }, { allowContinue: false }),
      exhausted,
    );
    expect(result).toBe("a");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(later.fn).not.toHaveBeenCalled();
  });

  it("rejects continue when a hint explains why this configuration can't", async () => {
    await expect(
      runWithPolicy(
        engineRun(
          [ok("a")],
          { onSuccess: () => "continue" },
          { allowContinue: false, continueHint: "needs a chain" },
        ),
        exhausted,
      ),
    ).rejects.toMatchObject({
      code: CoreErrorCode.ADAPTER_POLICY_INVALID_DECISION,
      message: expect.stringContaining("needs a chain"),
      successes: [expect.objectContaining({ attempt: 1 })],
    });
  });

  it("gives onComplete every success and failure", async () => {
    const onComplete = vi.fn(() => "accept" as const);
    await runWithPolicy(
      engineRun([failing("a"), ok("b")], { onComplete }),
      exhausted,
    );
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "storage",
        operation: "store",
        successes: [expect.objectContaining({ attempt: 1 })],
        failures: [expect.objectContaining({ attempt: 1 })],
      }),
    );
  });

  it("rejects successful work when onComplete returns fail", async () => {
    await expect(
      runWithPolicy(
        engineRun([ok("a")], { onComplete: () => "fail" }),
        exhausted,
      ),
    ).rejects.toMatchObject({
      code: CoreErrorCode.ADAPTER_POLICY_REJECTED,
      committed: false,
    });
  });

  it.each(["accept", "fail"] as const)(
    "throws the usual adapter error when nothing succeeded and onComplete returns %s",
    async (decision) => {
      const onComplete = vi.fn(() => decision);
      await expect(
        runWithPolicy(
          engineRun([failing("a"), failing("b")], { onComplete }),
          exhausted,
        ),
      ).rejects.toThrow("all failed");
      expect(onComplete).toHaveBeenCalledOnce();
    },
  );

  it("skips onComplete after an abort", async () => {
    const onComplete = vi.fn(() => "accept" as const);
    await expect(
      runWithPolicy(
        engineRun([failing("a")], { onFailure: () => "abort", onComplete }),
        exhausted,
      ),
    ).rejects.toMatchObject({ code: CoreErrorCode.ADAPTER_POLICY_ABORTED });
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("recognises policy errors by code", () => {
    expect(
      isAdapterPolicyError({ code: CoreErrorCode.ADAPTER_POLICY_REJECTED }),
    ).toBe(true);
    expect(isAdapterPolicyError(new Error("other"))).toBe(false);
    expect(isAdapterPolicyError(null)).toBe(false);
  });
});

describe("hook contexts", () => {
  it("never exposes adapter instances, content or key material", async () => {
    const adapter = new MockStorageAdapter();
    let seen: unknown;
    const ds = await sdk({
      storageAdapters: [adapter],
      storagePolicy: {
        onSuccess: (ctx) => {
          seen = ctx;
          return "stop";
        },
      },
    });
    const { storageId } = await ds.store(enc("secret"));
    const ctx = seen as Record<string, any>;
    expect(ctx.operation).toBe("store");
    expect(ctx.adapter).toEqual({
      index: 0,
      name: adapter.name,
      providerName: adapter.providerName,
    });
    expect(ctx.adapter).not.toBe(adapter);
    expect(Object.isFrozen(ctx.adapter)).toBe(true);
    expect(ctx.successes[0]).toEqual({
      adapter: ctx.adapter,
      attempt: 1,
      storageId,
      provider: adapter.name,
    });
    expect(JSON.stringify(ctx)).not.toContain("keyEnvelope");
  });
});

describe("store() under a policy", () => {
  it("wraps a pre-commit chain abort as StorePartialError so recovery works", async () => {
    const chain = new MidnightSimulatorChainAdapter();
    vi.spyOn(chain, "writeReference").mockRejectedValueOnce(new Error("down"));
    const ds = await sdk({
      chainAdapters: [chain],
      chainPolicy: { onFailure: () => "abort" },
    });
    const err = await ds.store(enc("x")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorePartialError);
    expect((err as StorePartialError).cause).toMatchObject({
      code: CoreErrorCode.ADAPTER_POLICY_ABORTED,
    });
    const { chainRefId } = await ds.registerReference({
      storageId: (err as StorePartialError).recovery.storageId,
      keyEnvelope: (err as StorePartialError).recovery.keyEnvelope!,
    });
    expect(chainRefId).toBeTruthy();
  });

  it("doesn't offer recovery once the chain write has landed", async () => {
    const chain = new MidnightSimulatorChainAdapter();
    const ds = await sdk({
      chainAdapters: [chain],
      chainPolicy: {
        onComplete: ({ operation }) =>
          operation === "store" ? "fail" : "accept",
      },
    });
    const err = await ds.store(enc("x")).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(StorePartialError);
    const policyError = err as AdapterPolicyError;
    expect(policyError.code).toBe(CoreErrorCode.ADAPTER_POLICY_REJECTED);
    expect(policyError.committed).toBe(true);
    const refId = policyError.successes[0]!.refId!;
    expect((await ds.retrieveByRefId(refId)).bytes).toEqual(enc("x"));
  });

  it("writes to one chain even if onSuccess returns continue", async () => {
    const [chainA, chainB] = [
      new MidnightSimulatorChainAdapter(),
      new MidnightSimulatorChainAdapter(),
    ];
    const writeB = vi.spyOn(chainB, "writeReference");
    const ds = await sdk({
      chainAdapters: [chainA, chainB],
      chainPolicy: { onSuccess: () => "continue" },
    });
    await ds.store(enc("x"));
    expect(writeB).not.toHaveBeenCalled();
  });

  it("wipes nothing the caller needs when a storage retry eventually succeeds", async () => {
    const adapter = new MockStorageAdapter();
    const store = adapter.store.bind(adapter);
    vi.spyOn(adapter, "store")
      .mockRejectedValueOnce(new Error("blip"))
      .mockImplementation(store);
    const ds = await sdk({
      storageAdapters: [adapter],
      storagePolicy: { onFailure: () => ({ action: "retry" }) },
    });
    const { chainRefId } = await ds.store(enc("after retry"));
    expect((await ds.retrieveByRefId(chainRefId!)).bytes).toEqual(
      enc("after retry"),
    );
  });

  it("falls back on storage errors after a hook filters the order", async () => {
    const [broken, working] = [brokenStorage(), new MockStorageAdapter()];
    const ds = await sdk({
      storageAdapters: [broken, working],
      storagePolicy: { order: ({ candidates }) => [...candidates].reverse() },
    });
    await ds.store(enc("x"));
    expect(broken.store).not.toHaveBeenCalled();
  });
});

describe("init() under a policy", () => {
  class InitChain extends MidnightSimulatorChainAdapter {
    init = vi.fn(async () => "address");
  }

  it("stops at the first adapter by default", async () => {
    const [a, b] = [new InitChain(), new InitChain()];
    await sdk({ chainAdapters: [a, b] });
    expect(a.init).toHaveBeenCalledOnce();
    expect(b.init).not.toHaveBeenCalled();
  });

  it("initializes every adapter on continue", async () => {
    const [a, b] = [new InitChain(), new InitChain()];
    await sdk({
      chainAdapters: [a, b],
      chainPolicy: { onSuccess: () => "continue" },
    });
    expect(a.init).toHaveBeenCalledOnce();
    expect(b.init).toHaveBeenCalledOnce();
  });

  it("stays disconnected after a rejected init, and init can run again", async () => {
    const [a, b] = [new InitChain(), new InitChain()];
    b.init.mockRejectedValueOnce(new Error("down"));
    const ds = new DStorage({
      storageAdapters: [new MockStorageAdapter()],
      chainAdapters: [a, b],
      encryptionAdapters: [encryption()],
      chainPolicy: {
        onSuccess: () => "continue",
        onComplete: ({ failures }) => (failures.length > 0 ? "fail" : "accept"),
      },
    });
    await expect(ds.init()).rejects.toMatchObject({
      code: CoreErrorCode.ADAPTER_POLICY_REJECTED,
    });
    expect(ds.isConnected).toBe(false);
    await ds.init();
    expect(ds.isConnected).toBe(true);
  });
});

describe("operations pinned to one adapter", () => {
  it.each([
    [
      "update",
      "updateReference",
      (ds: DStorage, id: string) => ds.update(id, enc("v2")),
    ],
    [
      "rotateKeys",
      "updateReference",
      (ds: DStorage, id: string) => ds.rotateKeys(id),
    ],
    [
      "remove",
      "removeReference",
      (ds: DStorage, id: string) => ds.removeReference(id),
    ],
  ] as const)(
    "retries %s on the holding chain",
    async (operation, method, call) => {
      const chain = new MidnightSimulatorChainAdapter();
      const onFailure = vi.fn(() => ({ action: "retry" as const }));
      const ds = await sdk({
        chainAdapters: [chain],
        chainPolicy: { onFailure },
      });
      const { chainRefId } = await ds.store(enc("v1"));
      (
        vi.spyOn(chain, method) as unknown as {
          mockRejectedValueOnce(err: Error): void;
        }
      ).mockRejectedValueOnce(new Error("blip"));
      await call(ds, chainRefId!);
      expect(onFailure).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "chain", operation }),
      );
    },
  );

  it("surfaces the adapter error when a pinned operation is told to move on", async () => {
    const [holder, other] = [
      new MidnightSimulatorChainAdapter(),
      new MidnightSimulatorChainAdapter(),
    ];
    const otherRemove = vi.spyOn(other, "removeReference");
    const ds = await sdk({
      chainAdapters: [holder, other],
      chainPolicy: { onFailure: () => "next" },
    });
    const { chainRefId } = await ds.store(enc("x"));
    const boom = new Error("holder down");
    vi.spyOn(holder, "removeReference").mockRejectedValueOnce(boom);
    await expect(ds.removeReference(chainRefId!)).rejects.toMatchObject({
      cause: boom,
    });
    expect(otherRemove).not.toHaveBeenCalled();
  });

  it("marks a rejected removal as committed", async () => {
    const ds = await sdk({
      chainPolicy: {
        onComplete: ({ operation }) =>
          operation === "remove" ? "fail" : "accept",
      },
    });
    const { chainRefId } = await ds.store(enc("x"));
    await expect(ds.removeReference(chainRefId!)).rejects.toMatchObject({
      code: CoreErrorCode.ADAPTER_POLICY_REJECTED,
      committed: true,
    });
  });
});

describe("listReferences() under a policy", () => {
  function setup() {
    const [a, b] = [
      new MidnightSimulatorChainAdapter(),
      new MidnightSimulatorChainAdapter(),
    ];
    vi.spyOn(b, "listReferences").mockRejectedValue(new Error("b down"));
    return { a, b };
  }

  it("still returns partial results by default, now exposing the failure", async () => {
    const { a, b } = setup();
    const onComplete = vi.fn(() => "accept" as const);
    const ds = await sdk({
      chainAdapters: [a, b],
      chainPolicy: { onComplete },
    });
    await ds.store(enc("x"));
    onComplete.mockClear();
    expect(await ds.listReferences()).toHaveLength(1);
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "list",
        failures: [expect.objectContaining({ attempt: 1 })],
      }),
    );
  });

  it("lets a policy reject an incomplete list", async () => {
    const { a, b } = setup();
    const ds = await sdk({
      chainAdapters: [a, b],
      chainPolicy: {
        onComplete: ({ failures, operation }) =>
          operation === "list" && failures.length > 0 ? "fail" : "accept",
      },
    });
    await expect(ds.listReferences()).rejects.toMatchObject({
      code: CoreErrorCode.ADAPTER_POLICY_REJECTED,
    });
  });

  it("retries a failed adapter", async () => {
    const chain = new MidnightSimulatorChainAdapter();
    const list = vi.spyOn(chain, "listReferences");
    list.mockRejectedValueOnce(new Error("blip"));
    const ds = await sdk({
      chainAdapters: [chain],
      chainPolicy: { onFailure: () => ({ action: "retry" }) },
    });
    await ds.listReferences();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("rejects abort, as parallel calls can't be cancelled", async () => {
    const { a, b } = setup();
    const ds = await sdk({
      chainAdapters: [a, b],
      chainPolicy: { onFailure: () => "abort" },
    });
    await expect(ds.listReferences()).rejects.toMatchObject({
      code: CoreErrorCode.ADAPTER_POLICY_INVALID_DECISION,
    });
  });

  it("keeps LIST_REFS_ALL_FAILED when every adapter fails", async () => {
    const chain = new MidnightSimulatorChainAdapter();
    vi.spyOn(chain, "listReferences").mockRejectedValue(new Error("down"));
    const ds = await sdk({ chainAdapters: [chain] });
    await expect(ds.listReferences()).rejects.toMatchObject({
      code: CoreErrorCode.LIST_REFS_ALL_FAILED,
    });
  });
});

describe("estimateCost() under a policy", () => {
  function brokenQuotes() {
    const [a, b] = [new MockStorageAdapter(), new MockStorageAdapter()];
    vi.spyOn(a, "estimateCost").mockRejectedValue(new Error("no quote"));
    const quoteB = vi.spyOn(b, "estimateCost");
    return { a, b, quoteB };
  }

  it("doesn't fall back by default, even with a policy set", async () => {
    const { a, b, quoteB } = brokenQuotes();
    const ds = await sdk({
      storageAdapters: [a, b],
      storagePolicy: { onSuccess: () => "stop" },
    });
    await expect(ds.estimateCost(10)).rejects.toThrow("no quote");
    expect(quoteB).not.toHaveBeenCalled();
  });

  it("falls back when onFailure opts in", async () => {
    const { a, b, quoteB } = brokenQuotes();
    const ds = await sdk({
      storageAdapters: [a, b],
      storagePolicy: { onFailure: () => "next" },
    });
    await expect(ds.estimateCost(10)).resolves.toBeDefined();
    expect(quoteB).toHaveBeenCalledOnce();
  });

  it("uses ESTIMATE_COST_ALL_FAILED when every opted-in adapter fails", async () => {
    const { a, b } = brokenQuotes();
    vi.spyOn(b, "estimateCost").mockRejectedValue(new Error("no quote"));
    const ds = await sdk({
      storageAdapters: [a, b],
      storagePolicy: { onFailure: () => "next" },
    });
    await expect(ds.estimateCost(10)).rejects.toMatchObject({
      code: CoreErrorCode.ESTIMATE_COST_ALL_FAILED,
    });
  });

  it("quotes the adapter a policy puts first", async () => {
    const { a, b, quoteB } = brokenQuotes();
    const ds = await sdk({
      storageAdapters: [a, b],
      storagePolicy: { order: ({ candidates }) => [candidates[1]!] },
    });
    await ds.estimateCost(10);
    expect(a.estimateCost).not.toHaveBeenCalled();
    expect(quoteB).toHaveBeenCalledOnce();
  });
});
