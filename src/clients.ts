/**
 * Shared, lazily constructed source clients.
 *
 * One instance per source, all constructed with the uniform fetch policy from
 * `lib/fetch-policy.ts`. The instances are module-level singletons because
 * INKEEDecoder's client paces its requests per instance: constructing a new
 * client per tool call would defeat that pacing and make rapid successive
 * calls impolite.
 *
 * Task 3 implements `getClients` / `resetClients` here. It is an empty module
 * until then so coverage stays meaningful: there is no half-built behavior to
 * test or to accidentally depend on.
 */

export {};
