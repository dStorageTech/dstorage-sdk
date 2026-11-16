/**
 * Ledger version pin tests.
 *
 * @midnight-ntwrk/midnight-js-protocol pins @midnightntwrk/ledger-v9 to an
 * exact version, while compact-js and the wallet SDK accept a range. If the
 * SDK's own ledger-v9 dependency differs from that pin, apps installing the
 * SDK get two copies of the ledger WASM module, and contract calls fail with
 * "expected instance of _LedgerParameters". The workspace `overrides` pin
 * only applies inside this repo, so the published dependency must match too.
 */

import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const LEDGER = "@midnightntwrk/ledger-v9";

type PackageJson = {
  dependencies?: Record<string, string>;
  overrides?: Record<string, string>;
};

const readJson = (path: string): PackageJson =>
  JSON.parse(readFileSync(path, "utf8")) as PackageJson;

const corePkg = readJson(
  new URL("../../package.json", import.meta.url).pathname,
);
const rootPkg = readJson(
  new URL("../../../../package.json", import.meta.url).pathname,
);
const protocolPkg = readJson(
  require.resolve("@midnight-ntwrk/midnight-js-protocol/package.json"),
);

describe("ledger-v9 version pin", () => {
  const protocolLedger = protocolPkg.dependencies?.[LEDGER];

  it("midnight-js-protocol declares an exact ledger-v9 version", () => {
    expect(protocolLedger).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });

  it("the published SDK depends on the same ledger-v9 version as midnight-js-protocol", () => {
    expect(corePkg.dependencies?.[LEDGER]).toBe(protocolLedger);
  });

  it("the workspace override pins the same ledger-v9 version as midnight-js-protocol", () => {
    expect(rootPkg.overrides?.[LEDGER]).toBe(protocolLedger);
  });
});
