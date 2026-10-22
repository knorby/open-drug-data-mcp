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

import { logError } from "./log.js";

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

/**
 * Thrown when a lookup cannot be routed to an adapter.
 *
 * The registry throws this instead of returning an empty result: a caller that
 * named a database the server cannot serve made a request error, not a search
 * that found nothing. Tool handlers catch it and return `isError` text, so the
 * message is model-facing and names only upstream databases and configuration
 * variables — never a client library.
 */
export class SourceRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceRoutingError";
  }
}

/**
 * An actionable caller-input error whose message is safe to show verbatim.
 *
 * Adapters use this for a value that is well-formed enough to reach them but
 * maps to more than one record (for example an ambiguous DrugCentral
 * identifier). The message names no client library, so tools can surface it
 * instead of the generic upstream-failure text.
 */
export class SourceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceInputError";
  }
}

/**
 * Client-library references that must never reach a model.
 *
 * The sourcing policy credits the upstream database, never the npm package
 * that fetched the data. Adapters reword their own failures, but a search can
 * receive an error group or a rejection from any adapter, so the tool layer
 * applies this last-line scrub before returning text.
 */
const CLIENT_PACKAGE = /@knorby\/[a-z0-9._-]+/gi;

/**
 * A client-library reference may appear as its own word (`client`) or inside a
 * camel-case class name (`OpenFdaClient`). Match the whole token so the
 * replacement leaves no fragment of the name behind, and do not use word
 * boundaries around the word itself: there is no boundary before `Client` in
 * a camel-case name.
 */
const CLIENT_WORD = /\b[\w.-]*client[\w.-]*\b/gi;

/** Rewords client-library names so output names only upstream databases. */
export function sanitizeSourceText(text: string): string {
  return text
    .replace(CLIENT_PACKAGE, "the upstream service")
    .replace(CLIENT_WORD, "upstream service");
}

export function toUserMessage(error: unknown, context: string): string {
  // A routing error already carries an actionable, database-only message; the
  // registry wrote it for the model, so pass it through untouched.
  if (error instanceof SourceRoutingError) return error.message;

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

  // Raw failure text can carry client-library class names and upstream
  // internals; it belongs in the operator's log, not in the model's context.
  logError(`${context} failed unexpectedly: ${raw}`);
  return `Error: ${context} failed unexpectedly. The upstream service returned an unusable response; retry once, then check the server logs.`;
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
