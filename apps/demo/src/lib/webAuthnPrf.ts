/**
 * WebAuthn PRF-based key derivation for the dStorage demo.
 *
 * The PRF (Pseudo-Random Function) extension lets a platform authenticator
 * (Touch ID, Face ID, Windows Hello) produce a deterministic 32-byte secret
 * keyed to this origin and credential. We HKDF-expand it to 64 bytes and use
 * it as a seedHex for MnemonicEncryptionAdapter → intoKeypairEncryptionAdapter.
 *
 * Only the credential ID (a non-secret handle) is persisted in localStorage.
 * The derived seed lives in memory for the duration of the session.
 *
 * PRF is supported in Chrome/Edge 116+. Firefox and Safari do not support it.
 */

const CREDENTIAL_ID_KEY = "dstorage:webauthn:credentialId:v1";

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

function saveCredentialId(id: Uint8Array): void {
  localStorage.setItem(
    CREDENTIAL_ID_KEY,
    btoa(Array.from(id, (b) => String.fromCharCode(b)).join("")),
  );
}

function loadCredentialId(): Uint8Array | null {
  const saved = localStorage.getItem(CREDENTIAL_ID_KEY);
  if (!saved) return null;
  return Uint8Array.from(atob(saved), (c) => c.charCodeAt(0));
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

/** True if a credential has been registered on this device. */
export function hasCredential(): boolean {
  return localStorage.getItem(CREDENTIAL_ID_KEY) !== null;
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
 * Saves the credential ID to localStorage for future sessions.
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
  saveCredentialId(credentialId);

  // Some authenticators return the PRF result directly from create().
  if (ext.prf.results?.first) {
    return expandToSeed(ext.prf.results.first);
  }

  // Others require a separate get() to obtain the PRF output.
  return getPrfSeed(credentialId);
}

/**
 * Derive the 64-byte seed using the stored credential.
 * Prompts biometric verification. Throws if no credential is saved.
 *
 * @param credentialId  Override the stored credential ID (used by createPrfCredential).
 */
export async function getPrfSeed(
  credentialId?: Uint8Array,
): Promise<Uint8Array> {
  const id = credentialId ?? loadCredentialId();
  if (!id) {
    throw new Error(
      "No WebAuthn credential found. Please set up your authenticator first.",
    );
  }

  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: "public-key", id: id.buffer as ArrayBuffer }],
      userVerification: "required",
      extensions: {
        prf: { eval: { first: PRF_SALT } } satisfies PrfExtInput,
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential;

  const prfResults = (
    assertion.getClientExtensionResults() as { prf?: PrfExtOutput }
  ).prf;
  if (!prfResults?.results?.first) {
    throw new Error(
      "PRF evaluation returned no output — this authenticator may not support PRF. " +
        "Use the passphrase option instead.",
    );
  }

  return expandToSeed(prfResults.results.first);
}
