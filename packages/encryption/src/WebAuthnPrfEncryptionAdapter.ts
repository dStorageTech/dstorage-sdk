/**
 * @dstorage/encryption — WebAuthnPrfEncryptionAdapter
 *
 * Derives an encryption seed from the WebAuthn PRF (Pseudo-Random Function)
 * extension — supported by platform authenticators (Touch ID, Face ID,
 * Windows Hello) and by hardware security keys implementing the CTAP2
 * hmac-secret extension (e.g. YubiKey 5 series), which browsers surface to
 * JS as the WebAuthn PRF extension.
 *
 * The PRF evaluation output (32 bytes, deterministic per credential + salt +
 * origin) is HKDF-expanded to a 64-byte seed and handed to an internally
 * held MnemonicEncryptionAdapter, reusing its KEK derivation / ML-KEM-seed
 * logic rather than duplicating it.
 *
 * Credential ID persistence (localStorage, a database, ...) is the caller's
 * responsibility: register() returns the raw credentialId for the caller to
 * store, and authenticate() takes a caller-supplied list of credential IDs
 * to try via WebAuthn's allowCredentials.
 */

import { DStorageError } from "@dstorage/crypto";
import { MnemonicEncryptionAdapter } from "./MnemonicEncryptionAdapter.js";
import { KeypairEncryptionAdapter } from "./KeypairEncryptionAdapter.js";
import type { MLKemVariant } from "./KeypairEncryptionAdapter.js";
import type { EncryptionAdapter, WrappedDekResult } from "./types.js";
import { EncryptionErrorCode } from "./errors.js";

// Fixed default PRF eval salt — binds derived keys to this SDK's context.
// Override via options.salt for multi-tenant / multi-app domain separation.
const DEFAULT_PRF_SALT = new TextEncoder().encode(
  "dstorage:webauthn-prf:eval-salt:v1",
);

// HKDF info string used to expand the 32-byte PRF output to a 64-byte seed.
// Distinct from MnemonicEncryptionAdapter's own "dstorage:mlkem-seed:v1" hop
// — that hop still runs later, on top of this seed, if the caller invokes
// intoKeypairEncryptionAdapter() on the resulting adapter.
const SEED_EXPAND_INFO = new TextEncoder().encode(
  "dstorage:webauthn-prf:seed:v1",
);

const DEFAULT_PUB_KEY_CRED_PARAMS: PublicKeyCredentialParameters[] = [
  { type: "public-key", alg: -7 }, // ES256
  { type: "public-key", alg: -257 }, // RS256
];

// Fixed, internal-only context/variant for the ML-KEM keypair used to let a
// 3rd party encrypt data for this adapter's owner via a shared public key
// (see publicKey / fromPublicKey()). Never exposed to callers — the keypair
// itself doesn't depend on `context` (only the wrap/unwrap KEK step does),
// so a single hardcoded value is safe as long as both sides agree, which
// they always do here by construction. The variant is fixed rather than
// configurable so fromPublicKey() only ever needs the raw public key bytes.
const SHARE_CONTEXT = "dstorage:webauthn-prf:share:v1";
const SHARE_VARIANT: MLKemVariant = "mlkem768";

// TS DOM lib does not yet type the WebAuthn PRF extension.
type PrfExtInput = {
  eval?: { first: BufferSource; second?: BufferSource };
};
type PrfExtOutput = {
  enabled?: boolean;
  results?: { first?: ArrayBuffer; second?: ArrayBuffer };
};

/**
 * Options shared by register() and authenticate() that control internal
 * derivation steps normally fixed by the SDK. Defaults reproduce today's
 * behavior exactly; only set these to interoperate with a pre-existing,
 * non-SDK derivation scheme. Values must match between register() and
 * authenticate() for the same credential — and, for the two share* fields,
 * on the fromPublicKey() side too.
 */
interface WebAuthnPrfDerivationOptions {
  /** Default "hkdf-expand" (current behavior). "raw" uses the 32-byte PRF
   *  output directly as the MnemonicEncryptionAdapter seed, skipping the
   *  internal HKDF-expand-to-64-bytes step. */
  seedDerivation?: "hkdf-expand" | "raw";
  /** Overrides the HKDF info string used when seedDerivation is
   *  "hkdf-expand" (ignored in "raw" mode). Default: the SDK's own fixed
   *  label. */
  seedExpandInfo?: Uint8Array;
  /** Overrides the context bound into the internally-derived ML-KEM sharing
   *  keypair (.publicKey / the asymmetric half of unwrapDek()). Default:
   *  the SDK's own fixed label. */
  shareContext?: string;
  /** Overrides the ML-KEM variant for the same sharing keypair. Default:
   *  "mlkem768". */
  shareVariant?: MLKemVariant;
}

export interface WebAuthnPrfRegisterOptions extends WebAuthnPrfDerivationOptions {
  rpId?: string;
  rpName?: string;
  userId?: Uint8Array;
  userName?: string;
  userDisplayName?: string;
  userVerification?: UserVerificationRequirement;
  residentKey?: ResidentKeyRequirement;
  pubKeyCredParams?: PublicKeyCredentialParameters[];
  challenge?: Uint8Array;
  salt?: Uint8Array;
}

export interface WebAuthnPrfAuthenticateOptions extends WebAuthnPrfDerivationOptions {
  rpId?: string;
  userVerification?: UserVerificationRequirement;
  challenge?: Uint8Array;
  salt?: Uint8Array;
  /**
   * When true, omits allowCredentials from the WebAuthn get() call entirely
   * — rather than restricting to credentialIds — so the browser shows its
   * native picker across any discoverable (resident) passkey for this
   * origin. Requires the credential to have been registered with
   * residentKey: "required" (or "preferred", authenticator-dependent).
   * credentialIds may be passed as [] in this mode; its contents are
   * ignored. Default: false (current behavior — allowCredentials is always
   * built from credentialIds, which must be non-empty).
   */
  discoverable?: boolean;
}

/** Options for fromPublicKey() — must match the owner's register()/authenticate()
 *  shareContext/shareVariant, if they were customized away from the defaults. */
export interface WebAuthnPrfPublicKeyOptions {
  shareContext?: string;
  shareVariant?: MLKemVariant;
}

export class WebAuthnPrfEncryptionAdapter implements EncryptionAdapter {
  readonly name = "webauthn-prf";
  readonly credentialId: Uint8Array;
  /**
   * ML-KEM public key derived from this adapter's passkey seed. Share it
   * with a 3rd party — they can encrypt data for this adapter's owner via
   * fromPublicKey(publicKey), and any adapter obtained by re-authenticating
   * with the same passkey (via authenticate()) can decrypt it, alongside
   * this owner's own direct (symmetric) uploads — no separate adapter needed.
   */
  readonly publicKey: Uint8Array;
  private readonly mnemonicAdapter: MnemonicEncryptionAdapter;
  private readonly keypairAdapter: KeypairEncryptionAdapter;

  private constructor(
    credentialId: Uint8Array,
    mnemonicAdapter: MnemonicEncryptionAdapter,
    keypairAdapter: KeypairEncryptionAdapter,
  ) {
    this.credentialId = credentialId;
    this.mnemonicAdapter = mnemonicAdapter;
    this.keypairAdapter = keypairAdapter;
    this.publicKey = keypairAdapter.publicKey;
  }

  /**
   * Best-effort feature detection: true if WebAuthn with the PRF extension
   * might be available. Optimistic fallback (assumes supported) when
   * getClientCapabilities() is unavailable, since Chrome/Edge 116+ support
   * PRF without exposing that capabilities API until Chrome 120+.
   */
  static async isSupported(): Promise<boolean> {
    if (typeof window === "undefined") return false;
    if (!window.PublicKeyCredential) return false;
    if (typeof navigator.credentials?.get !== "function") return false;

    try {
      const caps = await (
        PublicKeyCredential as unknown as {
          getClientCapabilities?: () => Promise<Record<string, boolean>>;
        }
      ).getClientCapabilities?.();
      if (caps) return caps["extension:prf"] === true;
    } catch {
      // getClientCapabilities() not available — fall through to the
      // optimistic default below.
    }

    return true;
  }

  /**
   * Register a new WebAuthn credential (prompts the platform authenticator
   * or security key), evaluate the PRF extension, and derive an adapter
   * from the resulting seed.
   *
   * The caller MUST persist the returned credentialId (localStorage, a
   * database, ...) to pass into authenticate() on future sessions.
   */
  static async register(
    options: WebAuthnPrfRegisterOptions = {},
  ): Promise<WebAuthnPrfEncryptionAdapter> {
    assertWebAuthnAvailable();

    const salt = options.salt ?? DEFAULT_PRF_SALT;
    const rpId = options.rpId ?? window.location.hostname;
    const userVerification = options.userVerification ?? "required";
    const challenge =
      options.challenge ??
      globalThis.crypto.getRandomValues(new Uint8Array(32));
    const userId =
      options.userId ?? globalThis.crypto.getRandomValues(new Uint8Array(16));

    const credential = (await navigator.credentials.create({
      publicKey: {
        challenge: Uint8Array.from(challenge),
        rp: { name: options.rpName ?? "dStorage", id: rpId },
        user: {
          id: Uint8Array.from(userId),
          name: options.userName ?? "dstorage-user",
          displayName: options.userDisplayName ?? "dStorage User",
        },
        pubKeyCredParams:
          options.pubKeyCredParams ?? DEFAULT_PUB_KEY_CRED_PARAMS,
        authenticatorSelection: {
          userVerification,
          residentKey: options.residentKey ?? "preferred",
        },
        extensions: {
          prf: { eval: { first: Uint8Array.from(salt) } } satisfies PrfExtInput,
        } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential;

    const ext = credential.getClientExtensionResults() as {
      prf?: PrfExtOutput;
    };
    if (!ext.prf?.enabled) {
      throw new DStorageError(
        EncryptionErrorCode.WEBAUTHN_PRF_UNSUPPORTED_AT_REGISTRATION,
        "[dStorage] WebAuthnPrfEncryptionAdapter: this authenticator does not support the PRF extension. " +
          "Use MnemonicEncryptionAdapter or PasswordEncryptionAdapter instead.",
      );
    }

    const credentialId = new Uint8Array(credential.rawId);

    // Some authenticators return the PRF result directly from create();
    // others require a follow-up get() ceremony to evaluate it.
    const prfOutput =
      ext.prf.results?.first ??
      (
        await evaluatePrfAssertion([credentialId], {
          rpId,
          salt,
          userVerification,
          challenge: globalThis.crypto.getRandomValues(new Uint8Array(32)),
        })
      ).prfOutput;

    const seed = await buildSeed(prfOutput, options);
    const mnemonicAdapter = buildMnemonicAdapter(seed);
    seed.fill(0);
    const keypairAdapter = await mnemonicAdapter.intoKeypairEncryptionAdapter(
      options.shareContext ?? SHARE_CONTEXT,
      options.shareVariant ?? SHARE_VARIANT,
    );

    return new WebAuthnPrfEncryptionAdapter(
      credentialId,
      mnemonicAdapter,
      keypairAdapter,
    );
  }

  /**
   * Authenticate against one or more previously-registered credentials
   * (caller-supplied, e.g. loaded from localStorage) and derive the
   * adapter from the PRF evaluation.
   */
  static async authenticate(
    credentialIds: Uint8Array[],
    options: WebAuthnPrfAuthenticateOptions = {},
  ): Promise<WebAuthnPrfEncryptionAdapter> {
    if (credentialIds.length === 0 && !options.discoverable) {
      throw new DStorageError(
        EncryptionErrorCode.WEBAUTHN_PRF_EMPTY_CREDENTIAL_IDS,
        "[dStorage] WebAuthnPrfEncryptionAdapter: authenticate() requires at least one credential ID, " +
          "unless options.discoverable is true. Pass the credentialId returned by a previous register() call, " +
          "or set discoverable: true to let the browser pick from any resident passkey for this origin.",
      );
    }
    assertWebAuthnAvailable();

    const salt = options.salt ?? DEFAULT_PRF_SALT;
    const challenge =
      options.challenge ??
      globalThis.crypto.getRandomValues(new Uint8Array(32));

    const { prfOutput, rawId } = await evaluatePrfAssertion(
      options.discoverable ? [] : credentialIds,
      {
        ...(options.rpId !== undefined ? { rpId: options.rpId } : {}),
        salt,
        userVerification: options.userVerification ?? "required",
        challenge,
        discoverable: options.discoverable ?? false,
      },
    );

    const seed = await buildSeed(prfOutput, options);
    const mnemonicAdapter = buildMnemonicAdapter(seed);
    seed.fill(0);
    const keypairAdapter = await mnemonicAdapter.intoKeypairEncryptionAdapter(
      options.shareContext ?? SHARE_CONTEXT,
      options.shareVariant ?? SHARE_VARIANT,
    );

    return new WebAuthnPrfEncryptionAdapter(
      rawId,
      mnemonicAdapter,
      keypairAdapter,
    );
  }

  /** Always symmetric (cheap) — for this owner's own direct uploads. */
  async wrapDek(dek: Uint8Array): Promise<WrappedDekResult> {
    return this.mnemonicAdapter.wrapDek(dek);
  }

  /**
   * Dispatches on the wrapper shape: ML-KEM-wrapped data (kemCiphertext
   * present — wrapped by a 3rd party via fromPublicKey()) is unwrapped with
   * this adapter's derived secret key; symmetric data (this owner's own
   * direct uploads) is unwrapped via the internal MnemonicEncryptionAdapter.
   */
  async unwrapDek(data: WrappedDekResult): Promise<Uint8Array> {
    if (data.kemCiphertext !== undefined) {
      return this.keypairAdapter.unwrapDek(data);
    }
    return this.mnemonicAdapter.unwrapDek(data);
  }

  /**
   * Build an upload-only adapter from a raw public key previously shared by
   * a WebAuthnPrfEncryptionAdapter owner (via its `.publicKey` property).
   * No WebAuthn/browser dependency — usable anywhere, including a Node
   * backend. `.name` matches the owner's adapter so that, on the owner's
   * side, a single authenticate()d adapter can unwrap data wrapped here.
   */
  static fromPublicKey(
    publicKey: Uint8Array,
    options: WebAuthnPrfPublicKeyOptions = {},
  ): EncryptionAdapter {
    const keypairAdapter = KeypairEncryptionAdapter.fromPublicKey(
      publicKey,
      options.shareContext ?? SHARE_CONTEXT,
      options.shareVariant ?? SHARE_VARIANT,
    );
    return {
      name: "webauthn-prf",
      wrapDek: (dek) => keypairAdapter.wrapDek(dek),
      unwrapDek: (data) => keypairAdapter.unwrapDek(data),
    };
  }

  /**
   * Escape hatch: derive a deterministic ML-KEM keypair from this passkey's
   * seed under a caller-chosen context/variant. Delegates to
   * MnemonicEncryptionAdapter.intoKeypairEncryptionAdapter() so all KEK /
   * seed-expansion logic lives in one place. Independent of the fixed
   * internal keypair used by `.publicKey` / fromPublicKey() above.
   */
  async intoKeypairEncryptionAdapter(
    context: string,
    variant?: MLKemVariant,
  ): Promise<KeypairEncryptionAdapter> {
    return this.mnemonicAdapter.intoKeypairEncryptionAdapter(context, variant);
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function assertWebAuthnAvailable(): void {
  if (
    typeof window === "undefined" ||
    !window.PublicKeyCredential ||
    typeof navigator.credentials?.create !== "function" ||
    typeof navigator.credentials?.get !== "function"
  ) {
    throw new DStorageError(
      EncryptionErrorCode.WEBAUTHN_PRF_UNAVAILABLE,
      "[dStorage] WebAuthnPrfEncryptionAdapter: WebAuthn is not available in this environment. " +
        "Use a browser that supports the Credential Management API (navigator.credentials), " +
        "or use MnemonicEncryptionAdapter / PasswordEncryptionAdapter instead.",
    );
  }
}

async function evaluatePrfAssertion(
  credentialIds: Uint8Array[],
  params: {
    rpId?: string;
    salt: Uint8Array;
    userVerification: UserVerificationRequirement;
    challenge: Uint8Array;
    discoverable?: boolean;
  },
): Promise<{ prfOutput: ArrayBuffer; rawId: Uint8Array }> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: Uint8Array.from(params.challenge),
      ...(params.rpId !== undefined ? { rpId: params.rpId } : {}),
      // Omitted entirely (not just []) in discoverable mode, so the browser
      // shows its native picker across any resident passkey for this origin
      // instead of restricting to credentialIds.
      ...(params.discoverable
        ? {}
        : {
            allowCredentials: credentialIds.map((id) => ({
              type: "public-key" as const,
              id: Uint8Array.from(id),
            })),
          }),
      userVerification: params.userVerification,
      extensions: {
        prf: {
          eval: { first: Uint8Array.from(params.salt) },
        } satisfies PrfExtInput,
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential;

  const prf = (assertion.getClientExtensionResults() as { prf?: PrfExtOutput })
    .prf;

  if (!prf) {
    throw new DStorageError(
      EncryptionErrorCode.WEBAUTHN_PRF_NOT_PROCESSED,
      "[dStorage] WebAuthnPrfEncryptionAdapter: the PRF extension was not processed by this browser " +
        "(Chrome/Edge 116+ required). Use MnemonicEncryptionAdapter or PasswordEncryptionAdapter instead.",
    );
  }
  if (!prf.results?.first) {
    throw new DStorageError(
      EncryptionErrorCode.WEBAUTHN_PRF_NO_OUTPUT,
      "[dStorage] WebAuthnPrfEncryptionAdapter: PRF evaluation returned no output — this authenticator " +
        "may not support the CTAP2 hmac-secret extension. Use MnemonicEncryptionAdapter or PasswordEncryptionAdapter instead.",
    );
  }

  return {
    prfOutput: prf.results.first,
    rawId: new Uint8Array(assertion.rawId),
  };
}

async function expandPrfOutputToSeed(
  prfOutput: ArrayBuffer,
  info: Uint8Array,
): Promise<Uint8Array> {
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    "raw",
    prfOutput,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: Uint8Array.from(info),
    },
    keyMaterial,
    512, // 64 bytes
  );
  return new Uint8Array(bits);
}

/**
 * Dispatches on options.seedDerivation: "raw" (default "hkdf-expand") uses
 * the 32-byte PRF output directly as the seed, bypassing expandPrfOutputToSeed
 * entirely — for byte-for-byte compatibility with a pre-existing non-SDK
 * derivation scheme that did the same.
 */
async function buildSeed(
  prfOutput: ArrayBuffer,
  options: WebAuthnPrfDerivationOptions,
): Promise<Uint8Array> {
  if (options.seedDerivation === "raw") {
    // Copy, not a view — the caller fills the returned seed with zeros after
    // use, which must not reach back into the original PRF-output buffer.
    return Uint8Array.from(new Uint8Array(prfOutput));
  }
  return expandPrfOutputToSeed(
    prfOutput,
    options.seedExpandInfo ?? SEED_EXPAND_INFO,
  );
}

function buildMnemonicAdapter(seed: Uint8Array): MnemonicEncryptionAdapter {
  const seedHex = Array.from(seed, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return new MnemonicEncryptionAdapter({ seedHex });
}
