import type { NlmDrugsClient } from "@knorby/nlm-drugs-client";
import { getClients } from "../../clients.js";
import { readConfig } from "../../config.js";
import { toUserMessage } from "../../lib/errors.js";
import { InvalidCursorError } from "./cursor.js";
import { clinicaltrialsHandler, pubmedHandler } from "./literature.js";
import {
  medlineplusConnectHandler,
  medlineplusGeneticsHandler,
  medlineplusHandler,
} from "./medlineplus.js";
import {
  meshHandler,
  prescribableHandler,
  rxclassHandler,
  umlsHandler,
} from "./terminology.js";
import {
  ALLOWED_REFERENCE_TYPES,
  type ReferenceGroup,
  type ReferenceHandler,
  type ReferenceSearchInput,
  type ReferenceSourceId,
  type ReferenceTypeId,
} from "./types.js";

/**
 * Dispatches `drugdata_search_references` calls to one NLM reference handler.
 *
 * One call answers from exactly one source, so this is a router, not a
 * fan-out: it validates the source/type combination before any network call,
 * resolves the shared client and configuration lazily on every call, and
 * converts unexpected failures into an authored error group so one source's
 * outage is data about that source, never a protocol failure.
 */

/** Injected collaborators; production resolves them from process state. */
export interface ReferenceSearcherDeps {
  /** Overrides the shared NLM client (tests inject a fixture-backed one). */
  client?: NlmDrugsClient;
  /** Overrides whether a UMLS API key is configured (tests without env). */
  umlsConfigured?: boolean;
  /** Overrides whether the `nlm` adapter id is disabled (tests). */
  nlmDisabled?: boolean;
}

/** The callable the reference tool holds. */
export type ReferenceSearcher = (
  input: ReferenceSearchInput,
  signal?: AbortSignal,
) => Promise<ReferenceGroup>;

/**
 * Builds a reference searcher.
 *
 * Configuration is read per call, never at module load: a host can change the
 * environment and reset caches between calls, and `tools/list` must work
 * with no environment at all.
 */
export function createReferenceSearcher(
  deps: ReferenceSearcherDeps = {},
): ReferenceSearcher {
  const client = () => deps.client ?? getClients().nlm;
  const umlsConfigured = () => {
    if (deps.umlsConfigured !== undefined) return deps.umlsConfigured;
    const result = readConfig();
    return result.ok ? result.config.UMLS_API_KEY !== undefined : false;
  };
  const nlmDisabled = () => {
    if (deps.nlmDisabled !== undefined) return deps.nlmDisabled;
    const result = readConfig();
    return result.ok
      ? result.config.DRUGDATA_DISABLED_SOURCES.includes("nlm")
      : false;
  };

  const handlers: Record<ReferenceSourceId, () => ReferenceHandler> = {
    prescribable: () => prescribableHandler(client()),
    rxclass: () => rxclassHandler(client()),
    mesh: () => meshHandler(client()),
    pubmed: () => pubmedHandler(client()),
    medlineplus: () => medlineplusHandler(client()),
    medlineplus_genetics: () => medlineplusGeneticsHandler(client()),
    medlineplus_connect: () => medlineplusConnectHandler(client()),
    umls: () => umlsHandler(client(), umlsConfigured),
    clinicaltrials: () => clinicaltrialsHandler(client()),
  };

  return async (input, signal) => {
    // A disabled NLM adapter id switches off every reference source, exactly
    // as it switches off the RxNorm/DailyMed searches.
    if (nlmDisabled()) {
      return disabledGroup(input.source);
    }

    const allowed = ALLOWED_REFERENCE_TYPES[input.source];
    if (!allowed.includes(input.type)) {
      return {
        source: databaseFor(input.source),
        items: [],
        hasMore: false,
        error: `The ${labelFor(input.source)} reference source does not search by ${input.type}. It accepts ${allowed
          .map((type) => `'${type}'`)
          .join(", ")}.`,
      };
    }

    try {
      return await handlers[input.source]()(input, signal);
    } catch (error) {
      if (error instanceof InvalidCursorError) throw error;
      return {
        source: databaseFor(input.source),
        items: [],
        hasMore: false,
        error: toUserMessage(error, `the ${labelFor(input.source)} search`),
      };
    }
  };
}

/** The group every source returns when the `nlm` id is disabled. */
function disabledGroup(source: ReferenceSourceId): ReferenceGroup {
  return {
    source: databaseFor(source),
    items: [],
    hasMore: false,
    error:
      "The NLM sources are disabled for this process. Remove 'nlm' from DRUGDATA_DISABLED_SOURCES to use them.",
  };
}

/** The upstream database each reference source reports as. */
const DATABASE_FOR: Record<ReferenceSourceId, ReferenceGroup["source"]> = {
  prescribable: "RxNorm",
  rxclass: "RxClass",
  mesh: "MeSH",
  pubmed: "PubMed",
  medlineplus: "MedlinePlus",
  medlineplus_genetics: "MedlinePlus",
  medlineplus_connect: "MedlinePlus",
  umls: "UMLS",
  clinicaltrials: "ClinicalTrials.gov",
};

/** The upstream database a reference source reports as. */
function databaseFor(source: ReferenceSourceId): ReferenceGroup["source"] {
  return DATABASE_FOR[source];
}

/** The agent-facing name of one reference source. */
function labelFor(source: ReferenceSourceId): string {
  const labels: Record<ReferenceSourceId, string> = {
    prescribable: "Prescribable RxNorm",
    rxclass: "RxClass",
    mesh: "MeSH",
    pubmed: "PubMed",
    medlineplus: "MedlinePlus",
    medlineplus_genetics: "MedlinePlus Genetics",
    medlineplus_connect: "MedlinePlus Connect",
    umls: "UMLS",
    clinicaltrials: "ClinicalTrials.gov",
  };
  return labels[source];
}

export type { ReferenceSearchInput, ReferenceSourceId, ReferenceTypeId };
/**
 * Re-exported for the tool layer: the source/type combinations the searcher
 * accepts, so the tool can reject an invalid pairing before any network call.
 */
export { ALLOWED_REFERENCE_TYPES };
