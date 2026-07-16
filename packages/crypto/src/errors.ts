export class DStorageError extends Error {
  readonly code: number;
  readonly httpStatus?: number;

  constructor(
    code: number,
    message: string,
    options?: ErrorOptions & { httpStatus?: number },
  ) {
    super(message, options);
    this.name = "DStorageError";
    this.code = code;
    if (options?.httpStatus !== undefined) {
      this.httpStatus = options.httpStatus;
    }
  }
}

export function isDStorageError(err: unknown): err is DStorageError {
  return (
    err instanceof Error &&
    err.name === "DStorageError" &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "number"
  );
}

export const CryptoErrorCode = {
  WEBCRYPTO_NOT_AVAILABLE: 12000,
  BASE64URL_INVALID: 12001,
  MISSING_KEY_INPUT: 12002,
  MNEMONIC_TOO_SHORT: 12003,
  SEED_INVALID_LENGTH: 12004,
  MNEMONIC_INVALID: 12005,
  HEX_ODD_LENGTH: 12006,
  HEX_INVALID_CHARS: 12007,
  DEK_INVALID_LENGTH: 12008,
  WRAP_KEK_INVALID_LENGTH: 12009,
  UNWRAP_KEK_INVALID_LENGTH: 12010,
  ENVELOPE_EMPTY_WRAPPERS: 12011,
  XCHACHA_INVALID_STORAGE_ID_LEN: 12012,
  XCHACHA_PAYLOAD_MALFORMED: 12013,
  XCHACHA_STORAGE_ID_MALFORMED: 12014,
  MLKEM_SEED_INVALID_LENGTH: 12015,
  MLKEM_MISSING_CIPHERTEXT: 12016,
  MLKEM_UNKNOWN_ALGORITHM: 12017,
  MLKEM_UNKNOWN_VARIANT: 12018,
} as const;

export type CryptoErrorCode =
  (typeof CryptoErrorCode)[keyof typeof CryptoErrorCode];
