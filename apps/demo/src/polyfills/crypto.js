// Browser polyfill for Node's `crypto` module — implements only
// `createHash`, the sole API surface @dha-team/arbundles' browser build
// needs. That package's "web" build still does `import { createHash } from
// "crypto"` in deepHash.js / DataItem.js / Bundle.js despite targeting
// browsers, and Vite has no built-in polyfill for it.
//
// Backed by @noble/hashes (pure JS, synchronous) rather than the Web Crypto
// API (crypto.subtle) because callers use the synchronous
// `.update(chunk)` ... `.digest()` streaming pattern — subtle.digest() is
// async and only hashes a complete buffer at once, so it can't replicate
// Node's incremental Hash interface.
import { sha256 } from "@noble/hashes/sha256";
import { sha384 } from "@noble/hashes/sha512";
import { Buffer } from "buffer";

const ALGORITHMS = { sha256, sha384 };

// Statically imported by @dha-team/arbundles' RSA-PSS local signer
// (signing/keys/Rsa4096Pss.js) so the module graph resolves, but never
// actually called — ArweaveBundlerStorageAdapter is managed-payment-only
// and never constructs a local signer. Fail loudly if that ever changes.
export const constants = {};
export function createSign() {
  throw new Error(
    "[dStorage] createSign is not supported by the browser crypto polyfill — local RSA signing is not available in the browser.",
  );
}

export function createHash(algorithm) {
  const hashFn = ALGORITHMS[algorithm];
  if (!hashFn) {
    throw new Error(
      `[dStorage] Unsupported hash algorithm in browser crypto polyfill: ${algorithm}`,
    );
  }
  const hasher = hashFn.create();
  return {
    update(data) {
      hasher.update(typeof data === "string" ? Buffer.from(data) : data);
      return this;
    },
    digest(encoding) {
      const bytes = Buffer.from(hasher.digest());
      return encoding ? bytes.toString(encoding) : bytes;
    },
  };
}

export default { createHash, createSign, constants };
