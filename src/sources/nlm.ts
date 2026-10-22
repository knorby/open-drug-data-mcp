import type {
  NlmDrugsClient,
  RxApproximateMatch,
  RxConcept,
  SplPage,
  SplSearch,
  SplSummary,
} from "@knorby/nlm-drugs-client";
import { getClients } from "../clients.js";
import { isSplSetId, isUnii, normalizeNdc } from "../lib/ids.js";
import type {
  IngredientIdentifiers,
  IngredientRef,
  IngredientRole,
  LabelSections,
  ProductIdentifiers,
  ProductRef,
  SourceRef,
} from "../lib/schemas.js";
import {
  dailyMedLabelUrl,
  extractSplUsageSections,
  parseSplLabel,
  type SplIngredient,
} from "./identity/spl-ingredients.js";
import type {
  IngredientGroup,
  IngredientSearchType,
  ProductGroup,
  ProductSearchType,
  SourceAdapter,
} from "./types.js";

/**
 * The NLM source adapter.
 *
 * Two NLM databases feed the unified vocabulary, and one adapter serves both
 * because every search can cross between them:
 *
 * - **RxNorm** supplies concepts (`RxCUI`) and their NDC crosswalk. A name
 *   search resolves concepts, an NDC search resolves the products that carry
 *   that package, and an ingredient search resolves the same concepts with
 *   `UNII` as an alternate key.
 * - **DailyMed** supplies Structured Product Label (SPL) documents. A name or
 *   NDC product search returns labels as `splSetId` references; the chain can
 *   fetch the XML by set id through {@link nlmBridges}.
 *
 * Product searches always emit two groups, RxNorm first and DailyMed second,
 * even when one is empty. Ingredient searches emit the RxNorm group alone:
 * DailyMed indexes labels, not ingredient records.
 *
 * **NDC spellings.** RxNorm accepts the canonical 11-digit NDC, but DailyMed's
 * search indexes the labeler's original 10-digit dashed layout (5-4-2, 4-4-2,
 * 5-3-2, or 5-4-1). The adapter derives those spellings from the canonical
 * form and probes them in a fixed order, stopping at the first layout with
 * hits. A zero match is an ordinary empty group; upstream failures are
 * reworded to name only the upstream database, never a client library, URL,
 * or key.
 *
 * **Pagination.** RxNorm name/NDC lookups return an unpaged id list, so the
 * adapter slices it into pages of {@link PAGE_SIZE}. DailyMed pages natively.
 * The adapter never walks pages on its own.
 */

/** Records per page, matching the openFDA and CosIng adapters. */
const PAGE_SIZE = 20;

/** Approximate name matches requested when an exact RxNorm name misses. */
const APPROXIMATE_LIMIT = 10;

/** RxCUIs are decimal strings. */
const RXCUI = /^\d+$/;

/** A non-blank string, trimmed, or `undefined` when absent or blank. */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/** Deduplicates values without altering their spelling or order. */
function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** The slice of an unpaged id list that belongs to `page`. */
function pageWindow<T>(values: readonly T[], page: number): T[] {
  const start = (page - 1) * PAGE_SIZE;
  return values.slice(start, start + PAGE_SIZE);
}

/** Whether an unpaged id list has another page after `page`. */
function hasMoreInList<T>(values: readonly T[], page: number): boolean {
  return values.length > page * PAGE_SIZE;
}

/** An ordinary empty RxNorm or DailyMed product group. */
function emptyProductGroup(
  source: "RxNorm" | "DailyMed",
  page: number,
): ProductGroup {
  return { source, items: [], page, hasMore: false };
}

/** An ordinary empty ingredient group. */
function emptyIngredientGroup(page: number): IngredientGroup {
  return { source: "RxNorm", items: [], page, hasMore: false };
}

/** Deep link to an RxNorm concept in the RxNav browser. */
function rxNormUrl(rxcui: string): string {
  return `https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm=${encodeURIComponent(
    rxcui,
  )}`;
}

/** Deep link to a DailyMed label. */
function dailyMedUrl(setid: string): string {
  return `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${encodeURIComponent(
    setid,
  )}`;
}

/**
 * The dashed NDC spellings DailyMed may have indexed for a canonical NDC.
 *
 * Canonical 11-digit NDCs are zero-padded 5-4-2. A labeler's printed NDC may
 * have dropped a leading zero from any segment, so every zero-padded segment
 * yields one unpadded spelling. Only zero-padded segments are expanded: a
 * segment that is not padded has no shorter original form.
 *
 * @returns Candidate spellings, or an empty list when the input is not an
 *   NDC. The canonical 5-4-2 spelling is always first.
 */
export function ndcSearchCandidates(ndc: string): string[] {
  const normalized = normalizeNdc(ndc);
  if (normalized === null) return [];

  const labeler = normalized.slice(0, 5);
  const product = normalized.slice(5, 9);
  const packageCode = normalized.slice(9);
  const forms = [`${labeler}-${product}-${packageCode}`];

  if (product.startsWith("0")) {
    forms.push(`${labeler}-${product.slice(1)}-${packageCode}`);
  }
  if (packageCode.startsWith("0")) {
    forms.push(`${labeler}-${product}-${packageCode.slice(1)}`);
  }
  if (labeler.startsWith("0")) {
    forms.push(`${labeler.slice(1)}-${product}-${packageCode}`);
  }
  return forms;
}

/** Maps an RxNorm concept to a product ref. */
function productRefOf(
  rxcuiValue: string | undefined,
  nameValue: string | undefined,
  retrievedAt: string,
  ndcs?: readonly string[],
): ProductRef | null {
  const rxcui = nonEmpty(rxcuiValue);
  if (rxcui === undefined) return null;

  const ndc = unique(
    (ndcs ?? [])
      .map((value) => nonEmpty(value))
      .filter((value): value is string => value !== undefined),
  );
  const identifiers: ProductIdentifiers = {
    rxcui: [rxcui],
    ...(ndc.length > 0 ? { ndc } : {}),
  };

  return {
    name: nonEmpty(nameValue) ?? rxcui,
    category: "medication",
    identifiers,
    source: {
      database: "RxNorm",
      id: rxcui,
      url: rxNormUrl(rxcui),
      retrievedAt,
    },
  };
}

/** Maps an RxNorm concept to an ingredient ref. */
function ingredientRefOf(
  rxcuiValue: string | undefined,
  nameValue: string | undefined,
  retrievedAt: string,
  options: { unii?: string; matchBasis?: string } = {},
): IngredientRef | null {
  const rxcui = nonEmpty(rxcuiValue);
  if (rxcui === undefined) return null;

  const identifiers: IngredientIdentifiers = {
    rxcui: [rxcui],
    ...(options.unii !== undefined ? { unii: options.unii } : {}),
  };

  return {
    name: nonEmpty(nameValue) ?? rxcui,
    identifiers,
    source: {
      database: "RxNorm",
      id: rxcui,
      url: rxNormUrl(rxcui),
      retrievedAt,
    },
    ...(options.matchBasis !== undefined
      ? { matchBasis: options.matchBasis }
      : {}),
  };
}

/**
 * Maps one page of RxNorm concept ids to products.
 *
 * Concepts are fetched sequentially to stay polite to RxNorm. A concept the
 * API no longer returns is dropped rather than emitted without identity.
 * `anchorNdc` opts into the NDC crosswalk for each concept; its canonical
 * spelling leads the identifier list because it is the caller's entry point.
 */
async function conceptProducts(
  client: NlmDrugsClient,
  ids: readonly string[],
  page: number,
  retrievedAt: string,
  signal: AbortSignal | undefined,
  anchorNdc?: string,
): Promise<ProductGroup> {
  const items: ProductRef[] = [];
  for (const rxcui of pageWindow(ids, page)) {
    const concept = await client.rxNorm.getConcept(rxcui, { signal });
    if (concept === undefined) continue;

    const ndcs =
      anchorNdc === undefined
        ? undefined
        : unique([
            anchorNdc,
            ...(await client.rxNorm.getNdcs(rxcui, { signal })),
          ]);
    const ref = productRefOf(concept.rxcui, concept.name, retrievedAt, ndcs);
    if (ref !== null) items.push(ref);
  }

  return {
    source: "RxNorm",
    items,
    page,
    hasMore: hasMoreInList(ids, page),
  };
}

/** Maps a DailyMed SPL summary to a product ref. */
function splProductRef(
  spl: SplSummary,
  setid: string,
  retrievedAt: string,
): ProductRef {
  const parts = [`SPL version ${spl.splVersion}`];
  const published = nonEmpty(spl.publishedDate);
  if (published !== undefined) parts.push(`published ${published}`);

  return {
    name: nonEmpty(spl.title) ?? setid,
    category: "medication",
    identifiers: { splSetId: setid },
    source: {
      database: "DailyMed",
      id: setid,
      url: dailyMedUrl(setid),
      retrievedAt,
    },
    summary: parts.join(" · "),
  };
}

/** Maps one DailyMed page to a product group. */
function dailyMedGroupOf(
  sourcePage: SplPage,
  page: number,
  retrievedAt: string,
): ProductGroup {
  const items: ProductRef[] = [];
  const seen = new Set<string>();
  for (const spl of sourcePage.items) {
    const setid = nonEmpty(spl.setid);
    if (setid === undefined || seen.has(setid)) continue;
    seen.add(setid);
    items.push(splProductRef(spl, setid, retrievedAt));
  }

  return {
    source: "DailyMed",
    items,
    page,
    hasMore: sourcePage.nextPage !== undefined,
  };
}

/** Runs one filtered DailyMed SPL page. */
async function dailyMedProducts(
  client: NlmDrugsClient,
  filters: SplSearch,
  page: number,
  retrievedAt: string,
  signal: AbortSignal | undefined,
): Promise<ProductGroup> {
  const sourcePage = await client.dailyMed.searchSpls(
    { ...filters, page, pageSize: PAGE_SIZE },
    { signal },
  );
  return dailyMedGroupOf(sourcePage, page, retrievedAt);
}

/**
 * DailyMed counterpart of {@link conceptProducts}: probes every labeler
 * spelling until one produces a page, then reports that layout's paging.
 * A page past a matching layout's last page is an ordinary empty group.
 */
async function dailyMedProductsByNdc(
  client: NlmDrugsClient,
  ndc: string,
  page: number,
  retrievedAt: string,
  signal: AbortSignal | undefined,
): Promise<ProductGroup> {
  for (const candidate of ndcSearchCandidates(ndc)) {
    const sourcePage = await client.dailyMed.searchSpls(
      { ndc: candidate, page, pageSize: PAGE_SIZE },
      { signal },
    );
    if (sourcePage.totalPages > 0) {
      return dailyMedGroupOf(sourcePage, page, retrievedAt);
    }
  }
  return emptyProductGroup("DailyMed", page);
}

/** RxNorm product lookup by name. */
async function rxNormProductsByName(
  client: NlmDrugsClient,
  name: string,
  page: number,
  retrievedAt: string,
  signal: AbortSignal | undefined,
): Promise<ProductGroup> {
  try {
    const ids = unique(await client.rxNorm.findConcepts(name, { signal }));
    return await conceptProducts(client, ids, page, retrievedAt, signal);
  } catch (error) {
    throw nlmFailure("The product search", "RxNorm", error);
  }
}

/** RxNorm product lookup by canonical NDC. */
async function rxNormProductsByNdc(
  client: NlmDrugsClient,
  ndc: string,
  page: number,
  retrievedAt: string,
  signal: AbortSignal | undefined,
): Promise<ProductGroup> {
  try {
    const ids = unique(await client.rxNorm.findByNdc(ndc, { signal }));
    return await conceptProducts(client, ids, page, retrievedAt, signal, ndc);
  } catch (error) {
    throw nlmFailure("The product search", "RxNorm", error);
  }
}

/** DailyMed product lookup with a failure wording of its own. */
async function dailyMedProductsSafely(
  client: NlmDrugsClient,
  filters: SplSearch,
  page: number,
  retrievedAt: string,
  signal: AbortSignal | undefined,
): Promise<ProductGroup> {
  try {
    return await dailyMedProducts(client, filters, page, retrievedAt, signal);
  } catch (error) {
    throw nlmFailure("The product search", "DailyMed", error);
  }
}

/** DailyMed NDC lookup with a failure wording of its own. */
async function dailyMedProductsByNdcSafely(
  client: NlmDrugsClient,
  ndc: string,
  page: number,
  retrievedAt: string,
  signal: AbortSignal | undefined,
): Promise<ProductGroup> {
  try {
    return await dailyMedProductsByNdc(client, ndc, page, retrievedAt, signal);
  } catch (error) {
    throw nlmFailure("The product search", "DailyMed", error);
  }
}

/** Extracts an object record from an untrusted raw payload. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * Extracts RxCUIs from the raw `findRxcuiById` payload used by the identifier
 * helpers. The raw helpers are untyped by design, so every level is checked.
 */
function rxcuisFromIdGroup(value: unknown): string[] {
  const group = asRecord(asRecord(value)?.idGroup);
  const ids = group?.rxnormId;
  if (!Array.isArray(ids)) return [];
  return ids.filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
}

/** Extracts SPL set ids from the raw DailyMed `spls` payload. */
function setidsFromSplPayload(value: unknown): string[] {
  const data = asRecord(value)?.data;
  if (!Array.isArray(data)) return [];
  const setids: string[] = [];
  for (const entry of data) {
    const setid = asRecord(entry)?.setid;
    if (typeof setid === "string" && setid.length > 0) setids.push(setid);
  }
  return unique(setids);
}

/**
 * Ingredient lookup by name: exact/normalized concepts first, then RxNorm's
 * approximate lexical matches. The fallback is labeled as approximate so the
 * caller never mistakes a fuzzy hit for a registry match.
 */
async function ingredientNameGroup(
  client: NlmDrugsClient,
  name: string,
  page: number,
  retrievedAt: string,
  signal: AbortSignal | undefined,
): Promise<IngredientGroup> {
  const ids = unique(await client.rxNorm.findConcepts(name, { signal }));
  if (ids.length > 0) {
    const items: IngredientRef[] = [];
    for (const rxcui of pageWindow(ids, page)) {
      const concept = await client.rxNorm.getConcept(rxcui, { signal });
      if (concept === undefined) continue;
      const ref = ingredientRefOf(concept.rxcui, concept.name, retrievedAt, {
        matchBasis: "name match",
      });
      if (ref !== null) items.push(ref);
    }
    return {
      source: "RxNorm",
      items,
      page,
      hasMore: hasMoreInList(ids, page),
    };
  }

  const matches = await client.rxNorm.approximateMatches(name, {
    maxEntries: APPROXIMATE_LIMIT,
    signal,
  });
  const byRxcui = new Map<string, RxApproximateMatch>();
  for (const match of matches) {
    const rxcui = nonEmpty(match.rxcui);
    if (rxcui === undefined) continue;
    const existing = byRxcui.get(rxcui);
    if (existing === undefined) {
      byRxcui.set(rxcui, match);
      continue;
    }
    // The same concept arrives once per source vocabulary; prefer a row that
    // carries a display name when the first one does not.
    if (
      nonEmpty(existing.name) === undefined &&
      nonEmpty(match.name) !== undefined
    ) {
      byRxcui.set(rxcui, match);
    }
  }

  const candidates = [...byRxcui.values()];
  const items: IngredientRef[] = [];
  for (const match of pageWindow(candidates, page)) {
    const concept = await client.rxNorm.getConcept(match.rxcui, { signal });
    const ref = ingredientRefOf(
      concept?.rxcui ?? match.rxcui,
      concept?.name ?? match.name,
      retrievedAt,
      { matchBasis: "approximate name match" },
    );
    if (ref !== null) items.push(ref);
  }

  return {
    source: "RxNorm",
    items,
    page,
    hasMore: hasMoreInList(candidates, page),
  };
}

/** Ingredient lookup by UNII through the raw crosswalk helper. */
async function ingredientUniiGroup(
  client: NlmDrugsClient,
  unii: string,
  page: number,
  retrievedAt: string,
  signal: AbortSignal | undefined,
): Promise<IngredientGroup> {
  const raw = await client.identifiers.rxCuisForUnii(unii, { signal });
  const ids = unique(rxcuisFromIdGroup(raw));

  const items: IngredientRef[] = [];
  for (const rxcui of pageWindow(ids, page)) {
    const concept = await client.rxNorm.getConcept(rxcui, { signal });
    if (concept === undefined) continue;
    const ref = ingredientRefOf(concept.rxcui, concept.name, retrievedAt, {
      unii,
      matchBasis: "UNII match",
    });
    if (ref !== null) items.push(ref);
  }

  return {
    source: "RxNorm",
    items,
    page,
    hasMore: hasMoreInList(ids, page),
  };
}

/** Ingredient lookup by a direct RxCUI. */
async function ingredientRxcuiGroup(
  client: NlmDrugsClient,
  rxcui: string,
  retrievedAt: string,
  signal: AbortSignal | undefined,
): Promise<IngredientGroup> {
  const concept = await client.rxNorm.getConcept(rxcui, { signal });
  const item =
    concept === undefined
      ? null
      : ingredientRefOf(concept.rxcui, concept.name, retrievedAt);

  return {
    source: "RxNorm",
    items: item === null ? [] : [item],
    page: 1,
    hasMore: false,
  };
}

/**
 * Turns a failed request into model-facing text.
 *
 * The message carries only the upstream database's status and advice: client
 * package names, raw URLs, upstream bodies, and the underlying error text are
 * deliberately dropped.
 */
function nlmFailure(
  context: string,
  database: "RxNorm" | "DailyMed",
  error: unknown,
): Error {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  if (status === 429) {
    return new Error(
      `${context} was rate limited by ${database} (HTTP 429). Wait a few seconds, then retry.`,
    );
  }
  if (typeof status === "number" && status >= 500) {
    return new Error(
      `${context} failed: ${database} returned HTTP ${status} and may be temporarily unavailable. Retry shortly.`,
    );
  }
  if (typeof status === "number") {
    return new Error(
      `${context} failed: ${database} rejected the request (HTTP ${status}). Check the search value and try again.`,
    );
  }
  return new Error(
    `${context} failed: ${database} did not return a usable response. Retry shortly.`,
  );
}

/** The detail fields an NLM product lookup exposes. */
export interface NlmProductDetails {
  version?: string;
  effectiveTime?: string;
  dosageForm?: string;
  labeler?: string;
  tty?: string;
  synonym?: string;
}

/** A full DailyMed or RxNorm product record in the unified vocabulary. */
export interface NlmProductRecord {
  product: ProductRef;
  ingredients: IngredientRef[];
  details: NlmProductDetails;
  summary?: string;
  labelIngredientsIncluded: boolean;
  labelSections?: LabelSections;
}

/** A not-found error the tool layer renders as an ordinary 404. */
function nlmProductNotFound(database: string, id: string): Error {
  return Object.assign(
    new Error(`${database} has no product record for "${id}".`),
    { status: 404 },
  );
}

/** A DailyMed source ref for one SPL label. */
function dailyMedSource(setid: string, retrievedAt: string): SourceRef {
  return {
    database: "DailyMed",
    id: setid,
    url: dailyMedLabelUrl(setid),
    retrievedAt,
  };
}

/** Maps parsed SPL ingredients to the unified ingredient vocabulary. */
function splIngredientRefs(
  entries: readonly SplIngredient[],
  source: SourceRef,
): IngredientRef[] {
  return entries.map((entry) => {
    const role: IngredientRole | undefined =
      entry.role === "unknown" ? undefined : entry.role;
    return {
      name: entry.name,
      ...(role !== undefined ? { role } : {}),
      ...(entry.strength !== undefined ? { quantity: entry.strength } : {}),
      ...(entry.form !== undefined ? { form: entry.form } : {}),
      identifiers: {
        ...(entry.unii !== undefined ? { unii: entry.unii } : {}),
      },
      source,
    };
  });
}

/** A DailyMed SPL product: identity from the XML plus its ingredient rows. */
async function dailyMedProduct(
  client: NlmDrugsClient,
  setid: string,
  includeLabelSections: boolean,
  retrievedAt: string,
  signal: AbortSignal | undefined,
): Promise<NlmProductRecord> {
  let xml: string;
  try {
    xml = await client.dailyMed.getSplXml(setid, { signal });
  } catch (error) {
    throw nlmFailure("The DailyMed product lookup", "DailyMed", error);
  }

  const label = parseSplLabel(xml);
  const source = dailyMedSource(setid, retrievedAt);
  const ndc = unique(
    label.ndcs
      .map((value) => normalizeNdc(value))
      .filter((value): value is string => value !== null),
  );
  const parts: string[] = [];
  if (label.version !== undefined) parts.push(`SPL version ${label.version}`);
  if (label.effectiveTime !== undefined) {
    parts.push(`effective ${label.effectiveTime}`);
  }
  if (label.dosageForm !== undefined) parts.push(label.dosageForm);
  if (label.labeler !== undefined) parts.push(`labeler ${label.labeler}`);
  const summary = parts.length > 0 ? parts.join(" · ") : undefined;

  const product: ProductRef = {
    name: label.productName ?? setid,
    category: "medication",
    identifiers: {
      splSetId: setid,
      ...(ndc.length > 0 ? { ndc } : {}),
    },
    source,
    ...(summary !== undefined ? { summary } : {}),
  };

  // Section extraction is a second parse of the same XML. Keep it strictly
  // opt-in so a lookup that did not ask for sections pays nothing for them.
  const extraction = includeLabelSections
    ? extractSplUsageSections(xml)
    : undefined;
  const labelSections: LabelSections | undefined =
    extraction === undefined
      ? undefined
      : {
          sections: extraction.sections,
          truncated: extraction.truncated,
        };

  return {
    product,
    ingredients: splIngredientRefs(label.ingredients, source),
    details: {
      version: label.version,
      effectiveTime: label.effectiveTime,
      dosageForm: label.dosageForm,
      labeler: label.labeler,
    },
    ...(summary !== undefined ? { summary } : {}),
    labelIngredientsIncluded: true,
    ...(labelSections !== undefined ? { labelSections } : {}),
  };
}

/** An RxNorm concept product: the concept plus its NDC crosswalk. */
async function rxNormProduct(
  client: NlmDrugsClient,
  rxcui: string,
  retrievedAt: string,
  signal: AbortSignal | undefined,
): Promise<NlmProductRecord> {
  let concept: RxConcept | undefined;
  try {
    concept = await client.rxNorm.getConcept(rxcui, { signal });
  } catch (error) {
    throw nlmFailure("The RxNorm product lookup", "RxNorm", error);
  }
  if (concept === undefined) throw nlmProductNotFound("RxNorm", rxcui);

  let ndc: string[];
  try {
    ndc = unique(await client.rxNorm.getNdcs(rxcui, { signal }));
  } catch (error) {
    throw nlmFailure("The RxNorm product lookup", "RxNorm", error);
  }

  const summary = `RxNorm term type ${concept.tty}`;
  return {
    product: {
      name: concept.name,
      category: "medication",
      identifiers: {
        rxcui: [rxcui],
        ...(ndc.length > 0 ? { ndc } : {}),
      },
      source: {
        database: "RxNorm",
        id: rxcui,
        url: rxNormUrl(rxcui),
        retrievedAt,
      },
      summary,
    },
    ingredients: [],
    details: {
      tty: concept.tty,
      synonym: concept.synonym,
    },
    summary,
    labelIngredientsIncluded: false,
  };
}

/**
 * Builds the NLM adapter.
 *
 * @param client Optional client override. Tests inject one backed by fixtures;
 *   production falls back to the process-wide shared NLM client.
 */
export function createNlmAdapter(client?: NlmDrugsClient): SourceAdapter {
  const clients = () => client ?? getClients().nlm;

  const productSearchTypes: ProductSearchType[] = ["name", "ndc"];
  const ingredientSearchTypes: IngredientSearchType[] = [
    "name",
    "unii",
    "rxcui",
  ];

  return {
    id: "nlm",
    databases: ["RxNorm", "DailyMed"],
    productSearchTypes,
    ingredientSearchTypes,
    productCategories: ["medication"],

    async searchProducts(
      type: ProductSearchType,
      query: string,
      page: number,
      signal?: AbortSignal,
    ): Promise<ProductGroup[]> {
      const trimmed = query.trim();
      const retrievedAt = new Date().toISOString();
      if (trimmed.length === 0) {
        return [
          emptyProductGroup("RxNorm", page),
          emptyProductGroup("DailyMed", page),
        ];
      }

      // Resolve the client before the failure boundary: configuration errors
      // are actionable as-is and must not be reworded as an upstream outage.
      const nlm = clients();

      if (type === "ndc") {
        const ndc = normalizeNdc(trimmed);
        if (ndc === null) {
          return [
            emptyProductGroup("RxNorm", page),
            emptyProductGroup("DailyMed", page),
          ];
        }
        return await Promise.all([
          rxNormProductsByNdc(nlm, ndc, page, retrievedAt, signal),
          dailyMedProductsByNdcSafely(nlm, ndc, page, retrievedAt, signal),
        ]);
      }

      if (type === "name") {
        return await Promise.all([
          rxNormProductsByName(nlm, trimmed, page, retrievedAt, signal),
          dailyMedProductsSafely(
            nlm,
            { drugName: trimmed },
            page,
            retrievedAt,
            signal,
          ),
        ]);
      }

      return [
        emptyProductGroup("RxNorm", page),
        emptyProductGroup("DailyMed", page),
      ];
    },

    async searchIngredients(
      type: IngredientSearchType,
      query: string,
      page: number,
      signal?: AbortSignal,
    ): Promise<IngredientGroup[]> {
      const trimmed = query.trim();
      const retrievedAt = new Date().toISOString();
      if (trimmed.length === 0) return [emptyIngredientGroup(page)];

      // Shape checks are local, so an unusable identifier never reaches NLM.
      if (type === "unii" && !isUnii(trimmed)) {
        return [emptyIngredientGroup(page)];
      }
      if (type === "rxcui" && !RXCUI.test(trimmed)) {
        return [emptyIngredientGroup(page)];
      }

      const nlm = clients();
      try {
        switch (type) {
          case "name":
            return [
              await ingredientNameGroup(
                nlm,
                trimmed,
                page,
                retrievedAt,
                signal,
              ),
            ];
          case "unii":
            return [
              await ingredientUniiGroup(
                nlm,
                trimmed.toUpperCase(),
                page,
                retrievedAt,
                signal,
              ),
            ];
          case "rxcui":
            if (page > 1) return [emptyIngredientGroup(page)];
            return [
              await ingredientRxcuiGroup(nlm, trimmed, retrievedAt, signal),
            ];
          default:
            return [emptyIngredientGroup(page)];
        }
      } catch (error) {
        throw nlmFailure("The ingredient search", "RxNorm", error);
      }
    },

    async getProduct(
      id: string,
      opts: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<NlmProductRecord> {
      const trimmed = id.trim();
      const retrievedAt = new Date().toISOString();
      const nlm = clients();

      if (isSplSetId(trimmed)) {
        return await dailyMedProduct(
          nlm,
          trimmed.toLowerCase(),
          opts.includeLabelSections === true,
          retrievedAt,
          signal,
        );
      }
      if (RXCUI.test(trimmed)) {
        return await rxNormProduct(nlm, trimmed, retrievedAt, signal);
      }

      throw new Error(
        `Expected a DailyMed SPL set id or an RxNorm rxcui, but got "${trimmed}". Pass identifiers.splSetId or identifiers.rxcui from an NLM result; use drugdata_search_products to find a label or drugdata_search_ingredients to find a concept.`,
      );
    },
  };
}

/** The identifier bridges the identity chain consumes. */
export interface NlmBridges {
  /** RxCUIs that RxNorm maps a UNII to. */
  rxcuisForUnii(unii: string, signal?: AbortSignal): Promise<string[]>;
  /** RxCUIs that RxNorm maps a canonical or dashed NDC to. */
  rxcuisForNdc(ndc: string, signal?: AbortSignal): Promise<string[]>;
  /** DailyMed SPL set ids carrying an NDC. */
  splsForNdc(ndc: string, signal?: AbortSignal): Promise<string[]>;
  /** DailyMed SPL set ids carrying an RxCUI. */
  splsForRxcui(rxcui: string, signal?: AbortSignal): Promise<string[]>;
  /** One DailyMed SPL document as XML. */
  getSplXml(setid: string, signal?: AbortSignal): Promise<string>;
}

/**
 * Builds the chain-facing identifier bridges.
 *
 * These are deliberately thin: the chain needs arrays of identifiers and one
 * XML document, not result refs. Invalid identifier shapes resolve to empty
 * arrays (a zero match), while upstream failures throw model-facing text.
 *
 * @param client Optional client override, mirroring {@link createNlmAdapter}.
 */
export function createNlmBridges(client?: NlmDrugsClient): NlmBridges {
  const clients = () => client ?? getClients().nlm;

  return {
    async rxcuisForUnii(unii, signal) {
      const trimmed = unii.trim().toUpperCase();
      if (!isUnii(trimmed)) return [];

      const nlm = clients();
      try {
        return unique(
          rxcuisFromIdGroup(
            await nlm.identifiers.rxCuisForUnii(trimmed, { signal }),
          ),
        );
      } catch (error) {
        throw nlmFailure("The RxNorm identifier lookup", "RxNorm", error);
      }
    },

    async rxcuisForNdc(ndc, signal) {
      const normalized = normalizeNdc(ndc);
      if (normalized === null) return [];

      const nlm = clients();
      try {
        return unique(await nlm.rxNorm.findByNdc(normalized, { signal }));
      } catch (error) {
        throw nlmFailure("The RxNorm identifier lookup", "RxNorm", error);
      }
    },

    async splsForNdc(ndc, signal) {
      const candidates = ndcSearchCandidates(ndc);
      if (candidates.length === 0) return [];

      const nlm = clients();
      try {
        for (const candidate of candidates) {
          const setids = setidsFromSplPayload(
            await nlm.identifiers.splsForNdc(candidate, { signal }),
          );
          if (setids.length > 0) return setids;
        }
        return [];
      } catch (error) {
        throw nlmFailure("The DailyMed identifier lookup", "DailyMed", error);
      }
    },

    async splsForRxcui(rxcui, signal) {
      const trimmed = rxcui.trim();
      if (!RXCUI.test(trimmed)) return [];

      const nlm = clients();
      try {
        return setidsFromSplPayload(
          await nlm.identifiers.splsForRxCui(trimmed, { signal }),
        );
      } catch (error) {
        throw nlmFailure("The DailyMed identifier lookup", "DailyMed", error);
      }
    },

    async getSplXml(setid, signal) {
      const trimmed = setid.trim();
      if (trimmed.length === 0) {
        throw new Error(
          "Expected a DailyMed SPL set id, but got an empty value.",
        );
      }

      const nlm = clients();
      try {
        return await nlm.dailyMed.getSplXml(trimmed, { signal });
      } catch (error) {
        throw nlmFailure("The DailyMed SPL lookup", "DailyMed", error);
      }
    },
  };
}

/** The process-wide adapter, backed by the shared NLM client. */
export const nlmAdapter: SourceAdapter = createNlmAdapter();

/** The process-wide identifier bridges, backed by the shared NLM client. */
export const nlmBridges: NlmBridges = createNlmBridges();
