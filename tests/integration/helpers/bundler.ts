import { ArweaveBundlerStorageAdapter } from "@dstorage/storage";
import type { IntegrationEnv } from "./env.js";

/**
 * Check whether an HTTP endpoint is reachable (same shape as checkArlocal /
 * checkProofServer).
 */
export async function checkHttp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Returns true if all prerequisites for the bundler suite are met: the mock
 * signing/bundler server has been started (its printed auth token pasted into
 * .env.integration) and both it and arlocal (used directly as the retrieval
 * gateway — see the module doc comment) are reachable.
 *
 * Unlike arlocal's own suites, the mock server is a local process the
 * developer must start themselves — closer in spirit to isMidnightAvailable()'s
 * "external prerequisite, warn and skip" pattern than to checkArlocal's pure
 * reachability check.
 */
export async function isBundlerAvailable(
  env: IntegrationEnv,
): Promise<boolean> {
  if (!env.bundler.authToken) {
    console.warn(
      "[integration] INTEGRATION_BUNDLER_AUTH_TOKEN not set — will skip bundler suite. " +
        "Run `npm run bundler-mock:run` and copy the printed token into .env.integration.",
    );
    return false;
  }
  const mockServerOk = await checkHttp(env.bundler.mockServerUrl);
  if (!mockServerOk) {
    console.warn(
      `[integration] bundler mock server not reachable at ${env.bundler.mockServerUrl} — ` +
        "will skip bundler suite. Run `npm run bundler-mock:run`.",
    );
    return false;
  }
  const arlocalOk = await checkHttp(env.arlocalUrl);
  if (!arlocalOk) {
    console.warn(
      `[integration] arlocal not reachable at ${env.arlocalUrl} — ` +
        "will skip bundler suite. Run `docker compose -f tools/compose-undeployed.yml up -d --wait`.",
    );
  }
  return arlocalOk;
}

/**
 * Build an ArweaveBundlerStorageAdapter wired to the local mock signing/bundler
 * server for writes and arlocal directly for reads.
 *
 * Note: a self-hosted AR.IO gateway (ghcr.io/ar-io/ar-io-core) was evaluated
 * as a retrieval front-end trusting arlocal via TRUSTED_NODE_URL, but its
 * block importer cannot decode arlocal's block JSON (crashes on every block,
 * verified against the real image) — so retrieval goes straight to arlocal,
 * which already implements the same gateway HTTP API (/tx/:id, /:id) the
 * adapter's retrieve() depends on.
 */
export function createBundlerAdapter(
  env: IntegrationEnv,
): ArweaveBundlerStorageAdapter {
  return new ArweaveBundlerStorageAdapter({
    signingServerUrl: env.bundler.mockServerUrl,
    authToken: env.bundler.authToken!,
    gateway: env.arlocalUrl,
    paymentServiceUrl: env.bundler.mockServerUrl,
    uploadServiceUrl: env.bundler.mockServerUrl,
    logger: console,
  });
}

/**
 * Bounded poll/retry wrapper around a retrieval call. The mock bundler server
 * mines a block synchronously before returning, so retrieval normally
 * succeeds immediately — this is defense-in-depth against local startup/
 * networking flakiness, not a workaround for indexing lag. Comfortably
 * inside the 120_000ms test/hook timeout.
 */
export async function retryUntilAvailable<T>(
  fn: () => Promise<T>,
  {
    timeoutMs = 30_000,
    intervalMs = 1_000,
  }: {
    timeoutMs?: number;
    intervalMs?: number;
  } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw lastErr;
}
