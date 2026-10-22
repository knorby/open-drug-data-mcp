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
import { withFetchPolicy } from "./lib/fetch-policy.js";

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

  return {
    openfda: new OpenFdaClient({
      apiKey: config.OPENFDA_API_KEY,
      fetch: policyFetch,
      timeoutMs,
    }),
    cosing: new CosingClient({ fetch: policyFetch, timeoutMs }),
    nlm: new NlmDrugsClient({ fetch: policyFetch }),
    drugcentral: createDrugCentralClient({ fetch: policyFetch, timeoutMs }),
    dsld: new DsldClient({
      apiKey: config.DSLD_API_KEY,
      fetch: policyFetch,
      timeoutMs,
    }),
    // `requestIntervalMs` is intentionally omitted so the client keeps its
    // polite 1 s default; the timeout still follows the server's setting.
    inkeedecoder: createInkeedecoderClient({ fetch: policyFetch, timeoutMs }),
  };
}
