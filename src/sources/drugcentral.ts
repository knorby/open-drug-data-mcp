import {
  type DrugCentralClient,
  DrugCentralNotFoundError,
  type DrugStructure,
  type FaersPopulation,
  type GuidedResult,
  type IdentifierMatch,
  type IdentifierRecord,
  KNOWN_IDENTIFIER_TYPES,
  type OmopRelationship,
  type PopulationStampedSignal,
  type Struct2Atc,
  type StructureCandidate,
  type StructureProfile,
  type Synonym,
} from "@knorby/drugcentral-client";
import { getClients } from "../clients.js";
import { throwIfAborted } from "../lib/abort.js";
import { SourceInputError } from "../lib/errors.js";
import { isUnii } from "../lib/ids.js";
import type {
  ConditionAssertion,
  FaersSignal,
  IngredientClinical,
  IngredientCrosswalk,
  IngredientIdentifiers,
  IngredientProfile,
  IngredientRef,
  SourceRef,
} from "../lib/schemas.js";
import type {
  IngredientGroup,
  IngredientLookupRecord,
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
 * **Enrichment.** Every emitted ref costs two enrichment requests — the
 * structure row (primary CAS, InChIKey, status, preferred name
 * when the hit came from the crosswalk) and its ATC assignments (the
 * `ATC: …` summary). The pair is bounded to one page of hits and never walks
 * pages. The full identity view (complete crosswalk, synonyms, Orange Book
 * links, ATC rows) stays behind {@link createDrugCentralBridges}, which the
 * identity chain and `get_ingredient` call deliberately.
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

/** A prefixed crosswalk identifier, split at its first colon. */
const PREFIXED_IDENTIFIER = /^([^:]*):(.+)$/;

/** Clinical assertion rows emitted per category. */
const CLINICAL_LIMIT = 50;

/** FAERS signal rows emitted. */
const FAERS_LIMIT = 50;

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

/** The structure row and ATC assignments fetched for one search hit. */
interface StructureEnrichment {
  structure: DrugStructure | undefined;
  atc: Struct2Atc[];
}

/**
 * A short source-faithful summary: the structure's status flag and any ATC
 * codes assigned to it. Labels are ours; every value is DrugCentral's.
 */
function summaryOf(
  structure: DrugStructure | undefined,
  atc: readonly Struct2Atc[],
): string | undefined {
  const parts: string[] = [];
  const status = nonEmpty(structure?.status);
  if (status !== undefined) parts.push(`Status: ${status}`);

  const codes = unique(
    atc
      .map((row) => nonEmpty(row.atc_code))
      .filter((code): code is string => code !== undefined),
  );
  if (codes.length > 0) parts.push(`ATC: ${codes.join(", ")}`);

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Chemistry identifiers carried on the structure row itself. */
function structureIdentifiers(
  structure: DrugStructure | undefined,
): IngredientIdentifiers {
  const cas = nonEmpty(structure?.cas_reg_no);
  const inchikey = nonEmpty(structure?.inchikey);

  return {
    ...(cas === undefined ? {} : { cas: [cas] }),
    ...(inchikey === undefined ? {} : { inchiKey: inchikey }),
  };
}

/** Maps one guided name candidate to an ingredient ref. */
function candidateRef(
  candidate: StructureCandidate,
  enrichment: StructureEnrichment,
  retrievedAt: string,
): IngredientRef {
  const summary = summaryOf(enrichment.structure, enrichment.atc);
  return {
    name: nonEmpty(candidate.name) ?? String(candidate.structId),
    identifiers: {
      structId: candidate.structId,
      ...structureIdentifiers(enrichment.structure),
    },
    source: sourceOf(candidate.structId, retrievedAt),
    matchBasis:
      candidate.matchReason === "synonym"
        ? "synonym match"
        : "preferred-name match",
    ...(summary === undefined ? {} : { summary }),
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

/** Convenience aliases for crosswalk vocabularies in prefixed ids. */
const ID_TYPE_ALIASES: Readonly<Record<string, string>> = {
  RXCUI: "RXNORM",
  CAS: "SECONDARY_CAS_RN",
  DRUGBANK: "DRUGBANK_ID",
};

/**
 * Known identifier vocabularies and local aliases, for guidance only.
 * The guided resolver also accepts vocabularies absent from this snapshot.
 */
export const DRUGCENTRAL_IDENTIFIER_TYPES: readonly string[] = unique([
  ...KNOWN_IDENTIFIER_TYPES,
  ...Object.keys(ID_TYPE_ALIASES),
]);

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
  enrichment: StructureEnrichment,
  identity: QueryIdentity,
): IngredientIdentifiers {
  const structureFields = structureIdentifiers(enrichment.structure);
  const queryCas = identity.kind === "cas" ? [identity.value] : [];
  const cas = unique([...queryCas, ...(structureFields.cas ?? [])]);

  return {
    structId: match.structId,
    ...(identity.kind === "unii" ? { unii: identity.value } : {}),
    ...(identity.kind === "rxcui" ? { rxcui: [identity.value] } : {}),
    ...structureFields,
    ...(cas.length === 0 ? {} : { cas }),
  };
}

/** Maps one crosswalk match plus its structure enrichment to a ref. */
function identifierRef(
  match: IdentifierMatch,
  enrichment: StructureEnrichment,
  identity: QueryIdentity,
  retrievedAt: string,
): IngredientRef {
  const summary = summaryOf(enrichment.structure, enrichment.atc);
  return {
    name: nonEmpty(enrichment.structure?.name) ?? match.identifier,
    identifiers: identifierFields(match, enrichment, identity),
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

/**
 * Fetches one structure's ATC assignments. A 404 means DrugCentral assigned
 * no ATC code; that is absent data, not a failed search.
 */
async function atcById(
  client: DrugCentralClient,
  structId: number,
): Promise<Struct2Atc[]> {
  try {
    return await client.struct2atc.byStructId(structId);
  } catch (error) {
    if (error instanceof DrugCentralNotFoundError) return [];
    throw drugCentralFailure("The DrugCentral ingredient search", error);
  }
}

/**
 * Fetches the two enrichment tables for one hit concurrently. The pair is
 * bounded per page: at most two requests per emitted ref, never a page walk.
 */
async function enrichmentById(
  client: DrugCentralClient,
  structId: number,
): Promise<StructureEnrichment> {
  const [structure, atc] = await Promise.all([
    structureById(client, structId),
    atcById(client, structId),
  ]);
  return { structure, atc };
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

  const items: IngredientRef[] = [];
  for (const candidate of pageWindow(result.data, page)) {
    const enrichment = await enrichmentById(client, candidate.structId);
    items.push(
      candidateRef(candidate, enrichment, result.provenance.retrievedAt),
    );
  }

  return {
    source: "DrugCentral",
    items,
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
    const enrichment = await enrichmentById(client, match.structId);
    items.push(
      identifierRef(match, enrichment, identity, result.provenance.retrievedAt),
    );
  }

  return {
    source: "DrugCentral",
    items,
    page,
    hasMore: hasMoreInList(matches, page),
  };
}

/** A not-found error the tool layer renders as an ordinary 404. */
function drugCentralIngredientNotFound(id: string): Error {
  return Object.assign(
    new Error(
      `DrugCentral has no structure record for "${id}". Check the structure id or identifier, or search DrugCentral ingredients by name.`,
    ),
    { status: 404 },
  );
}

/** Values of one crosswalk vocabulary, in source order. */
function crosswalkValues(
  rows: readonly IdentifierRecord[],
  type: string,
): string[] {
  return rows
    .filter((row) => row.id_type === type)
    .map((row) => nonEmpty(row.identifier))
    .filter((value): value is string => value !== undefined);
}

/** PubChem identity comes from the crosswalk, never DrugCentral's cd_id. */
function pubChemCids(rows: readonly IdentifierRecord[]): number[] {
  return unique(
    crosswalkValues(rows, "PUBCHEM_CID")
      .filter((value) => /^\d+$/.test(value))
      .map(Number)
      .filter((value) => Number.isSafeInteger(value) && value > 0),
  );
}

/**
 * One vocabulary's own identifier, preferring a row that is not a parent or
 * salt link. DrugCentral marks parent/salt rows through `parent_match`; a
 * crosswalk can carry both, and the structure's own value is the better
 * unified identity.
 */
function ownCrosswalkValue(
  rows: readonly IdentifierRecord[],
  type: string,
): string | undefined {
  const candidates = rows.filter((row) => row.id_type === type);
  const own =
    candidates.find((row) => row.parent_match === null) ?? candidates[0];
  return own === undefined ? undefined : nonEmpty(own.identifier);
}

/** The full crosswalk as `{ type, value }` rows, deduplicated. */
function crosswalkOf(rows: readonly IdentifierRecord[]): IngredientCrosswalk[] {
  const seen = new Set<string>();
  const items: IngredientCrosswalk[] = [];
  for (const row of rows) {
    const type = nonEmpty(row.id_type);
    const value = nonEmpty(row.identifier);
    if (type === undefined || value === undefined) continue;
    const key = `${type}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ type, value });
  }
  return items;
}

/** The identifiers a structure profile proves. */
function profileIdentifiers(
  structure: DrugStructure,
  rows: readonly IdentifierRecord[],
  structId: number,
): IngredientIdentifiers {
  const ownUnii = ownCrosswalkValue(rows, "UNII")?.toUpperCase();
  const unii = ownUnii !== undefined && isUnii(ownUnii) ? ownUnii : undefined;
  const rxcui = unique(
    crosswalkValues(rows, "RXNORM").filter((value) => RXCUI.test(value)),
  );
  const cas = unique(
    [
      nonEmpty(structure.cas_reg_no),
      ...crosswalkValues(rows, "SECONDARY_CAS_RN"),
    ].filter((value): value is string => value !== undefined),
  );
  const inchiKey = nonEmpty(structure.inchikey);
  const cid = pubChemCids(rows);

  return {
    structId,
    ...(unii === undefined ? {} : { unii }),
    ...(rxcui.length === 0 ? {} : { rxcui }),
    ...(cas.length === 0 ? {} : { cas }),
    ...(inchiKey === undefined ? {} : { inchiKey }),
    ...(cid.length === 0 ? {} : { cid }),
  };
}

/** Maps one OMOP assertion, preserving the source's relationship label. */
function conditionOf(row: OmopRelationship): ConditionAssertion {
  const snomedConceptId =
    row.snomed_conceptid === null ? undefined : String(row.snomed_conceptid);
  return {
    name:
      nonEmpty(row.concept_name) ??
      nonEmpty(row.snomed_full_name) ??
      String(row.concept_id),
    relationship: row.relationship_name,
    conceptId: row.concept_id,
    ...(snomedConceptId === undefined ? {} : { snomedConceptId }),
    ...(nonEmpty(row.snomed_full_name) === undefined
      ? {}
      : { snomedFullName: nonEmpty(row.snomed_full_name) }),
    ...(nonEmpty(row.umls_cui) === undefined
      ? {}
      : { umlsCui: nonEmpty(row.umls_cui) }),
  };
}

/** Maps one FAERS signal, keeping the report-contingency counts. */
function faersSignalOf(row: PopulationStampedSignal): FaersSignal {
  const number = (value: number | null): number | undefined =>
    typeof value === "number" ? value : undefined;
  const llr = number(row.llr);
  const llrThreshold = number(row.llr_threshold);
  const drugAe = number(row.drug_ae);
  const drugNoAe = number(row.drug_no_ae);
  const noDrugAe = number(row.no_drug_ae);
  const noDrugNoAe = number(row.no_drug_no_ae);

  return {
    population: row.population,
    term:
      nonEmpty(row.meddra_name) ??
      (row.meddra_code === null
        ? "unnamed MedDRA term"
        : `MedDRA ${row.meddra_code}`),
    ...(llr === undefined ? {} : { llr }),
    ...(llrThreshold === undefined ? {} : { llrThreshold }),
    ...(drugAe === undefined ? {} : { drugAe }),
    ...(drugNoAe === undefined ? {} : { drugNoAe }),
    ...(noDrugAe === undefined ? {} : { noDrugAe }),
    ...(noDrugNoAe === undefined ? {} : { noDrugNoAe }),
  };
}

/**
 * Fetches the clinical assertions and FAERS signals for one structure.
 *
 * Everything is capped: each condition list keeps at most
 * {@link CLINICAL_LIMIT} rows and FAERS at most {@link FAERS_LIMIT}. A cap is
 * visible through `truncated`, so a missing row is never mistaken for an
 * absent fact.
 */
async function clinicalOf(
  client: DrugCentralClient,
  structId: number,
): Promise<IngredientClinical> {
  const [conditions, faers] = await Promise.all([
    guarded("The DrugCentral condition lookup", () =>
      client.guide.getConditionRelationships(structId),
    ),
    guarded("The DrugCentral FAERS lookup", () =>
      client.guide.getFaersSignals(structId, { population: "all" }),
    ),
  ]);

  const indications = conditions.data.filter(
    (row) => row.relationship_name === "indication",
  );
  const offLabelUses = conditions.data.filter(
    (row) => row.relationship_name === "off-label use",
  );
  const contraindications = conditions.data.filter(
    (row) => row.relationship_name === "contraindication",
  );
  const faersRows = faers.data.slice(0, FAERS_LIMIT);
  const truncated =
    indications.length > CLINICAL_LIMIT ||
    offLabelUses.length > CLINICAL_LIMIT ||
    contraindications.length > CLINICAL_LIMIT ||
    faers.data.length > FAERS_LIMIT;

  return {
    indications: indications.slice(0, CLINICAL_LIMIT).map(conditionOf),
    offLabelUses: offLabelUses.slice(0, CLINICAL_LIMIT).map(conditionOf),
    contraindications: contraindications
      .slice(0, CLINICAL_LIMIT)
      .map(conditionOf),
    faers: faersRows.map(faersSignalOf),
    truncated,
  };
}

/** The profile fields a DrugCentral structure record exposes. */
function structureProfileOf(
  structure: DrugStructure,
  profile: StructureProfile,
  clinical: IngredientClinical | undefined,
): IngredientProfile {
  const atc = unique(
    profile.atc
      .map((row) => nonEmpty(row.atc_code))
      .filter((code): code is string => code !== undefined),
  );
  const synonyms = unique(
    profile.synonyms
      .map((row: Synonym) => nonEmpty(row.name))
      .filter((name): name is string => name !== undefined),
  );
  const identifiers = crosswalkOf(profile.identifiers);
  const formula = nonEmpty(structure.cd_formula);
  const molecularWeight =
    typeof structure.cd_molweight === "number"
      ? structure.cd_molweight
      : undefined;
  const smiles = nonEmpty(structure.smiles);
  const inchi = nonEmpty(structure.inchi);
  const cid = pubChemCids(profile.identifiers)[0];

  return {
    structId: structure.id,
    ...(nonEmpty(structure.status) === undefined
      ? {}
      : { status: nonEmpty(structure.status) }),
    ...(nonEmpty(structure.cas_reg_no) === undefined
      ? {}
      : { cas: nonEmpty(structure.cas_reg_no) }),
    ...(nonEmpty(structure.inchikey) === undefined
      ? {}
      : { inchiKey: nonEmpty(structure.inchikey) }),
    ...(cid === undefined ? {} : { cid }),
    ...(formula === undefined ? {} : { formula }),
    ...(molecularWeight === undefined ? {} : { molecularWeight }),
    ...(smiles === undefined ? {} : { smiles }),
    ...(inchi === undefined ? {} : { inchi }),
    identifiers,
    atc,
    synonyms,
    ...(clinical === undefined ? {} : { clinical }),
  };
}

/** Resolves a caller id to one DrugCentral structure id. */
async function resolveStructId(
  client: DrugCentralClient,
  rawId: string,
): Promise<number> {
  const id = rawId.trim();
  if (RXCUI.test(id)) {
    const structId = Number(id);
    if (Number.isSafeInteger(structId) && structId > 0) return structId;
    throw new Error(
      `Expected a positive DrugCentral structure id, but got "${id}". Pass identifiers.structId from a DrugCentral ingredient result.`,
    );
  }

  const unii = isUnii(id.toUpperCase()) ? id.toUpperCase() : undefined;
  const cas = unii === undefined && CAS.test(id) ? id : undefined;
  const prefixed = PREFIXED_IDENTIFIER.exec(id);
  const prefixType = nonEmpty(prefixed?.[1])?.toUpperCase();
  const prefixValue = nonEmpty(prefixed?.[2]);
  const resolvedPrefixType =
    prefixType === undefined
      ? undefined
      : (ID_TYPE_ALIASES[prefixType] ?? prefixType);

  let matches: GuidedResult<IdentifierMatch[]>;
  if (unii !== undefined) {
    matches = await guarded("The DrugCentral identifier lookup", () =>
      client.guide.resolveByUnii(unii),
    );
  } else if (cas !== undefined) {
    matches = await guarded("The DrugCentral identifier lookup", () =>
      client.guide.resolveIdentifier({
        type: "SECONDARY_CAS_RN",
        value: cas,
      }),
    );
  } else if (resolvedPrefixType !== undefined && prefixValue !== undefined) {
    matches = await guarded("The DrugCentral identifier lookup", () =>
      client.guide.resolveIdentifier({
        type: resolvedPrefixType,
        value: prefixValue,
      }),
    );
  } else {
    throw new Error(
      `Expected a DrugCentral structure id or identifier, but got "${id}". Pass identifiers.structId, a UNII, a dashed CAS number, or a "TYPE:value" crosswalk identifier from a DrugCentral result.`,
    );
  }

  const exact = matches.data.filter((match: IdentifierMatch) => {
    const stored = match.identifier.trim();
    if (unii !== undefined) return stored.toUpperCase() === unii;
    if (cas !== undefined) return stored === cas;
    const matchType = match.idType.toUpperCase();
    return stored === prefixValue && matchType === resolvedPrefixType;
  });
  const structIds = unique(
    exact.map((match: IdentifierMatch) => match.structId),
  );

  if (structIds.length === 0) throw drugCentralIngredientNotFound(id);
  if (structIds.length > 1) {
    throw new SourceInputError(
      `DrugCentral maps "${id}" to several structures (${structIds.join(", ")}). Pass identifiers.structId from a DrugCentral result to choose one.`,
    );
  }
  return structIds[0] as number;
}

/** Fetches one structure profile and maps it to the unified record. */
async function fetchDrugCentralIngredient(
  client: DrugCentralClient,
  rawId: string,
  includeClinical: boolean,
): Promise<IngredientLookupRecord> {
  const structId = await resolveStructId(client, rawId);
  const result = await guarded("The DrugCentral structure profile lookup", () =>
    client.guide.getStructureProfile(structId),
  );
  const structure = result.data.structure;
  if (structure === null) throw drugCentralIngredientNotFound(rawId);

  const retrievedAt = result.provenance.retrievedAt;
  const identifiers = profileIdentifiers(
    structure,
    result.data.identifiers,
    structId,
  );
  const summary = summaryOf(structure, result.data.atc);
  const clinical = includeClinical
    ? await clinicalOf(client, structId)
    : undefined;
  const name =
    nonEmpty(structure.name) ??
    nonEmpty(
      result.data.synonyms.find((row) => row.preferred_name === 1)?.name,
    ) ??
    String(structId);

  return {
    ingredient: {
      name,
      identifiers,
      source: sourceOf(structId, retrievedAt),
      ...(summary === undefined ? {} : { summary }),
    },
    profile: structureProfileOf(structure, result.data, clinical),
  };
}

/**
 * The DrugCentral adapter: an ingredient-search adapter that always
 * implements ingredient search.
 */
export type DrugCentralAdapter = SourceAdapter & {
  searchIngredients: NonNullable<SourceAdapter["searchIngredients"]>;
  getIngredient: NonNullable<SourceAdapter["getIngredient"]>;
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
      signal?: AbortSignal,
    ): Promise<IngredientGroup[]> {
      throwIfAborted(signal);
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

    async getIngredient(
      id: string,
      opts: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<IngredientLookupRecord> {
      throwIfAborted(signal);
      return await fetchDrugCentralIngredient(
        clients(),
        id,
        opts.includeClinical === true,
      );
    },
  };
}

/** The identifier and profile bridges the identity chain consumes. */
export interface DrugCentralBridges {
  /** Structures with an exact PUBCHEM_CID crosswalk row. */
  structIdsForCid(cid: string): Promise<number[]>;
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
    async structIdsForCid(cid) {
      const value = cid.trim();
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
        return [];
      const result = await guarded(
        "The DrugCentral identifier lookup",
        async () => {
          try {
            return await clients().identifiers.byIdentifier(value);
          } catch (error) {
            if (error instanceof DrugCentralNotFoundError) return [];
            throw error;
          }
        },
      );
      return [
        ...new Set(
          result
            .filter(
              (row) =>
                row.id_type === "PUBCHEM_CID" &&
                row.identifier.trim() === value,
            )
            .map((row) => row.struct_id),
        ),
      ];
    },
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
