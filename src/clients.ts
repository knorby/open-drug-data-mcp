import {
  createDrugCentralClient,
  type DrugCentralClient,
} from "@knorby/drugcentral-client";
import { CosingClient } from "@knorby/eu-cosing-client";
import {
  createInkeedecoderClient,
  type InkeedecoderClient,
} from "@knorby/inkeedecoder-client";
import { DsldClient } from "@knorby/nih-dsld-client";
import { NlmDrugsClient } from "@knorby/nlm-drugs-client";
import { OpenFdaClient } from "@knorby/openfda-client";
import { readConfig } from "./config.js";
import { MAX_RETRY_AFTER_MS, withFetchPolicy } from "./lib/fetch-policy.js";

/**
 * Shared, lazily constructed source clients.
 *
 * One instance per source, all constructed with the uniform fetch policy from
 * `lib/fetch-policy.ts`. The instances are module-level singletons because
 * INKEEDecoder's client paces its requests per instance: constructing a new
 * client per tool call would defeat that pacing and make rapid successive
 * calls impolite.
 *
 * Nothing here runs at import time: configuration is read and clients are
 * built on the first {@link getClients} call, so `tools/list` still works with
 * no environment variables and a misconfigured process can report the problem
 * from inside a tool call instead of failing to boot.
 */

/** The one shared instance of each source client. */
export interface Clients {
  readonly openfda: OpenFdaClient;
  readonly cosing: CosingClient;
  readonly nlm: NlmDrugsClient;
  readonly drugcentral: DrugCentralClient;
  readonly dsld: DsldClient;
  readonly inkeedecoder: InkeedecoderClient;
}

let cached: Clients | undefined;

/**
 * Returns the shared clients, constructing them on first use.
 *
 * @throws When configuration is invalid. The message names environment
 *   variables, never client packages, so it is safe to surface from a tool.
 */
export function getClients(): Clients {
  cached ??= createClients();
  return cached;
}

/**
 * Drops the cached clients. Tests call this (with `resetConfig`) after
 * changing configuration.
 */
export function resetClients(): void {
  cached = undefined;
}

/** Builds every client against one policy-wrapped fetch. */
function createClients(): Clients {
  const result = readConfig();
  if (!result.ok) throw new Error(result.error);

  const { config } = result;
  const timeoutMs = config.DRUGDATA_TIMEOUT_MS;
  const policyFetch = withFetchPolicy(globalThis.fetch, { timeoutMs });
  const clientTimeoutMs = clientDeadlineMs(timeoutMs);

  return {
    openfda: new OpenFdaClient({
      apiKey: config.OPENFDA_API_KEY,
      fetch: policyFetch,
      timeoutMs: clientTimeoutMs,
    }),
    cosing: new CosingClient({
      fetch: policyFetch,
      timeoutMs: clientTimeoutMs,
    }),
    nlm: new NlmDrugsClient({
      fetch: policyFetch,
      ...(config.UMLS_API_KEY === undefined
        ? {}
        : { umls: { apiKey: config.UMLS_API_KEY } }),
      ...(config.NLM_PUBMED_API_KEY === undefined &&
      config.NLM_PUBMED_EMAIL === undefined &&
      config.NLM_PUBMED_TOOL === undefined
        ? {}
        : {
            pubMed: {
              apiKey: config.NLM_PUBMED_API_KEY,
              email: config.NLM_PUBMED_EMAIL,
              tool: config.NLM_PUBMED_TOOL,
            },
          }),
    }),
    drugcentral: createDrugCentralClient({
      fetch: policyFetch,
      timeoutMs: clientTimeoutMs,
    }),
    dsld: new DsldClient({
      apiKey: config.DSLD_API_KEY,
      fetch: policyFetch,
      timeoutMs: clientTimeoutMs,
    }),
    // `requestIntervalMs` is intentionally omitted so the client keeps its
    // polite 1 s default; the timeout still derives from the server setting.
    inkeedecoder: createInkeedecoderClient({
      fetch: policyFetch,
      timeoutMs: clientTimeoutMs,
    }),
  };
}

/**
 * Headroom added to the client deadline so the fetch policy's timers always
 * win a near tie: a client arms its deadline just before the policy arms the
 * first attempt's.
 */
const CLIENT_DEADLINE_SLACK_MS = 1_000;

/**
 * Deadline handed to each client constructor.
 *
 * A client wraps the whole injected-fetch call in its own timeout and passes
 * that signal into the policy. If the client's deadline were just `timeoutMs`,
 * it would become a total deadline across the policy's retry, leaving the
 * retry only whatever remained after a slow first 429. The policy's worst case
 * is two attempts plus the longest honored `Retry-After` wait, so the client
 * deadline covers that — the policy's per-attempt timeout always fires first.
 *
 * @internal Exported for tests.
 */
export function clientDeadlineMs(timeoutMs: number): number {
  return timeoutMs * 2 + MAX_RETRY_AFTER_MS + CLIENT_DEADLINE_SLACK_MS;
}
