/**
 * @dstorage/core — adapterPolicy.ts
 *
 * Runs an operation across candidate adapters, asking the configured policy
 * what to do at each step. With no policy this is a sequential try-in-order
 * loop that stops at the first success.
 */

import { DStorageError } from "@dstorage/crypto";
import {
  AdapterPolicyError,
  CoreErrorCode,
  isAdapterPolicyError,
} from "./errors.js";
import type { AdapterFailure } from "./errors.js";
import type {
  AdapterCandidate,
  AdapterKind,
  AdapterPolicy,
  PolicyFailure,
  PolicyFailureContext,
  PolicySuccess,
  PolicySuccessContext,
} from "./types.js";

/** Stops a hook that always returns "retry" from looping forever. */
export const MAX_ATTEMPTS_PER_CANDIDATE = 32;
// Larger values overflow setTimeout, which then fires almost immediately.
const MAX_DELAY_MS = 2_147_483_647;

export interface PolicyCandidate<T> {
  target: T;
  info: AdapterCandidate;
}

export interface PolicyRules {
  /** Whether onSuccess may return "continue". */
  allowContinue: boolean;
  /** One fixed adapter, so `order` isn't called. */
  pinned: boolean;
  /** A success is a chain write that can't be undone. */
  commits: boolean;
  /** What to do after a failure when there's no onFailure hook. */
  defaultOnFailure: "next" | "stop";
  /** Call onSuccess even though "continue" isn't allowed, and explain why it isn't. */
  continueHint?: string;
}

export interface PolicyRun<T, R> {
  kind: AdapterKind;
  operation: string;
  // Each caller supplies the policy matching its kind and operation.
  policy: AdapterPolicy<any, any> | undefined;
  candidates: ReadonlyArray<PolicyCandidate<T>>;
  attempt: (target: T) => Promise<R>;
  rules: PolicyRules;
  /** Picks the fields of a result that hooks may see. */
  describe?: (
    result: R,
  ) => Pick<PolicySuccess, "storageId" | "provider" | "refId">;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Tracks one operation's outcomes and builds the errors it can end with. */
class PolicyState<T, R> {
  readonly successes: PolicySuccess[] = [];
  readonly failures: PolicyFailure[] = [];
  readonly adapterFailures: AdapterFailure[] = [];

  constructor(private readonly run: PolicyRun<T, R>) {}

  error(
    code: CoreErrorCode,
    message: string,
    details: { hook?: string; cause?: unknown } = {},
  ): AdapterPolicyError {
    return new AdapterPolicyError(code, `[dStorage] ${message}`, {
      ...details,
      kind: this.run.kind,
      operation: this.run.operation,
      successes: [...this.successes],
      failures: [...this.failures],
      committed: this.run.rules.commits && this.successes.length > 0,
    });
  }

  invalid(hook: string, message: string): AdapterPolicyError {
    return this.error(
      CoreErrorCode.ADAPTER_POLICY_INVALID_DECISION,
      `${this.run.kind}Policy.${hook} ${message} (operation "${this.run.operation}").`,
      { hook },
    );
  }

  /** Keeps a hook's own error distinct from an adapter failure. */
  async callHook<D>(hook: string, call: () => D | Promise<D>): Promise<D> {
    try {
      return await call();
    } catch (err) {
      throw this.error(
        CoreErrorCode.ADAPTER_POLICY_HOOK_FAILED,
        `${this.run.kind}Policy.${hook} threw during operation "${this.run.operation}".`,
        { hook, cause: err },
      );
    }
  }

  context(info: AdapterCandidate, attempt: number) {
    return {
      kind: this.run.kind,
      operation: this.run.operation,
      adapter: info.adapter,
      ...(info.location !== undefined ? { location: info.location } : {}),
      attempt,
      successes: Object.freeze([...this.successes]),
      failures: Object.freeze([...this.failures]),
    };
  }

  recordFailure(
    candidate: PolicyCandidate<T>,
    attempt: number,
    error: unknown,
  ): void {
    const { adapter, location } = candidate.info;
    this.failures.push({
      adapter,
      attempt,
      error,
      ...(location !== undefined ? { location } : {}),
    });
    this.adapterFailures.push({
      adapterName: adapter.name,
      error,
      ...(this.run.policy ? { adapterIndex: adapter.index, attempt } : {}),
    });
  }

  recordSuccess(
    candidate: PolicyCandidate<T>,
    attempt: number,
    result: R,
  ): void {
    const { adapter, location } = candidate.info;
    this.successes.push({
      adapter,
      attempt,
      ...(location !== undefined ? { location } : {}),
      ...this.run.describe?.(result),
    });
  }
}

async function resolveOrder<T, R>(
  run: PolicyRun<T, R>,
  state: PolicyState<T, R>,
): Promise<ReadonlyArray<PolicyCandidate<T>>> {
  const order = run.policy?.order;
  if (!order || run.rules.pinned || run.candidates.length === 0) {
    return run.candidates;
  }
  const chosen: unknown = await state.callHook("order", () =>
    order.call(run.policy, {
      kind: run.kind,
      operation: run.operation,
      candidates: Object.freeze(run.candidates.map((c) => c.info)),
    }),
  );
  if (!Array.isArray(chosen) || chosen.length === 0) {
    throw state.invalid("order", "must return a non-empty array of candidates");
  }
  const byInfo = new Map(run.candidates.map((c) => [c.info, c]));
  if (new Set(chosen).size !== chosen.length) {
    throw state.invalid("order", "returned the same candidate twice");
  }
  return chosen.map((info: AdapterCandidate) => {
    const candidate = byInfo.get(info);
    if (!candidate) {
      throw state.invalid(
        "order",
        "must return objects taken from ctx.candidates",
      );
    }
    return candidate;
  });
}

type FailureAction = "next" | "stop" | "abort";

/** Applies onFailure, returning "retry" once any requested delay has passed. */
async function decideOnFailure<T, R>(
  run: PolicyRun<T, R>,
  state: PolicyState<T, R>,
  candidate: PolicyCandidate<T>,
  attempt: number,
  error: unknown,
): Promise<FailureAction | "retry"> {
  const hook = run.policy?.onFailure;
  if (!hook) return run.rules.defaultOnFailure;
  const ctx = {
    ...state.context(candidate.info, attempt),
    error,
  } as PolicyFailureContext<any, any>;
  const decision: unknown = await state.callHook("onFailure", () =>
    hook.call(run.policy, ctx),
  );
  if (decision === "next" || decision === "abort") return decision;
  if (
    typeof decision === "object" &&
    decision !== null &&
    (decision as { action?: unknown }).action === "retry"
  ) {
    const delayMs = (decision as { delayMs?: unknown }).delayMs ?? 0;
    if (
      typeof delayMs !== "number" ||
      !Number.isInteger(delayMs) ||
      delayMs < 0 ||
      delayMs > MAX_DELAY_MS
    ) {
      throw state.invalid(
        "onFailure",
        `returned a delayMs that isn't an integer from 0 to ${MAX_DELAY_MS}`,
      );
    }
    if (attempt >= MAX_ATTEMPTS_PER_CANDIDATE) {
      throw state.invalid(
        "onFailure",
        `exceeded the limit of ${MAX_ATTEMPTS_PER_CANDIDATE} attempts per adapter`,
      );
    }
    if (delayMs > 0) await (run.sleep ?? defaultSleep)(delayMs);
    return "retry";
  }
  throw state.invalid(
    "onFailure",
    'must return "next", "abort" or { action: "retry" }',
  );
}

async function decideOnSuccess<T, R>(
  run: PolicyRun<T, R>,
  state: PolicyState<T, R>,
  candidate: PolicyCandidate<T>,
  attempt: number,
): Promise<"stop" | "continue"> {
  const hook = run.policy?.onSuccess;
  // Where "continue" can't apply there's no decision to make, so a hook that
  // always returns "continue" for writes doesn't break reads. A hint marks the
  // case where the operation could replicate but this configuration can't.
  if (!hook || (!run.rules.allowContinue && !run.rules.continueHint)) {
    return "stop";
  }
  const ctx = state.context(candidate.info, attempt) as PolicySuccessContext<
    any,
    any
  >;
  const decision: unknown = await state.callHook("onSuccess", () =>
    hook.call(run.policy, ctx),
  );
  if (decision === "stop") return "stop";
  if (decision !== "continue") {
    throw state.invalid("onSuccess", 'must return "stop" or "continue"');
  }
  if (!run.rules.allowContinue) {
    throw state.invalid(
      "onSuccess",
      `returned "continue", which isn't allowed here${run.rules.continueHint ? `: ${run.rules.continueHint}` : ""}`,
    );
  }
  return "continue";
}

async function runOnComplete<T, R>(
  run: PolicyRun<T, R>,
  state: PolicyState<T, R>,
): Promise<void> {
  const hook = run.policy?.onComplete;
  if (!hook) return;
  const decision: unknown = await state.callHook("onComplete", () =>
    hook.call(run.policy, {
      kind: run.kind,
      operation: run.operation,
      successes: Object.freeze([...state.successes]),
      failures: Object.freeze([...state.failures]),
    }),
  );
  if (decision !== "accept" && decision !== "fail") {
    throw state.invalid("onComplete", 'must return "accept" or "fail"');
  }
  if (decision === "fail" && state.successes.length > 0) {
    throw state.error(
      CoreErrorCode.ADAPTER_POLICY_REJECTED,
      `${run.kind}Policy.onComplete rejected operation "${run.operation}" after ${state.successes.length} success(es).`,
      { hook: "onComplete", cause: state.adapterFailures },
    );
  }
}

/**
 * Runs candidates in sequence. The first success is the primary result.
 *
 * If nothing succeeds and only one candidate was tried, its last error is
 * rethrown as is, so single-adapter configs behave like a bare call. Otherwise
 * `buildExhaustedError` provides the aggregate error.
 */
export async function runWithPolicy<T, R>(
  run: PolicyRun<T, R>,
  buildExhaustedError: (failures: AdapterFailure[]) => DStorageError,
): Promise<{
  adapter: T;
  result: R;
  successes: Array<{ adapter: T; result: R }>;
}> {
  const state = new PolicyState(run);
  const candidates = await resolveOrder(run, state);
  const results: Array<{ adapter: T; result: R }> = [];
  const failedCandidates = new Set<PolicyCandidate<T>>();
  let lastError: unknown;

  candidateLoop: for (const candidate of candidates) {
    for (let attempt = 1; ; attempt++) {
      let result: R;
      try {
        result = await run.attempt(candidate.target);
      } catch (err) {
        // A nested run's policy decision ends the whole operation.
        if (isAdapterPolicyError(err)) throw err;
        state.recordFailure(candidate, attempt, err);
        failedCandidates.add(candidate);
        lastError = err;
        const action = await decideOnFailure(
          run,
          state,
          candidate,
          attempt,
          err,
        );
        if (action === "retry") continue;
        if (action === "abort") {
          throw state.error(
            CoreErrorCode.ADAPTER_POLICY_ABORTED,
            `${run.kind}Policy.onFailure aborted operation "${run.operation}".`,
            { hook: "onFailure", cause: state.adapterFailures },
          );
        }
        if (action === "stop") break candidateLoop;
        continue candidateLoop;
      }

      state.recordSuccess(candidate, attempt, result);
      results.push({ adapter: candidate.target, result });
      const decision = await decideOnSuccess(run, state, candidate, attempt);
      if (decision === "stop") break candidateLoop;
      continue candidateLoop;
    }
  }

  await runOnComplete(run, state);

  const primary = results[0];
  if (primary) return { ...primary, successes: results };
  if (failedCandidates.size === 1) throw lastError;
  throw buildExhaustedError(state.adapterFailures);
}

/**
 * Runs candidates concurrently and returns the successes in candidate order.
 * The caller decides what zero successes means. Parallel calls can't be
 * cancelled, so "abort" is invalid here.
 */
export async function runParallelWithPolicy<T, R>(
  run: PolicyRun<T, R>,
): Promise<{
  results: Array<{ adapter: T; result: R }>;
  failures: AdapterFailure[];
}> {
  const state = new PolicyState(run);
  const candidates = await resolveOrder(run, state);

  const settled = await Promise.all(
    candidates.map(async (candidate) => {
      for (let attempt = 1; ; attempt++) {
        try {
          const result = await run.attempt(candidate.target);
          state.recordSuccess(candidate, attempt, result);
          return { adapter: candidate.target, result };
        } catch (err) {
          state.recordFailure(candidate, attempt, err);
          const action = await decideOnFailure(
            run,
            state,
            candidate,
            attempt,
            err,
          );
          if (action === "retry") continue;
          if (action === "abort") {
            throw state.invalid(
              "onFailure",
              'returned "abort", which parallel calls can\'t honour',
            );
          }
          return null;
        }
      }
    }),
  );

  await runOnComplete(run, state);
  return {
    results: settled.filter((s) => s !== null),
    failures: state.adapterFailures,
  };
}
