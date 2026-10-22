/**
 * Turns an unknown thrown value into text a model can act on.
 *
 * Tool handlers return this in `content` with `isError: true` instead of
 * throwing — a thrown error becomes an opaque protocol error, while a returned
 * error tells the model what to do next.
 *
 * Sourcing policy: these messages may name the upstream database but never a
 * client library. They therefore describe failures generically ("the upstream
 * service") and omit raw upstream error text for HTTP failures, which could
 * carry library internals. The raw error belongs in stderr logs, not in the
 * model's context.
 */

/**
 * The clients report HTTP failures in two shapes: an error with a numeric
 * `status` property, or a message embedding the status (for example
 * `Request to <url> failed: 404 Not Found` or `RxNorm returned HTTP 404`).
 */
const STATUS_IN_MESSAGE = /(?:failed:\s*|returned HTTP\s*|HTTP\s*)(\d{3})\b/i;

/** Network-level failures: nothing reached the upstream service. */
const NETWORK_FAILURE =
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|fetch failed|network|getaddrinfo/i;

/** Timeout wording used by every client when its request deadline expires. */
const TIMEOUT = /timed out|timeout/i;

/** Caller-cancellation wording used when a client wraps the DOMException. */
const ABORT = /\babort(?:ed)?\b/i;

export function toUserMessage(error: unknown, context: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const status = readStatus(error, raw);
  const name = errorName(error);

  if (status === 404) {
    return `Error: ${context} — not found (HTTP 404). Check the identifier or query and try again.`;
  }
  if (status === 429) {
    return `Error: ${context} — rate limited (HTTP 429). Wait a few seconds, then retry.`;
  }
  if (status !== undefined && status >= 500) {
    return `Error: ${context} — the upstream service returned HTTP ${status}. It may be temporarily unavailable; retry shortly.`;
  }
  if (status !== undefined) {
    return `Error: ${context} — HTTP ${status}. Check the request and try again.`;
  }

  if (name === "TimeoutError" || TIMEOUT.test(raw)) {
    return `Error: ${context} — the request timed out. Retry once; if it persists, raise DRUGDATA_TIMEOUT_MS.`;
  }
  if (name === "AbortError" || ABORT.test(raw)) {
    return `Error: ${context} — the request was cancelled.`;
  }
  if (NETWORK_FAILURE.test(raw)) {
    return `Error: ${context} — could not reach the upstream service. Check connectivity and retry.`;
  }

  return `Error: ${context} failed unexpectedly: ${raw}`;
}

/** Reads a numeric `status` property, falling back to the error message. */
function readStatus(error: unknown, raw: string): number | undefined {
  const fromProperty =
    typeof error === "object" && error !== null
      ? (error as { status?: unknown }).status
      : undefined;
  if (typeof fromProperty === "number") return fromProperty;

  const fromMessage = STATUS_IN_MESSAGE.exec(raw)?.[1];
  return fromMessage ? Number(fromMessage) : undefined;
}

/** Reads the error name without assuming `error` is an `Error`. */
function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}
