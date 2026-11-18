/**
 * @dstorage/core — replicas.ts
 *
 * Records extra copies of stored content inside the on-chain storageId string,
 * so replication needs no contract change:
 *
 *   private: <encryptStorageId(primary)>~r1~<base64url(encryptPayload(list))>
 *   public:  <primary>~r1~<base64url(list)>
 *
 * Without copies the on-chain value has no marker. ownerSecret is derived from
 * the primary only, so reading it never depends on the list.
 */

import {
  DStorageError,
  base64urlToBytes,
  bytesToBase64url,
} from "@dstorage/crypto";
import type { CryptoScheme } from "@dstorage/crypto";
import { CoreErrorCode } from "./errors.js";
import { REPLICAS_AAD } from "./types.js";
import type { ReplicaLocation } from "./types.js";

const REPLICA_MARKER = "~r1~";
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Upper limit on recorded copies. Public lists are untrusted chain data. */
export const MAX_REPLICAS = 16;

function invalid(message: string, cause?: unknown): DStorageError {
  return new DStorageError(
    CoreErrorCode.REPLICA_LIST_INVALID,
    `[dStorage] ${message}`,
    cause !== undefined ? { cause } : undefined,
  );
}

function validateList(parsed: unknown): ReplicaLocation[] {
  if (!Array.isArray(parsed) || parsed.length > MAX_REPLICAS) {
    throw invalid(
      `Replica list must be an array of at most ${MAX_REPLICAS} entries.`,
    );
  }
  return parsed.map((entry: unknown) => {
    const { provider, id, contentHash } = (entry ?? {}) as Record<
      string,
      unknown
    >;
    if (typeof provider !== "string" || provider.length === 0) {
      throw invalid("Replica entry has no provider.");
    }
    if (typeof id !== "string" || id.length === 0) {
      throw invalid("Replica entry has no id.");
    }
    if (contentHash === undefined) return { provider, id };
    if (
      typeof contentHash !== "string" ||
      !CONTENT_HASH_PATTERN.test(contentHash)
    ) {
      throw invalid("Replica entry has a malformed contentHash.");
    }
    return { provider, id, contentHash };
  });
}

/** Separates the primary part from the encoded list, without decoding either. */
export function splitOnChainStorageId(value: string): {
  primary: string;
  suffix?: string;
} {
  const at = value.indexOf(REPLICA_MARKER);
  if (at === -1) return { primary: value };
  return {
    primary: value.slice(0, at),
    suffix: value.slice(at + REPLICA_MARKER.length),
  };
}

/** Encodes `replicas` for the on-chain value. Pass no scheme for public content. */
export async function encodeReplicas(
  replicas: readonly ReplicaLocation[],
  scheme: CryptoScheme | null,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify(validateList(replicas)),
  );
  return bytesToBase64url(
    scheme ? await scheme.encryptPayload(bytes, REPLICAS_AAD) : bytes,
  );
}

/** Decodes an encoded list. Throws `REPLICA_LIST_INVALID` if it can't be trusted. */
export async function decodeReplicas(
  suffix: string,
  scheme: CryptoScheme | null,
): Promise<ReplicaLocation[]> {
  let parsed: unknown;
  try {
    const bytes = base64urlToBytes(suffix);
    parsed = JSON.parse(
      new TextDecoder().decode(
        scheme ? await scheme.decryptPayload(bytes, REPLICAS_AAD) : bytes,
      ),
    );
  } catch (err) {
    throw invalid("Replica list could not be decoded.", err);
  }
  return validateList(parsed);
}

/** Joins an already-encoded primary with its list. No copies leaves it unchanged. */
export async function composeOnChainStorageId(
  encodedPrimary: string,
  replicas: readonly ReplicaLocation[],
  scheme: CryptoScheme | null,
): Promise<string> {
  if (replicas.length === 0) return encodedPrimary;
  if (encodedPrimary.includes(REPLICA_MARKER)) {
    throw invalid(
      `Cannot record copies for a storageId containing "${REPLICA_MARKER}".`,
    );
  }
  return `${encodedPrimary}${REPLICA_MARKER}${await encodeReplicas(replicas, scheme)}`;
}

/**
 * Parses a public on-chain value. A suffix that doesn't decode means the marker
 * is part of the ID itself, as could happen with a custom adapter's older
 * references, so the whole string is the primary.
 */
export async function parsePublicStorageId(
  value: string,
): Promise<{ primary: string; replicas: ReplicaLocation[] }> {
  const { primary, suffix } = splitOnChainStorageId(value);
  if (suffix === undefined) return { primary, replicas: [] };
  try {
    return { primary, replicas: await decodeReplicas(suffix, null) };
  } catch {
    return { primary: value, replicas: [] };
  }
}
