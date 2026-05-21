/**
 * WebAuthn PRF-based key derivation for the dStorage demo.
 *
 * The PRF (Pseudo-Random Function) extension lets a platform authenticator
 * (Touch ID, Face ID, Windows Hello) produce a deterministic 32-byte secret
 * keyed to this origin and credential. We HKDF-expand it to 64 bytes and use
 * it as a seedHex for MnemonicEncryptionAdapter → intoKeypairEncryptionAdapter.
 *
 * Multiple credential IDs are stored as a JSON array in localStorage so that
 * multiple users can each register their own key on the same browser/device.
 * On authentication, all stored IDs are passed to allowCredentials and the
 * browser selects whichever matches the presented authenticator.
 *
 * PRF is supported in Chrome/Edge 116+. Firefox and Safari do not support it.
 */

const CREDENTIAL_IDS_KEY = "dstorage:webauthn:credentialIds:v1";

// Fixed salt — binds derived keys to this application context.
const PRF_SALT = new TextEncoder().encode("dstorage:encryption-seed:v1");

// ── Internal helpers ──────────────────────────────────────────────────────────

type PrfExtInput = {
  eval?: { first: BufferSource; second?: BufferSource };
};
type PrfExtOutput = {
  enabled?: boolean;
  results?: { first?: ArrayBuffer; second?: ArrayBuffer };
};

function toBase64(id: Uint8Array): string {
  return btoa(Array.from(id, (b) => String.fromCharCode(b)).join(""));
}

function loadCredentialIds(): Uint8Array[] {
  const raw = localStorage.getItem(CREDENTIAL_IDS_KEY);
  if (!raw) return [];
  try {
    const arr: string[] = JSON.parse(raw);
    return arr.map((b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  } catch {
    return [];
  }
}

function saveCredentialId(id: Uint8Array): void {
  const b64 = toBase64(id);
  const raw = localStorage.getItem(CREDENTIAL_IDS_KEY);
  const list: string[] = raw ? JSON.parse(raw) : [];
  if (list.includes(b64)) return;
  list.push(b64);
  localStorage.setItem(CREDENTIAL_IDS_KEY, JSON.stringify(list));
}

async function expandToSeed(prfOutput: ArrayBuffer): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    prfOutput,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: PRF_SALT,
    },
    keyMaterial,
    512, // 64 bytes
  );
  return new Uint8Array(bits);
}

// ── Public API ────────────────────────────────────────────────────────────────

/** True if at least one credential has been registered on this device. */
export function hasCredential(): boolean {
  return loadCredentialIds().length > 0;
}

/**
 * Remove a stored credential.
 * - No argument: clears all credentials.
 * - With `id`: removes only that specific credential.
 */
export function clearCredential(id?: Uint8Array): void {
  if (!id) {
    localStorage.removeItem(CREDENTIAL_IDS_KEY);
    return;
  }
  const target = toBase64(id);
  const raw = localStorage.getItem(CREDENTIAL_IDS_KEY);
  if (!raw) return;
  const list: string[] = JSON.parse(raw).filter(
    (b64: string) => b64 !== target,
  );
  if (list.length === 0) {
    localStorage.removeItem(CREDENTIAL_IDS_KEY);
  } else {
    localStorage.setItem(CREDENTIAL_IDS_KEY, JSON.stringify(list));
  }
}

/**
 * Best-effort check: returns true if WebAuthn with PRF might be available.
 * Chrome/Edge 116+ support it; Firefox/Safari do not.
 */
export async function isPrfSupported(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (!window.PublicKeyCredential) return false;
  if (typeof navigator.credentials?.get !== "function") return false;

  try {
    // getClientCapabilities() is Chrome 120+ — use it if available.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const caps = await (PublicKeyCredential as any).getClientCapabilities?.();
    if (caps) return caps["extension:prf"] === true;
  } catch {
    // Not available — fall through.
  }

  // Optimistic: WebAuthn present, assume PRF available (Chrome/Edge 116+).
  return true;
}

/**
 * Register a new WebAuthn credential with PRF and derive the 64-byte seed.
 * Prompts the user to set up a biometric authenticator.
 * Appends the credential ID to the stored list for future sessions.
 */
export async function createPrfCredential(): Promise<Uint8Array> {
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: "dStorage HealthVault", id: window.location.hostname },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: "healthvault-user",
        displayName: "HealthVault User",
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 }, // ES256
        { type: "public-key", alg: -257 }, // RS256
      ],
      authenticatorSelection: {
        userVerification: "required",
        residentKey: "preferred",
      },
      extensions: {
        prf: { eval: { first: PRF_SALT } } satisfies PrfExtInput,
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential;

  const ext = credential.getClientExtensionResults() as {
    prf?: PrfExtOutput;
  };

  if (!ext.prf?.enabled) {
    throw new Error(
      "This authenticator does not support the PRF extension. " +
        "Use the passphrase option instead.",
    );
  }

  const credentialId = new Uint8Array(credential.rawId);

  // Some authenticators return the PRF result directly from create().
  if (ext.prf.results?.first) {
    saveCredentialId(credentialId);
    return expandToSeed(ext.prf.results.first);
  }

  // Save first so the new credential appears in the allowCredentials list,
  // then authenticate with all credentials so the user can pick any of them.
  saveCredentialId(credentialId);
  return getPrfSeed();
}

/**
 * Derive the 64-byte seed using a stored credential.
 * Passes all stored credential IDs to allowCredentials so the browser
 * selects whichever matches the presented authenticator automatically.
 *
 * @param credentialId  Override: use only this ID (used by createPrfCredential).
 */
export async function getPrfSeed(
  credentialId?: Uint8Array,
): Promise<Uint8Array> {
  const fromStorage = credentialId === undefined;
  const ids = credentialId ? [credentialId] : loadCredentialIds();
  if (ids.length === 0) {
    throw new Error(
      "No WebAuthn credential found. Please set up your authenticator first.",
    );
  }

  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: ids.map((id) => ({
        type: "public-key" as const,
        id: Uint8Array.from(id),
      })),
      userVerification: "required",
      extensions: {
        prf: { eval: { first: PRF_SALT } } satisfies PrfExtInput,
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential;

  const prfResults = (
    assertion.getClientExtensionResults() as { prf?: PrfExtOutput }
  ).prf;

  if (!prfResults) {
    throw new Error(
      "PRF extension was not processed — Chrome/Edge 116+ required. " +
        "Use the passphrase option instead.",
    );
  }

  if (!prfResults.results?.first) {
    // Remove only the specific credential that failed, preserving others.
    if (fromStorage) clearCredential(new Uint8Array(assertion.rawId));
    throw new Error(
      "PRF evaluation returned no output — this authenticator may not support PRF. " +
        (fromStorage
          ? "Your saved credential has been cleared. Please re-register or use the passphrase option instead."
          : "Use the passphrase option instead."),
    );
  }

  return expandToSeed(prfResults.results.first);
}
