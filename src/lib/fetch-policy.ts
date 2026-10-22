/**
 * Uniform outgoing-fetch policy shared by every source client.
 *
 * One seam owns the two request controls the server imposes on all sources:
 * a per-attempt timeout and a single retry on HTTP 429 (honoring
 * `Retry-After`). Putting them here, rather than in each adapter, keeps
 * behavior identical across sources and keeps the clients unaware of the
 * server's configuration.
 *
 * Task 3 implements `withFetchPolicy` in this module. It is an empty module
 * until then so coverage stays meaningful: there is no half-built behavior to
 * test or to accidentally depend on.
 */

export {};
