/**
 * Caller-cancellation helpers.
 *
 * The MCP host attaches an `AbortSignal` to each request. Sources whose client
 * accepts a per-call signal forward it; sources that do not are checked before
 * every request so a cancelled call stops instead of spending more upstream
 * quota. A cancelled call is rethrown to the tool boundary, which renders it
 * as an `isError` result rather than a normal empty answer.
 */

/** The reason a request was cancelled, preserving the caller's reason. */
export function abortReason(signal?: AbortSignal): unknown {
  if (signal?.reason !== undefined) return signal.reason;
  return new DOMException(
    "The request was cancelled by the caller.",
    "AbortError",
  );
}

/** Throws the caller's abort reason when the signal is already aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}
