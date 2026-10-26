/**
 * ledgerState$ — resilience of the DataRegistry ledger-state stream against
 * the indexer observable completing without emitting (EmptyError regression).
 */

import { describe, it, expect, vi } from "vitest";
import {
  EMPTY,
  ReplaySubject,
  firstValueFrom,
  of,
  share,
  throwError,
} from "rxjs";
import {
  ledgerState$,
  LEDGER_STATE_RETRY_COUNT,
} from "../adapters/midnight/src/contract-api.js";
import { ChainErrorCode } from "../errors.js";

const ADDRESS = "a".repeat(64);
const STATE = { data: "fake-state" };

function makeProviders(sources: (() => unknown)[]) {
  const contractStateObservable = vi.fn(() => {
    const next = sources.shift();
    if (!next) throw new Error("no more fake sources");
    return next();
  });
  return {
    providers: { publicDataProvider: { contractStateObservable } } as never,
    contractStateObservable,
  };
}

describe("ledgerState$", () => {
  it("re-queries the indexer when the first stream completes empty", async () => {
    const { providers, contractStateObservable } = makeProviders([
      () => EMPTY,
      () => of(STATE),
    ]);

    const state = await firstValueFrom(ledgerState$(providers, ADDRESS, 0));

    expect(state).toBe(STATE);
    expect(contractStateObservable).toHaveBeenCalledTimes(2);
  });

  it("retries transient indexer errors", async () => {
    const { providers } = makeProviders([
      () => throwError(() => new Error("socket closed")),
      () => of(STATE),
    ]);

    await expect(
      firstValueFrom(ledgerState$(providers, ADDRESS, 0)),
    ).resolves.toBe(STATE);
  });

  it("fails with CONTRACT_STATE_UNAVAILABLE instead of EmptyError after exhausting retries", async () => {
    const { providers, contractStateObservable } = makeProviders(
      Array.from({ length: LEDGER_STATE_RETRY_COUNT + 1 }, () => () => EMPTY),
    );

    await expect(
      firstValueFrom(ledgerState$(providers, ADDRESS, 0)),
    ).rejects.toMatchObject({
      code: ChainErrorCode.CONTRACT_STATE_UNAVAILABLE,
    });
    expect(contractStateObservable).toHaveBeenCalledTimes(
      LEDGER_STATE_RETRY_COUNT + 1,
    );
  });

  it("a shared state$ recovers on the next read after a failed one", async () => {
    // Mirrors DataRegistryAPI.state$: once the shared stream has failed, the
    // next subscriber must trigger a fresh query, not replay a dead buffer.
    const { providers } = makeProviders([
      ...Array.from(
        { length: LEDGER_STATE_RETRY_COUNT + 1 },
        () => () => EMPTY,
      ),
      () => of(STATE),
    ]);
    const shared$ = ledgerState$(providers, ADDRESS, 0).pipe(
      share({
        connector: () => new ReplaySubject(1),
        resetOnError: true,
        resetOnComplete: true,
        resetOnRefCountZero: false,
      }),
    );

    await expect(firstValueFrom(shared$)).rejects.toMatchObject({
      code: ChainErrorCode.CONTRACT_STATE_UNAVAILABLE,
    });
    await expect(firstValueFrom(shared$)).resolves.toBe(STATE);
  });
});
