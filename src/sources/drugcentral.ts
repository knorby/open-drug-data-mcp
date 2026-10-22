import {
  type DrugCentralClient,
  DrugCentralNotFoundError,
  type DrugStructure,
  type FaersPopulation,
  type GuidedResult,
  type IdentifierMatch,
  type OmopRelationship,
  type PopulationStampedSignal,
  type StructureCandidate,
  type StructureProfile,
} from "@knorby/drugcentral-client";
import { getClients } from "../clients.js";
import { isUnii } from "../lib/ids.js";
import type {
  IngredientIdentifiers,
  IngredientRef,
  SourceRef,
} from "../lib/schemas.js";
import type {
  IngredientGroup,
  IngredientSearchType,
  SourceAdapter,
} from "./types.js";

/**
 * The DrugCentral source adapter.
 *
 * DrugCentral structures are **active-ingredient identities**, not marketed
 * products: the adapter therefore serves ingredients only. It contributes the
 * identity crosswalk (UNII, RxCUI, CAS), ATC classifications, and the
 * structure profile that later tools use for indications, off-label uses,
 * contraindications, and FAERS signals.
 *
 * **Search strategy**, all through the client's guided layer:
 *
 * - `name` searches DrugCentral's own structure names and its synonym table.
 *   Ambiguity is preserved, and each ref says whether the hit was a
 *   preferred-name or synonym match.
 * - `unii`, `rxcui`, and `cas` resolve through the identifier crosswalk.
 *   DrugCentral records primary CAS numbers on the structure row and
 *   **secondary** CAS numbers in the crosswalk, so the `cas` type queries
 *   `SECONDARY_CAS_RN` and includes the structure's primary CAS when present.
 *   A primary CAS that DrugCentral did not also record as a secondary number
 *   is an ordinary miss.
 *
 * **No NDC → structure.** DrugCentral's product ids and `struct2obprod`
 * product ids are disjoint id spaces, and no obprod-by-NDC endpoint exists.
 * The client's `resolveByNdc` throws by design, so this adapter never offers
 * NDC or barcode product searches.
 *
 * **Pagination.** The guided name search caps client-side: the upstream name
 * filters ignore `limit` and return every row. The adapter asks for
 * `page * PAGE_SIZE` candidates, slices the requested page, and labels
 * `hasMore` from the client's truncation flag. Identifier lookups use the
 * same page window over their (normally one-to-one) matches. Neither path
 * walks pages on its own.
 *
 * **Enrichment.** A name candidate already carries a display name, so it is
 * emitted without another request. An identifier match carries no name, so
 * each match costs one structure fetch; that fetch also supplies the primary
 * CAS, InChIKey, PubChem CID, and status flag. The full identity view
 * (crosswalk identifiers, ATC assignments, marketed-product links) stays
 * behind {@link createDrugCentralBridges}, which the identity chain and
 * `get_ingredient` call deliberately.
 *
 * **Signals.** No resource or guided method in the DrugCentral client accepts
 * an `AbortSignal` (verified against the published type declarations), so an
 * `AbortSignal` passed through the `SourceAdapter` contract cannot cancel an
 * in-flight request. A zero-match path filter is HTTP 404 upstream and is an
 * ordinary empty group; other failures are reworded to name only DrugCentral.
 */

/** Records per page, matching the other search adapters. */
const PAGE_SIZE = 20;

/** RxCUIs are decimal strings. */
const RXCUI = /^\d+$/;

/** A CAS Registry Number, in the conventional dashed spelling. */
const CAS = /^\d{2,7}-\d{2}-\d$/;

/** A non-blank string, trimmed, or `undefined` when absent or blank. */
function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/** Deduplicates values without altering their spelling or order. */
function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** The slice of an unpaged list that belongs to `page`. */
function pageWindow<T>(values: readonly T[], page: number): T[] {
  const start = (page - 1) * PAGE_SIZE;
  return values.slice(start, start + PAGE_SIZE);
}

/** Whether an unpaged list has another page after `page`. */
function hasMoreInList<T>(values: readonly T[], page: number): boolean {
  return values.length > page * PAGE_SIZE;
}

/** An ordinary empty result: a zero match is not an error. */
function emptyIngredientGroup(page: number): IngredientGroup {
  return { source: "DrugCentral", items: [], page, hasMore: false };
}

/** Deep link to a DrugCentral structure drug card. */
function structureUrl(structId: number): string {
  return `https://drugcentral.org/drugcard/${structId}`;
}

/** The source reference every DrugCentral ref carries. */
function sourceOf(structId: number, retrievedAt: string): SourceRef {
  return {
    database: "DrugCentral",
    id: String(structId),
    url: structureUrl(structId),
    retrievedAt,
  };
}

/** A short source-faithful status line from the structure row. */
function summaryOf(structure: DrugStructure | undefined): string | undefined {
  const status = nonEmpty(structure?.status);
  return status === undefined ? undefined : `Status: ${status}`;
}

/** Maps one guided name candidate to an ingredient ref. */
function candidateRef(
  candidate: StructureCandidate,
  retrievedAt: string,
): IngredientRef {
  return {
    name: nonEmpty(candidate.name) ?? String(candidate.structId),
    identifiers: { structId: candidate.structId },
    source: sourceOf(candidate.structId, retrievedAt),
    matchBasis:
      candidate.matchReason === "synonym"
        ? "synonym match"
        : "preferred-name match",
  };
}

/** The identifier family an identifier search resolved. */
type QueryIdentity =
  | { kind: "unii"; value: string }
  | { kind: "rxcui"; value: string }
  | { kind: "cas"; value: string };

/** Model-facing label for each identifier family. */
const IDENTITY_LABEL: Record<QueryIdentity["kind"], string> = {
  unii: "UNII",
  rxcui: "RxCUI",
  cas: "CAS",
};

/**
 * Whether a crosswalk row's identifier equals the queried one.
 *
 * DrugCentral's `identifier/identifier/{value}` path filter is a **contains**
 * match upstream and filters only the vocabulary client-side, so an RxCUI of
 * `1191` also returns a row for `121191`. Every search here is an identifier
 * lookup, not a text search, so a substring row is a false positive and is
 * dropped rather than presented as a match.
 */
function matchesIdentity(
  match: IdentifierMatch,
  identity: QueryIdentity,
): boolean {
  const stored = match.identifier.trim();
  switch (identity.kind) {
    case "unii":
      return stored.toUpperCase() === identity.value;
    case "rxcui":
    case "cas":
      return stored === identity.value;
  }
}

/** Collapses crosswalk rows that point at the same structure. */
function uniqueMatches(matches: readonly IdentifierMatch[]): IdentifierMatch[] {
  const seen = new Set<number>();
  const uniqueRows: IdentifierMatch[] = [];
  for (const match of matches) {
    if (seen.has(match.structId)) continue;
    seen.add(match.structId);
    uniqueRows.push(match);
  }
  return uniqueRows;
}

/**
 * The identifiers an identifier-search ref can prove: the structure id, the
 * queried identifier, and whatever the structure row supplies.
 */
function identifierFields(
  match: IdentifierMatch,
  structure: DrugStructure | undefined,
  identity: QueryIdentity,
): IngredientIdentifiers {
  const queryCas = identity.kind === "cas" ? [identity.value] : [];
  const structureCas = nonEmpty(structure?.cas_reg_no);
  const cas = unique([
    ...queryCas,
    ...(structureCas === undefined ? [] : [structureCas]),
  ]);
  const inchikey = nonEmpty(structure?.inchikey);
  const cid = typeof structure?.cd_id === "number" ? [structure.cd_id] : [];

  return {
    structId: match.structId,
    ...(identity.kind === "unii" ? { unii: identity.value } : {}),
    ...(identity.kind === "rxcui" ? { rxcui: [identity.value] } : {}),
    ...(cas.length > 0 ? { cas } : {}),
    ...(inchikey === undefined ? {} : { inchiKey: inchikey }),
    ...(cid.length > 0 ? { cid } : {}),
  };
}

/** Maps one crosswalk match plus its structure row to an ingredient ref. */
function identifierRef(
  match: IdentifierMatch,
  structure: DrugStructure | undefined,
  identity: QueryIdentity,
  retrievedAt: string,
): IngredientRef {
  const summary = summaryOf(structure);
  return {
    name: nonEmpty(structure?.name) ?? match.identifier,
    identifiers: identifierFields(match, structure, identity),
    source: sourceOf(match.structId, retrievedAt),
    matchBasis: `${IDENTITY_LABEL[identity.kind]} ${match.matchKind} match`,
    ...(summary === undefined ? {} : { summary }),
  };
}

/**
 * Turns a failed request into model-facing text.
 *
 * The message carries only DrugCentral's status and advice: client package
 * names, raw URLs, upstream bodies, and the underlying error text are
 * deliberately dropped.
 */
function drugCentralFailure(context: string, error: unknown): Error {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  if (status === 429) {
    return new Error(
      `${context} was rate limited by DrugCentral (HTTP 429). Wait a few seconds, then retry.`,
    );
  }
  if (typeof status === "number" && status >= 500) {
    return new Error(
      `${context} failed: DrugCentral returned HTTP ${status} and may be temporarily unavailable. Retry shortly.`,
    );
  }
  if (typeof status === "number") {
    return new Error(
      `${context} failed: DrugCentral rejected the request (HTTP ${status}). Check the search value and try again.`,
    );
  }
  return new Error(
    `${context} failed: DrugCentral did not return a usable response. Retry shortly.`,
  );
}

/** Runs one upstream request behind the failure wording. */
async function guarded<T>(
  context: string,
  request: () => Promise<T>,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    throw drugCentralFailure(context, error);
  }
}

/**
 * Fetches one structure row. A 404 here means the crosswalk points at a
 * structure the API no longer returns; the ref still has its identifier, so
 * that is a missing enrichment, not a failed search.
 */
async function structureById(
  client: DrugCentralClient,
  structId: number,
): Promise<DrugStructure | undefined> {
  try {
    return (await client.structures.byId(structId))[0];
  } catch (error) {
    if (error instanceof DrugCentralNotFoundError) return undefined;
    throw drugCentralFailure("The DrugCentral ingredient search", error);
  }
}

/** Runs one guided name search and maps its page. */
async function nameGroup(
  client: DrugCentralClient,
  query: string,
  page: number,
): Promise<IngredientGroup> {
  const result = await guarded("The DrugCentral ingredient search", () =>
    client.guide.searchStructuresByName(query, { limit: page * PAGE_SIZE }),
  );

  return {
    source: "DrugCentral",
    items: pageWindow(result.data, page).map((candidate) =>
      candidateRef(candidate, result.provenance.retrievedAt),
    ),
    page,
    hasMore: result.truncated === true,
  };
}

/** Runs one guided identifier lookup and maps its page. */
async function identifierGroup(
  client: DrugCentralClient,
  identity: QueryIdentity,
  page: number,
): Promise<IngredientGroup> {
  const result = await guarded("The DrugCentral ingredient search", () => {
    switch (identity.kind) {
      case "unii":
        return client.guide.resolveByUnii(identity.value);
      case "rxcui":
        return client.guide.resolveByRxcui(identity.value);
      case "cas":
        return client.guide.resolveIdentifier({
          type: "SECONDARY_CAS_RN",
          value: identity.value,
        });
    }
  });

  const matches = uniqueMatches(
    result.data.filter((match) => matchesIdentity(match, identity)),
  );
  const items: IngredientRef[] = [];
  for (const match of pageWindow(matches, page)) {
    const structure = await structureById(client, match.structId);
    items.push(
      identifierRef(match, structure, identity, result.provenance.retrievedAt),
    );
  }

  return {
    source: "DrugCentral",
    items,
    page,
    hasMore: hasMoreInList(matches, page),
  };
}

/**
 * The DrugCentral adapter: an ingredient-search adapter that always
 * implements ingredient search.
 */
export type DrugCentralAdapter = SourceAdapter & {
  searchIngredients: NonNullable<SourceAdapter["searchIngredients"]>;
};

/**
 * Builds the DrugCentral adapter.
 *
 * @param client Optional client override. Tests inject one backed by
 *   fixtures; production falls back to the process-wide shared DrugCentral
 *   client.
 */
export function createDrugCentralAdapter(
  client?: DrugCentralClient,
): DrugCentralAdapter {
  const clients = () => client ?? getClients().drugcentral;

  const ingredientSearchTypes: IngredientSearchType[] = [
    "name",
    "unii",
    "cas",
    "rxcui",
  ];

  return {
    id: "drugcentral",
    databases: ["DrugCentral"],
    productSearchTypes: [],
    ingredientSearchTypes,
    productCategories: [],

    async searchIngredients(
      type: IngredientSearchType,
      query: string,
      page: number,
    ): Promise<IngredientGroup[]> {
      const trimmed = query.trim();
      if (trimmed.length === 0) return [emptyIngredientGroup(page)];

      if (type === "name") {
        return [await nameGroup(clients(), trimmed, page)];
      }

      if (type === "unii") {
        const unii = trimmed.toUpperCase();
        if (!isUnii(unii)) return [emptyIngredientGroup(page)];
        return [
          await identifierGroup(clients(), { kind: "unii", value: unii }, page),
        ];
      }

      if (type === "rxcui") {
        if (!RXCUI.test(trimmed)) return [emptyIngredientGroup(page)];
        return [
          await identifierGroup(
            clients(),
            { kind: "rxcui", value: trimmed },
            page,
          ),
        ];
      }

      if (type === "cas") {
        if (!CAS.test(trimmed)) return [emptyIngredientGroup(page)];
        return [
          await identifierGroup(
            clients(),
            { kind: "cas", value: trimmed },
            page,
          ),
        ];
      }

      return [emptyIngredientGroup(page)];
    },
  };
}

/** The identifier and profile bridges the identity chain consumes. */
export interface DrugCentralBridges {
  /** Structures DrugCentral maps a UNII to. */
  structIdsForUnii(unii: string): Promise<number[]>;
  /** Structures DrugCentral maps an RxCUI to. */
  structIdsForRxcui(rxcui: string): Promise<number[]>;
  /** The full identity view for one structure. */
  getProfile(structId: number): Promise<GuidedResult<StructureProfile>>;
  /** Conditions labeled exactly `"indication"`. */
  getIndications(structId: number): Promise<GuidedResult<OmopRelationship[]>>;
  /** Conditions labeled exactly `"off-label use"`. */
  getOffLabelUses(structId: number): Promise<GuidedResult<OmopRelationship[]>>;
  /** Conditions labeled exactly `"contraindication"`. */
  getContraindications(
    structId: number,
  ): Promise<GuidedResult<OmopRelationship[]>>;
  /** FAERS signals for one report-population stratum. */
  getFaersSignals(
    structId: number,
    population?: FaersPopulation,
  ): Promise<GuidedResult<PopulationStampedSignal[]>>;
}

/** Rejects a structure id that cannot identify a record. */
function assertStructId(structId: number): number {
  if (!Number.isInteger(structId) || structId <= 0) {
    throw new Error(
      `Expected a DrugCentral structure id, but got ${String(structId)}. Pass identifiers.structId from a DrugCentral ingredient result.`,
    );
  }
  return structId;
}

/** Collects unique structure ids from crosswalk matches. */
function distinctStructIds(matches: readonly IdentifierMatch[]): number[] {
  return unique(matches.map((match) => match.structId));
}

/**
 * Builds the chain-facing DrugCentral bridges.
 *
 * Invalid identifier shapes resolve to empty arrays (a zero match), and every
 * upstream failure is reworded to name only DrugCentral. The client's guided
 * methods accept no `AbortSignal`, so these bridges do not take one either;
 * a caller cannot cancel an in-flight DrugCentral request.
 *
 * @param client Optional client override, mirroring
 *   {@link createDrugCentralAdapter}.
 */
export function createDrugCentralBridges(
  client?: DrugCentralClient,
): DrugCentralBridges {
  const clients = () => client ?? getClients().drugcentral;

  return {
    async structIdsForUnii(unii) {
      const normalized = unii.trim().toUpperCase();
      if (!isUnii(normalized)) return [];

      const drugcentral = clients();
      const result = await guarded("The DrugCentral identifier lookup", () =>
        drugcentral.guide.resolveByUnii(normalized),
      );
      const identity: QueryIdentity = { kind: "unii", value: normalized };
      return distinctStructIds(
        result.data.filter((match) => matchesIdentity(match, identity)),
      );
    },

    async structIdsForRxcui(rxcui) {
      const trimmed = rxcui.trim();
      if (!RXCUI.test(trimmed)) return [];

      const drugcentral = clients();
      const result = await guarded("The DrugCentral identifier lookup", () =>
        drugcentral.guide.resolveByRxcui(trimmed),
      );
      const identity: QueryIdentity = { kind: "rxcui", value: trimmed };
      return distinctStructIds(
        result.data.filter((match) => matchesIdentity(match, identity)),
      );
    },

    async getProfile(structId) {
      const id = assertStructId(structId);
      const drugcentral = clients();
      return await guarded("The DrugCentral structure profile lookup", () =>
        drugcentral.guide.getStructureProfile(id),
      );
    },

    async getIndications(structId) {
      const id = assertStructId(structId);
      const drugcentral = clients();
      return await guarded("The DrugCentral condition lookup", () =>
        drugcentral.guide.getIndications(id),
      );
    },

    async getOffLabelUses(structId) {
      const id = assertStructId(structId);
      const drugcentral = clients();
      return await guarded("The DrugCentral condition lookup", () =>
        drugcentral.guide.getOffLabelUses(id),
      );
    },

    async getContraindications(structId) {
      const id = assertStructId(structId);
      const drugcentral = clients();
      return await guarded("The DrugCentral condition lookup", () =>
        drugcentral.guide.getContraindications(id),
      );
    },

    async getFaersSignals(structId, population) {
      const id = assertStructId(structId);
      const drugcentral = clients();
      return await guarded("The DrugCentral FAERS lookup", () =>
        drugcentral.guide.getFaersSignals(id, { population }),
      );
    },
  };
}

/** The process-wide adapter, backed by the shared DrugCentral client. */
export const drugcentralAdapter: DrugCentralAdapter =
  createDrugCentralAdapter();

/** The process-wide bridges, backed by the shared DrugCentral client. */
export const dcBridges: DrugCentralBridges = createDrugCentralBridges();
