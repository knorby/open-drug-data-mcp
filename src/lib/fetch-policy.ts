/**
 * Uniform outgoing-fetch policy shared by every source client.
 *
 * One seam owns the two request controls the server imposes on all sources:
 * a per-attempt timeout and a single retry on HTTP 429 (honoring
 * `Retry-After`). Putting them here, rather than in each adapter, keeps
 * behavior identical across sources and keeps the clients unaware of the
 * server's configuration.
 */

/**
 * Longest `Retry-After` the server is willing to sit out. A 429 asking for a
 * longer wait is returned to the caller instead of retried early: the
 * upstream asked for that quiet period, and ignoring it would be impolite.
 */
const MAX_RETRY_AFTER_MS = 5_000;

/** Wait before the retry when a 429 carries no usable `Retry-After`. */
const DEFAULT_RETRY_DELAY_MS = 1_000;

/** Options accepted by {@link withFetchPolicy}. */
export interface FetchPolicyOptions {
  /** Abandon each attempt that takes longer than this, in milliseconds. */
  timeoutMs: number;
  /**
   * Retries to allow after a 429. Default 1; `0` disables the retry.
   * The policy never retries any other status.
   */
  retries?: number;
}

/**
 * Wraps a `fetch` implementation with the server's outgoing-request policy.
 *
 * Every attempt gets:
 *
 * - a fresh timeout signal (`AbortSignal.timeout`), so a slow first attempt
 *   cannot consume the second attempt's budget; and
 * - the caller's signal, composed with `AbortSignal.any`, so tools can cancel
 *   work without waiting for the deadline.
 *
 * A 429 is retried once when `Retry-After` is absent or asks for 5 seconds or
 * less. Other statuses, including a second 429, return the response unchanged:
 * mapping HTTP failures to agent-facing errors stays the clients'/tools' job.
 *
 * @param baseFetch The real fetch (or a test stub).
 * @param options Timeout and retry budget.
 * @returns A `fetch`-compatible function suitable for any client's `fetch`
 *   constructor option.
 */
export function withFetchPolicy(
  baseFetch: typeof fetch,
  options: FetchPolicyOptions,
): typeof fetch {
  const retries = options.retries ?? 1;

  return async (input, init) => {
    let attempt = 0;

    for (;;) {
      const callerSignal = init?.signal;
      const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, timeoutSignal])
        : timeoutSignal;

      const response = await baseFetch(input, { ...init, signal });

      if (response.status !== 429 || attempt >= retries) return response;

      const delayMs = retryDelayMs(response.headers.get("retry-after"));
      if (delayMs === undefined) return response;

      attempt += 1;
      await sleep(delayMs);
    }
  };
}

/**
 * Reads a `Retry-After` header as milliseconds.
 *
 * Only the delay-seconds form is understood (an integer count of seconds).
 * An HTTP-date is deliberately not guessed at: without a trustworthy local
 * clock comparison, not retrying is safer than retrying at the wrong time.
 *
 * @returns The wait, or `undefined` when the response should not be retried.
 */
function retryDelayMs(header: string | null): number | undefined {
  if (header === null) return DEFAULT_RETRY_DELAY_MS;

  const value = header.trim();
  if (!/^\d+$/.test(value)) return undefined;

  const delayMs = Number(value) * 1_000;
  return delayMs <= MAX_RETRY_AFTER_MS ? delayMs : undefined;
}

/** Waits before a retry. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
