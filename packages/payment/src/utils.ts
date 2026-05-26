const MAX_ERROR_BODY_LENGTH = 200;

/**
 * Sanitise a raw server error body before embedding it in a thrown Error.
 * - Strips ASCII control characters (log-injection / terminal escape attacks).
 * - Strips HTML tags (UI injection if the message is rendered in a browser).
 * - Truncates to MAX_ERROR_BODY_LENGTH characters.
 */
export function sanitiseErrorBody(raw: string): string {
  return raw
    .replace(/[\x00-\x1f\x7f]/g, " ") // control chars → space
    .replace(/<[^>]*>/g, "") // HTML tags → removed
    .trim()
    .slice(0, MAX_ERROR_BODY_LENGTH);
}
