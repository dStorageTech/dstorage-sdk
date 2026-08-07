/**
 * App-level bookkeeping of which WebAuthn credential IDs have been
 * registered on this device for the dStorage demo.
 *
 * The actual WebAuthn ceremony (registration/authentication) and PRF-based
 * seed derivation live in `@dstorage/encryption`'s `WebAuthnPrfEncryptionAdapter`
 * — this file only persists the resulting credential IDs to localStorage so
 * the app can call `WebAuthnPrfEncryptionAdapter.authenticate()` on future
 * sessions without re-registering.
 *
 * Multiple credential IDs are stored as a JSON array in localStorage so that
 * multiple users can each register their own key on the same browser/device.
 */

const CREDENTIAL_IDS_KEY = "dstorage:webauthn:credentialIds:v1";

function toBase64(id: Uint8Array): string {
  return btoa(Array.from(id, (b) => String.fromCharCode(b)).join(""));
}

/** Load all credential IDs previously registered on this device. */
export function loadCredentialIds(): Uint8Array[] {
  const raw = localStorage.getItem(CREDENTIAL_IDS_KEY);
  if (!raw) return [];
  try {
    const arr: string[] = JSON.parse(raw);
    return arr.map((b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  } catch {
    return [];
  }
}

/** Persist a credential ID returned by WebAuthnPrfEncryptionAdapter.register(). */
export function saveCredentialId(id: Uint8Array): void {
  const b64 = toBase64(id);
  const raw = localStorage.getItem(CREDENTIAL_IDS_KEY);
  const list: string[] = raw ? JSON.parse(raw) : [];
  if (list.includes(b64)) return;
  list.push(b64);
  localStorage.setItem(CREDENTIAL_IDS_KEY, JSON.stringify(list));
}

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
