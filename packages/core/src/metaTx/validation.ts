/**
 * @dstorage/core — metaTx/validation.ts
 *
 * File validation for MetaTx uploads.
 */

import type { FileValidationResult } from "./types.js";

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

const ALLOWED_MIME_TYPES = new Set([
  // Images
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  // Documents
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "application/json",
  // Archives
  "application/zip",
]);

export function validateFile(file: File): FileValidationResult {
  if (file.size === 0) {
    return { valid: false, error: "File is empty." };
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    return {
      valid: false,
      error: `File too large: ${mb} MB. Maximum is 2 GB.`,
    };
  }
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    return {
      valid: false,
      error: `File type not supported: ${file.type || "unknown"}. Allowed: images, PDF, text, JSON, ZIP.`,
    };
  }
  return { valid: true };
}
