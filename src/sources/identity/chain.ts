import type { IdentifierRecord } from "@knorby/drugcentral-client";
import type { Ingredient as ClientIngredient } from "@knorby/inkeedecoder-client";
import { throwIfAborted } from "../../lib/abort.js";
import { SourceInputError, toUserMessage } from "../../lib/errors.js";
import { logWarn } from "../../lib/log.js";
import type {
  DatabaseId,
  IngredientIdentifiers,
  IngredientRef,
  ProductRef,
} from "../../lib/schemas.js";
import { type CosingBridges, cosingBridges } from "../cosing.js";
import { type DrugCentralBridges, dcBridges } from "../drugcentral.js";
import { type DsldBridges, dsldBridges } from "../dsld.js";
import {
  type IkdBridges,
  identifierList,
  ikdBridges,
} from "../inkeedecoder.js";
import { type NlmBridges, nlmBridges } from "../nlm.js";
import {
  ingredientKey,
  type OpenFdaBridges,
  type OpenFdaSubstanceHit,
  openfdaBridges,
  splIngredientRefs,
} from "../openfda.js";
import { type PubChemBridges, pubChemBridges } from "../pubchem.js";
import { dailyMedLabelUrl, parseSplIngredients } from "./spl-ingredients.js";
import { effectiveUnii } from "./unii.js";

/**
 * The two-pass ingredient identity chain.
 *
 * Source steps run in a fixed order — openFDA → CosIng → RxNorm (NLM) →
 * DrugCentral — over one ingredient. A step links only on a confident match:
 * a direct identifier hit or a single top-tier name candidate. Ambiguous
 * results become candidate sets for the caller to choose from, and zero
 * matches are an ordinary outcome. The chain never throws for an unknown
 * identifier; an upstream failure costs that one source's link, not the
 * answer.
 *
 * Two passes, never a fixpoint: pass 2 re-runs a step only when its input
 * signature changed (for example, a CAS input did not resolve at openFDA,
 * CosIng supplied an INCI name, and openFDA can now answer the name search).
 * A step that linked, returned candidates, or failed is never re-run.
 *
 * After the four steps, two deliberately weak terminals run: DSLD ingredient
 * groups and an INKEEDecoder slug guess. Their results are always candidates
 * (`reason: "name-match"`), never links.
 */

/** Exactly one identifier family should be present; the tool enforces that. */
export interface ResolveInput {
  cid?: string;
  unii?: string;
  ndc?: string;
  rxcui?: string;
  cas?: string;
  inciName?: string;
  substanceName?: string;
  splSetId?: string;
  dsldId?: number;
}

/** Options accepted by {@link resolveIdentity}. */
export interface ResolveOptions {
  includeLabelIngredients?: boolean;
  resolveIngredients?: boolean;
  maxCandidates?: number;
}

/** How sure the chain is that a source link names the same substance. */
export type LinkConfidence = "direct" | "derived";

/** One confident cross-source link. */
export interface SourceLink {
  database: DatabaseId;
  id: string;
  url: string;
  matchedVia: string;
  confidence: LinkConfidence;
}

/** One ambiguous source result, never auto-linked. */
export interface CandidateSet {
  database: DatabaseId;
  matchedVia: string;
  reason: string;
  options: IngredientRef[];
  /**
   * True when the caller's cap kept some options out of `options`. The tool
   * text names the cap when set, so a short list is never mistaken for the
   * source's full match list.
   */
  optionsTruncated?: boolean;
}

/**
 * One non-fatal failure during resolution. A source outage costs that source's
 * link, not the answer, so it is reported here instead of thrown. `config`
 * means the process environment is invalid rather than an upstream outage.
 */
export interface ResolutionError {
  database: DatabaseId | "config";
  message: string;
}

/** The resolved identity graph for one ingredient. */
export interface IdentityGraph {
  /** Internal attributed evidence for entity aggregation; public graph schemas strip it. */
  records?: IngredientRef[];
  subject: { name?: string; inciName?: string };
  identifiers: IngredientIdentifiers;
  links: SourceLink[];
  candidates: CandidateSet[];
  errors?: ResolutionError[];
}

/** A product-level answer: its links plus the ingredient rows it carries. */
export interface ProductResolution {
  kind: "product";
  links: SourceLink[];
  candidates: CandidateSet[];
  ingredients: IngredientRef[];
  /**
   * Graphs for a **prefix** of {@link ingredients}, in the same order, when
   * `resolveIngredients` was requested. At most 20 ingredient graphs are
   * built; the briefed result shape has no truncation flag, so the full
   * `ingredients[]` list remains the authoritative row set.
   */
  graphs?: IdentityGraph[];
  errors?: ResolutionError[];
}

/** An ingredient-level answer: one identity graph. */
export interface IngredientResolution {
  kind: "ingredient";
  graph: IdentityGraph;
}

/** The minimal product record the chain needs from a source. */
export interface ProductRecord {
  product: ProductRef;
  ingredients: IngredientRef[];
  details?: { applicationNumber?: string };
}

/** The identifier and search bridges the chain consumes. */
export interface IdentityDeps {
  pubchem: PubChemBridges;
  openfda: OpenFdaBridges;
  cosing: CosingBridges;
  nlm: Pick<
    NlmBridges,
    | "conceptByRxcui"
    | "rxcuisForUnii"
    | "rxcuisForNdc"
    | "splsForNdc"
    | "getSplXml"
  >;
  drugcentral: Pick<
    DrugCentralBridges,
    "structIdsForCid" | "structIdsForUnii" | "structIdsForRxcui" | "getProfile"
  >;
  dsld: DsldBridges;
  inkeedecoder: {
    /** One ingredient page, or `null` when the slug guess finds nothing. */
    getIngredient(
      slug: string,
      signal?: AbortSignal,
    ): Promise<ClientIngredient | null>;
  };
}

/** The two-pass chain's source steps. */
export type ChainStepId =
  | "openfda"
  | "cosing"
  | "nlm"
  | "drugcentral"
  | "pubchem";

/** Candidate options kept per call unless the caller asks for fewer. */
const DEFAULT_MAX_CANDIDATES = 10;

/** Ingredient graphs resolved per product call; a bound, not completeness. */
export const MAX_INGREDIENT_GRAPHS = 20;

/** Stable source order for links and candidate sets. */
const DATABASE_ORDER: Readonly<Record<DatabaseId, number>> = {
  openFDA: 0,
  CosIng: 1,
  RxNorm: 2,
  DailyMed: 3,
  DrugCentral: 4,
  DSLD: 5,
  INKEEDecoder: 6,
  // The reference-only databases never appear in an identity graph today;
  // they are ordered after the record-owning databases so a future bridge
  // that emits one sorts deterministically.
  RxTerms: 7,
  RxClass: 8,
  MeSH: 9,
  PubMed: 10,
  MedlinePlus: 11,
  UMLS: 12,
  "ClinicalTrials.gov": 13,
  PubChem: 14,
};

/** A non-blank, trimmed string, or `undefined`. */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/** Deduplicates values without changing their spelling. */
function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Sorted, deduplicated string identifiers. */
function sortedValues(values: readonly string[]): string[] {
  return unique(values).sort((a, b) => a.localeCompare(b));
}

/** Sorted, deduplicated numeric identifiers. */
function sortedNumbers(values: readonly number[]): number[] {
  return unique(values).sort((a, b) => a - b);
}

/** The first UNII any identifier patch carries, in insertion order. */
function firstUnii(
  patches: readonly IngredientIdentifiers[],
): string | undefined {
  for (const patch of patches) {
    if (patch.unii !== undefined) return patch.unii;
  }
  return undefined;
}

/** The chain's effective UNII: openFDA link first, then the caller's input. */
function chainUnii(state: ChainState): string | undefined {
  return effectiveUnii({
    openfda:
      state.openfdaUnii !== undefined ? { unii: state.openfdaUnii } : undefined,
    unii: state.inputUnii ?? firstUnii(state.identifiers),
  });
}

/** URL for one RxNorm concept in the public RxNav browser. */
function rxnormUrl(rxcui: string): string {
  return `https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm=${encodeURIComponent(
    rxcui,
  )}`;
}

/** URL for one DrugCentral structure card. */
function drugCentralUrl(structId: number): string {
  return `https://drugcentral.org/drugcard/${structId}`;
}

/** URL for one DSLD label. */
function dsldLabelUrl(dsldId: number): string {
  return `https://dsld.od.nih.gov/label/${dsldId}`;
}

/** URL for the openFDA application-number query. */
function applicationUrl(applicationNumber: string): string {
  return `https://api.fda.gov/drug/ndc.json?search=${encodeURIComponent(
    `application_number:"${applicationNumber}"`,
  )}&limit=1`;
}

/** Deep link to an INKEEDecoder ingredient page. */
function inkeedecoderUrl(slug: string): string {
  return `https://inkeedecoder.com/ingredients/${slug}`;
}

/** One RxNorm ref, used for links and candidate options. */
function rxnormRef(
  name: string,
  rxcui: string,
  retrievedAt: string,
): IngredientRef {
  return {
    name,
    identifiers: { rxcui: [rxcui] },
    source: {
      database: "RxNorm",
      id: rxcui,
      url: rxnormUrl(rxcui),
      retrievedAt,
    },
  };
}

/** One DrugCentral candidate ref. */
function drugCentralRef(
  structId: number,
  name: string,
  retrievedAt: string,
): IngredientRef {
  return {
    name,
    identifiers: { structId },
    source: {
      database: "DrugCentral",
      id: String(structId),
      url: drugCentralUrl(structId),
      retrievedAt,
    },
  };
}

/** The slug INKEEDecoder uses for an ingredient name, as a best-effort guess. */
function slugGuess(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

/** The state one chain run accumulates. */
interface ChainState {
  records: IngredientRef[];
  input: ResolveInput;
  deps: IdentityDeps;
  signal: AbortSignal | undefined;
  /** Internal adapter ids switched off for this process. */
  disabled: ReadonlySet<string>;
  retrievedAt: string;
  subject: { name?: string; inciName?: string };
  links: SourceLink[];
  candidates: CandidateSet[];
  identifiers: IngredientIdentifiers[];
  errors: ResolutionError[];
  openfdaUnii: string | undefined;
  /** The normalized UNII/CAS value openFDA's direct probe already used. */
  directProbe: string | undefined;
  inputUnii: string | undefined;
  nlmRxcui: string | undefined;
  linked: Set<ChainStepId>;
  reviews: Set<ChainStepId>;
  failed: Set<ChainStepId>;
}

/** The result of one step attempt. */
type StepOutcome =
  | {
      status: "linked";
      ref: IngredientRef;
      matchedVia: string;
      confidence: LinkConfidence;
      identifiers?: IngredientIdentifiers;
      name?: string;
      inciName?: string;
    }
  | {
      status: "candidates";
      database: DatabaseId;
      matchedVia: string;
      reason: string;
      options: IngredientRef[];
    }
  | { status: "none" }
  | { status: "deferred" };

/** The first attempt's outcome and input signature, used by pass 2. */
interface FirstRun {
  outcome: StepOutcome;
  inputs: string;
}

/** One chain step and the signature of the inputs it consumes. */
interface Step {
  id: ChainStepId;
  /** Database credited when this step fails. */
  database: DatabaseId;
  run: (state: ChainState) => Promise<StepOutcome>;
  inputs: (state: ChainState) => string;
}

/** Builds a source link from a ref, with the chain's match provenance. */
function linkOf(
  ref: IngredientRef,
  matchedVia: string,
  confidence: LinkConfidence,
): SourceLink {
  return {
    database: ref.source.database,
    id: ref.source.id,
    url: ref.source.url,
    matchedVia,
    confidence,
  };
}

/** Records first-set-wins subject text. */
function applySubject(
  state: ChainState,
  name: string | undefined,
  inciName: string | undefined,
): void {
  const cleanName = nonEmpty(name);
  if (state.subject.name === undefined && cleanName !== undefined) {
    state.subject.name = cleanName;
  }
  const cleanInci = nonEmpty(inciName);
  if (state.subject.inciName === undefined && cleanInci !== undefined) {
    state.subject.inciName = cleanInci;
  }
}

/** Applies one linked step outcome to the graph state. */
function applyLinked(
  state: ChainState,
  outcome: Extract<StepOutcome, { status: "linked" }>,
): void {
  state.links.push(linkOf(outcome.ref, outcome.matchedVia, outcome.confidence));
  state.records.push(outcome.ref);
  state.identifiers.push(outcome.ref.identifiers);
  if (outcome.identifiers !== undefined)
    state.identifiers.push(outcome.identifiers);
  applySubject(
    state,
    outcome.name ??
      (outcome.ref.source.database === "openFDA" ||
      outcome.ref.source.database === "CosIng"
        ? outcome.ref.name
        : undefined),
    outcome.inciName ?? outcome.ref.inciName,
  );
  if (
    outcome.ref.source.database === "openFDA" &&
    outcome.ref.identifiers.unii !== undefined
  ) {
    state.openfdaUnii = outcome.ref.identifiers.unii;
  }
  if (outcome.ref.source.database === "RxNorm") {
    state.nlmRxcui = outcome.ref.source.id;
  }
}

/** Applies one candidate step outcome to the graph state. */
function applyCandidates(
  state: ChainState,
  outcome: Extract<StepOutcome, { status: "candidates" }>,
  cap: number,
): void {
  state.candidates.push({
    database: outcome.database,
    matchedVia: outcome.matchedVia,
    reason: outcome.reason,
    options: outcome.options.slice(0, cap),
    // The cap is caller-controlled; say when it hid options so the set is
    // never mistaken for the source's full match list.
    ...(outcome.options.length > cap ? { optionsTruncated: true } : {}),
  });
}

/** The text of a thrown value, without assuming it is an Error. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether a failure is the server's environment rather than an outage. */
function isConfigFailure(error: unknown): boolean {
  return /invalid environment configuration/i.test(errorText(error));
}

/** Records one source failure in the database vocabulary. */
function recordError(
  state: ChainState,
  database: DatabaseId,
  error: unknown,
): void {
  state.errors.push({
    database: isConfigFailure(error) ? "config" : database,
    message: authoredError(error, database, "identity step"),
  });
}

/**
 * Model-facing text for an unexpected step failure.
 *
 * Authored errors — configuration problems and caller-input errors — pass
 * through verbatim; anything unexpected becomes the generic actionable
 * message from `toUserMessage`, which logs the raw failure text to stderr.
 * Raw exception text never reaches the model.
 */
function authoredError(
  error: unknown,
  database: DatabaseId,
  what: string,
): string {
  if (isConfigFailure(error)) return errorText(error);
  if (error instanceof SourceInputError) return error.message;
  return toUserMessage(error, `the ${database} ${what}`);
}

/** Rethrows a caller cancellation instead of swallowing it. */
function rethrowIfCancelled(state: ChainState, error: unknown): void {
  if (state.signal?.aborted === true) throw error;
}

/** Whether an adapter is enabled for this process. */
function enabled(state: ChainState, adapterId: string): boolean {
  return !state.disabled.has(adapterId);
}

/** Runs the openFDA step: direct UNII/CAS first, then the name crosswalk. */
async function openfdaStep(state: ChainState): Promise<StepOutcome> {
  const { input } = state;
  const probe =
    input.unii !== undefined
      ? {
          key: `unii:${input.unii.trim().toUpperCase()}`,
          run: () =>
            state.deps.openfda.substanceByUnii(
              input.unii as string,
              state.signal,
            ),
        }
      : input.cas !== undefined
        ? {
            key: `cas:${input.cas.trim()}`,
            run: () =>
              state.deps.openfda.substanceByCas(
                input.cas as string,
                state.signal,
              ),
          }
        : undefined;
  let direct: IngredientRef | null = null;
  if (probe !== undefined && state.directProbe !== probe.key) {
    state.directProbe = probe.key;
    direct = await probe.run();
  }
  if (direct !== null) {
    return {
      status: "linked",
      ref: direct,
      matchedVia: input.unii !== undefined ? "unii" : "cas",
      confidence: "direct",
    };
  }

  const name =
    input.substanceName ??
    input.inciName ??
    state.subject.inciName ??
    state.subject.name;
  if (name === undefined) return { status: "none" };

  throwIfAborted(state.signal);
  const hits = await state.deps.openfda.substancesByName(name, state.signal);
  if (hits.length === 0) return { status: "none" };
  const top = hits[0] as OpenFdaSubstanceHit;
  // A name is only confident when exactly one candidate holds the top tier
  // and that tier is an actual name agreement. A lone unmatched or prefix hit
  // is still a guess, so it stays a candidate.
  const topTierHits = hits.filter((hit) => hit.tier === top.tier);
  const confidentTier = top.tier === "exact" || top.tier === "inci";
  if (confidentTier && topTierHits.length === 1) {
    return {
      status: "linked",
      ref: top.ingredient,
      matchedVia: top.tier === "inci" ? "inci" : "substance name",
      confidence: "derived",
    };
  }
  return {
    status: "candidates",
    database: "openFDA",
    matchedVia: "substance name",
    reason: "multiple-substance-matches",
    options: hits.map((hit) => hit.ingredient),
  };
}

/**
 * A CosIng hit is confident only when exactly one candidate holds the top
 * exact-INCI tier. A single fuzzy text hit is still a guess.
 */
function confidentCosing(
  hits: readonly { matchedOn: string; exact: boolean }[],
): boolean {
  const top = hits[0] as { matchedOn: string; exact: boolean };
  if (top.matchedOn !== "inciName" || !top.exact) return false;
  return (
    hits.filter((hit) => hit.matchedOn === "inciName" && hit.exact).length === 1
  );
}

/** Runs the CosIng step: CAS first when supplied, then INCI/name. */
async function cosingStep(state: ChainState): Promise<StepOutcome> {
  const { input } = state;
  const cas = nonEmpty(input.cas);
  if (cas !== undefined) {
    const hits = await state.deps.cosing.byCas(cas, state.signal);
    // CosIng's CAS query is a wildcard/substring search and reports no exact
    // flag, so only a record that actually carries this CAS is a match.
    const exact = hits.filter((hit) =>
      (hit.ingredient.identifiers.cas ?? []).some(
        (value) => value.trim() === cas,
      ),
    );
    if (exact.length > 1) {
      return {
        status: "candidates",
        database: "CosIng",
        matchedVia: "cas",
        reason: "multiple-cas-matches",
        options: exact.map((hit) => hit.ingredient),
      };
    }
    if (exact.length === 1) {
      const top = exact[0] as (typeof exact)[number];
      return {
        status: "linked",
        ref: top.ingredient,
        matchedVia: "cas",
        confidence: "direct",
      };
    }
    // A CAS miss can still name the same substance when an INCI hint exists;
    // fall through to the documented CAS-first-then-INCI order.
  }

  const hint = input.inciName ?? state.subject.inciName ?? state.subject.name;
  const inci = nonEmpty(hint);
  if (inci === undefined) return { status: "deferred" };

  throwIfAborted(state.signal);
  const hits = await state.deps.cosing.byInci(inci, state.signal);
  if (hits.length === 0) return { status: "none" };
  if (!confidentCosing(hits)) {
    return {
      status: "candidates",
      database: "CosIng",
      matchedVia: "inci",
      reason: "multiple-inci-matches",
      options: hits.map((hit) => hit.ingredient),
    };
  }
  const top = hits[0] as (typeof hits)[number];
  return {
    status: "linked",
    ref: top.ingredient,
    matchedVia: "inci",
    confidence: "direct",
  };
}

/**
 * Runs the RxNorm step from identifiers only: a direct RxCUI, or the
 * effective UNII crosswalk.
 *
 * Divergence from ritualog: its RxNorm name fallback is deliberately not
 * ported in v1. Name-based RxNorm hits were review-only there, and this chain
 * does not turn a name into a confident RxNorm link.
 */
async function nlmStep(state: ChainState): Promise<StepOutcome> {
  const direct = nonEmpty(state.input.rxcui);
  if (direct !== undefined) {
    const ref = await state.deps.nlm.conceptByRxcui(direct, state.signal);
    if (ref === null) return { status: "none" };
    return {
      status: "linked",
      ref,
      matchedVia: "rxcui",
      confidence: "direct",
      identifiers: ref.identifiers,
      name: ref.name,
    };
  }

  const unii = chainUnii(state);
  if (unii === undefined) return { status: "deferred" };

  const rxcuis = sortedValues(
    await state.deps.nlm.rxcuisForUnii(unii, state.signal),
  );
  if (rxcuis.length === 0) return { status: "none" };
  if (rxcuis.length > 1) {
    return {
      status: "candidates",
      database: "RxNorm",
      matchedVia: "unii",
      reason: "multiple-rxcui-matches",
      options: rxcuis.map((rxcui) =>
        rxnormRef(
          state.subject.name ?? state.subject.inciName ?? rxcui,
          rxcui,
          state.retrievedAt,
        ),
      ),
    };
  }
  const rxcui = rxcuis[0] as string;
  return {
    status: "linked",
    ref: rxnormRef(
      state.subject.name ?? state.subject.inciName ?? rxcui,
      rxcui,
      state.retrievedAt,
    ),
    matchedVia: "unii",
    confidence:
      state.inputUnii !== undefined && state.inputUnii === unii
        ? "direct"
        : "derived",
    identifiers: { rxcui: [rxcui] },
  };
}

/** The identifiers a DrugCentral structure profile contributes. */
function profileIdentifiers(
  profile: Awaited<ReturnType<DrugCentralBridges["getProfile"]>>["data"],
  structId: number,
): IngredientIdentifiers {
  let unii: string | undefined;
  const rxcui: string[] = [];
  const cas: string[] = [];
  for (const row of profile.identifiers) {
    switch (row.id_type) {
      case "UNII":
        if (unii === undefined) unii = row.identifier.trim().toUpperCase();
        break;
      case "RXNORM":
        rxcui.push(row.identifier.trim());
        break;
      case "CAS":
        cas.push(row.identifier.trim());
        break;
      default:
        break;
    }
  }
  if (cas.length === 0) {
    const registered = profile.structure?.cas_reg_no;
    if (registered !== null && registered !== undefined) {
      cas.push(registered);
    }
  }
  return {
    structId,
    ...(profile.structure?.inchikey
      ? { inchiKey: profile.structure.inchikey }
      : {}),
    cid: sortedNumbers(
      (profile.identifiers as IdentifierRecord[])
        .filter(
          (row) =>
            row.id_type === "PUBCHEM_CID" &&
            /^\d+$/.test(row.identifier.trim()),
        )
        .map((row) => Number(row.identifier))
        .filter((cid) => Number.isSafeInteger(cid) && cid > 0),
    ),
    ...(unii !== undefined ? { unii } : {}),
    ...(rxcui.length > 0 ? { rxcui } : {}),
    ...(cas.length > 0 ? { cas } : {}),
  };
}

/** Runs the DrugCentral step: a UNII or RxCUI crosswalk to a structure. */
async function drugcentralStep(state: ChainState): Promise<StepOutcome> {
  const unii = chainUnii(state);
  const rxcui = nonEmpty(state.input.rxcui) ?? state.nlmRxcui;
  const cid = nonEmpty(state.input.cid);
  if (unii === undefined && rxcui === undefined && cid === undefined) {
    return { status: "deferred" };
  }

  let structIds: number[] = [];
  let matchedVia: "unii" | "rxcui" | "cid" = "unii";
  if (unii !== undefined) {
    throwIfAborted(state.signal);
    structIds = await state.deps.drugcentral.structIdsForUnii(unii);
  }
  if (structIds.length === 0 && rxcui !== undefined) {
    throwIfAborted(state.signal);
    matchedVia = "rxcui";
    structIds = await state.deps.drugcentral.structIdsForRxcui(rxcui);
  }
  if (structIds.length === 0 && cid !== undefined) {
    throwIfAborted(state.signal);
    matchedVia = "cid";
    structIds = await state.deps.drugcentral.structIdsForCid(cid);
  }
  structIds = sortedNumbers(structIds);
  if (structIds.length === 0) return { status: "none" };
  if (structIds.length > 1) {
    return {
      status: "candidates",
      database: "DrugCentral",
      matchedVia,
      reason: "multiple-structure-matches",
      options: structIds.map((structId) =>
        drugCentralRef(
          structId,
          state.subject.name ??
            state.subject.inciName ??
            `DrugCentral ${structId}`,
          state.retrievedAt,
        ),
      ),
    };
  }

  const structId = structIds[0] as number;
  let identifiers: IngredientIdentifiers = { structId };
  let name: string | undefined;
  try {
    throwIfAborted(state.signal);
    const profile = await state.deps.drugcentral.getProfile(structId);
    identifiers = profileIdentifiers(profile.data, structId);
    name = nonEmpty(profile.data.structure?.name ?? undefined);
  } catch (error) {
    rethrowIfCancelled(state, error);
    // A profile failure should not cost the identifier link itself.
  }

  return {
    status: "linked",
    ref: {
      ...drugCentralRef(
        structId,
        name ??
          state.subject.name ??
          state.subject.inciName ??
          `DrugCentral ${structId}`,
        state.retrievedAt,
      ),
      identifiers,
    },
    matchedVia,
    confidence:
      (matchedVia === "unii" &&
        state.inputUnii !== undefined &&
        state.inputUnii === unii) ||
      (matchedVia === "rxcui" && nonEmpty(state.input.rxcui) !== undefined) ||
      matchedVia === "cid"
        ? "direct"
        : "derived",
    identifiers,
    ...(name !== undefined ? { name } : {}),
  };
}

async function pubchemStep(state: ChainState): Promise<StepOutcome> {
  const cids = sortedNumbers(
    state.identifiers.flatMap((patch) => patch.cid ?? []),
  );
  if (cids.length === 0) return { status: "deferred" };
  if (cids.length > 1)
    return {
      status: "candidates",
      database: "PubChem",
      matchedVia: "cid",
      reason: "multiple-cid-matches",
      options: cids.map((cid) => ({
        name: `PubChem CID ${cid}`,
        identifiers: { cid: [cid] },
        source: {
          database: "PubChem",
          id: String(cid),
          url: `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`,
          retrievedAt: state.retrievedAt,
        },
      })),
    };
  const cid = cids[0];
  const ref = await state.deps.pubchem.compoundByCid(String(cid), state.signal);
  if (ref === null) return { status: "none" };
  return {
    status: "linked",
    ref,
    matchedVia: "cid",
    confidence: state.input.cid !== undefined ? "direct" : "derived",
    identifiers: ref.identifiers,
  };
}

/** The fixed chain order and each step's dynamic-input signature. */
const STEPS: readonly Step[] = [
  {
    id: "openfda",
    database: "openFDA",
    run: openfdaStep,
    inputs: (state) =>
      `openfda:${state.subject.inciName ?? state.subject.name ?? ""}`,
  },
  {
    id: "cosing",
    database: "CosIng",
    run: cosingStep,
    inputs: (state) =>
      `cosing:${nonEmpty(state.input.cas) ?? ""}:${
        nonEmpty(state.input.inciName) ??
        state.subject.inciName ??
        state.subject.name ??
        ""
      }`,
  },
  {
    id: "nlm",
    database: "RxNorm",
    run: nlmStep,
    inputs: (state) =>
      `unii:${chainUnii(state) ?? ""}:${nonEmpty(state.input.rxcui) ?? ""}`,
  },
  {
    id: "drugcentral",
    database: "DrugCentral",
    run: drugcentralStep,
    inputs: (state) =>
      `dc:${chainUnii(state) ?? ""}:${
        nonEmpty(state.input.rxcui) ?? state.nlmRxcui ?? ""
      }:${state.input.cid ?? ""}`,
  },
  {
    id: "pubchem",
    database: "PubChem",
    run: pubchemStep,
    inputs: (state) =>
      JSON.stringify(state.identifiers.flatMap((patch) => patch.cid ?? [])),
  },
];

/** Runs the fixed two-pass chain and mutates the state as steps answer. */
async function runChain(state: ChainState, cap: number): Promise<void> {
  const firstRuns = new Map<ChainStepId, FirstRun>();

  const attempt = async (step: Step): Promise<void> => {
    throwIfAborted(state.signal);
    let outcome: StepOutcome;
    try {
      outcome = await step.run(state);
    } catch (error) {
      rethrowIfCancelled(state, error);
      logWarn(`identity ${step.id} step failed`);
      state.failed.add(step.id);
      recordError(state, step.database, error);
      return;
    }
    throwIfAborted(state.signal);
    firstRuns.set(step.id, { outcome, inputs: step.inputs(state) });
    if (outcome.status === "linked") {
      applyLinked(state, outcome);
      state.linked.add(step.id);
    } else if (outcome.status === "candidates") {
      applyCandidates(state, outcome, cap);
      state.reviews.add(step.id);
    }
  };

  for (let pass = 1; pass <= 2; pass += 1) {
    for (const step of STEPS) {
      if (!enabled(state, step.id === "pubchem" ? "nlm" : step.id)) continue;
      throwIfAborted(state.signal);
      if (pass === 1) {
        await attempt(step);
        continue;
      }
      if (
        state.linked.has(step.id) ||
        state.failed.has(step.id) ||
        state.reviews.has(step.id)
      ) {
        continue;
      }
      const first = firstRuns.get(step.id) as FirstRun;
      const inputs = step.inputs(state);
      if (first.inputs === inputs) continue;
      await attempt(step);
    }
  }
}

/** Combines identifier patches in first-set-wins order for scalar keys. */
function combineIdentifiers(
  patches: readonly IngredientIdentifiers[],
  uniiOverride: string | undefined,
): IngredientIdentifiers {
  let structId: number | undefined;
  let inchiKey: string | undefined;
  const cid: number[] = [];
  const cas: string[] = [];
  const ec: string[] = [];
  const rxcui: string[] = [];

  for (const patch of patches) {
    inchiKey ??= patch.inchiKey;
    cid.push(...(patch.cid ?? []));
    if (structId === undefined && patch.structId !== undefined) {
      structId = patch.structId;
    }
    cas.push(...(patch.cas ?? []));
    ec.push(...(patch.ec ?? []));
    rxcui.push(...(patch.rxcui ?? []));
  }

  const uniqueCas = sortedValues(cas);
  const uniqueEc = sortedValues(ec);
  const uniqueRxcui = sortedValues(rxcui);

  return {
    ...(uniiOverride !== undefined ? { unii: uniiOverride } : {}),
    ...(uniqueCas.length > 0 ? { cas: uniqueCas } : {}),
    ...(uniqueEc.length > 0 ? { ec: uniqueEc } : {}),
    ...(uniqueRxcui.length > 0 ? { rxcui: uniqueRxcui } : {}),
    ...(structId !== undefined ? { structId } : {}),
    ...(inchiKey === undefined ? {} : { inchiKey }),
    ...(cid.length === 0 ? {} : { cid: sortedNumbers(cid) }),
  };
}

/** Sorts and deduplicates source links by database order, then id. */
function sortedLinks(links: readonly SourceLink[]): SourceLink[] {
  const seen = new Set<string>();
  const uniqueLinks: SourceLink[] = [];
  for (const link of links) {
    const key = `${link.database}:${link.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueLinks.push(link);
  }
  return uniqueLinks.sort(
    (a, b) =>
      DATABASE_ORDER[a.database] - DATABASE_ORDER[b.database] ||
      a.id.localeCompare(b.id),
  );
}

/** Sorts candidate sets by database order. */
function sortedCandidates(candidates: readonly CandidateSet[]): CandidateSet[] {
  return [...candidates].sort(
    (a, b) => DATABASE_ORDER[a.database] - DATABASE_ORDER[b.database],
  );
}

/** Converts the accumulated state into the public identity graph. */
function graphOf(state: ChainState): IdentityGraph {
  const unii = chainUnii(state) ?? firstUnii(state.identifiers);
  return {
    records: state.records,
    subject: {
      ...(state.subject.name !== undefined ? { name: state.subject.name } : {}),
      ...(state.subject.inciName !== undefined
        ? { inciName: state.subject.inciName }
        : {}),
    },
    identifiers: combineIdentifiers(state.identifiers, unii),
    links: sortedLinks(state.links),
    candidates: sortedCandidates(state.candidates),
    ...(state.errors.length > 0 ? { errors: state.errors } : {}),
  };
}

/** Adds the weak DSLD and INKEEDecoder terminals. */
async function terminalCandidates(
  state: ChainState,
  cap: number,
): Promise<void> {
  const name = nonEmpty(
    state.subject.name ??
      state.subject.inciName ??
      state.input.substanceName ??
      state.input.inciName,
  );
  if (name === undefined) return;

  if (enabled(state, "dsld")) {
    throwIfAborted(state.signal);
    try {
      const groups = await state.deps.dsld.ingredientGroupsByName(
        name,
        state.signal,
      );
      if (groups.length > 0) {
        applyCandidates(
          state,
          {
            status: "candidates",
            database: "DSLD",
            matchedVia: "ingredient-name",
            reason: "name-match",
            options: groups,
          },
          cap,
        );
      }
    } catch (error) {
      rethrowIfCancelled(state, error);
      recordError(state, "DSLD", error);
    }
  }

  if (!enabled(state, "inkeedecoder")) return;
  const slug = slugGuess(name);
  if (slug.length === 0) return;
  throwIfAborted(state.signal);
  let item: ClientIngredient | null | undefined;
  try {
    item = await state.deps.inkeedecoder.getIngredient(slug, state.signal);
  } catch (error) {
    rethrowIfCancelled(state, error);
    recordError(state, "INKEEDecoder", error);
    item = undefined;
  }
  if (item === null || item === undefined) return;

  const cas = sortedValues(identifierList(item.cosing?.cas));
  const ec = sortedValues(identifierList(item.cosing?.ec));
  const knownCas = new Set(
    state.identifiers.flatMap((patch) => patch.cas ?? []),
  );
  const knownEc = new Set(state.identifiers.flatMap((patch) => patch.ec ?? []));
  const casMatch = cas.find((value) => knownCas.has(value));
  const ecMatch = ec.find((value) => knownEc.has(value));
  const matchBasis =
    casMatch !== undefined
      ? `CAS cross-check: ${casMatch}`
      : ecMatch !== undefined
        ? `EC cross-check: ${ecMatch}`
        : "slug guess";

  const ref: IngredientRef = {
    name: item.name,
    inciName: item.name,
    identifiers: {
      slug: item.slug,
      ...(cas.length > 0 ? { cas } : {}),
      ...(ec.length > 0 ? { ec } : {}),
    },
    source: {
      database: "INKEEDecoder",
      id: item.slug,
      url: nonEmpty(item.url) ?? inkeedecoderUrl(item.slug),
      retrievedAt: state.retrievedAt,
    },
    matchBasis,
  };
  applyCandidates(
    state,
    {
      status: "candidates",
      database: "INKEEDecoder",
      matchedVia: "slug",
      reason: "name-match",
      options: [ref],
    },
    cap,
  );
}

/** Runs the ingredient chain for one ingredient-level input. */
async function resolveIngredientGraph(
  input: ResolveInput,
  opts: ResolveOptions,
  signal: AbortSignal | undefined,
  deps: IdentityDeps,
  disabled: ReadonlySet<string>,
): Promise<IdentityGraph> {
  const cap = maxCandidates(opts);
  const inputUnii = nonEmpty(input.unii)?.toUpperCase();
  const state: ChainState = {
    records: [],
    input,
    deps,
    signal,
    disabled,
    retrievedAt: new Date().toISOString(),
    subject: {},
    links: [],
    candidates: [],
    identifiers: [],
    errors: [],
    openfdaUnii: undefined,
    directProbe: undefined,
    inputUnii,
    nlmRxcui: undefined,
    linked: new Set(),
    reviews: new Set(),
    failed: new Set(),
  };

  const inputIdentifiers: IngredientIdentifiers = {
    ...(input.cid === undefined ? {} : { cid: [Number(input.cid)] }),
    ...(inputUnii !== undefined ? { unii: inputUnii } : {}),
    ...(nonEmpty(input.rxcui) !== undefined
      ? { rxcui: [nonEmpty(input.rxcui) as string] }
      : {}),
    ...(nonEmpty(input.cas) !== undefined
      ? { cas: [nonEmpty(input.cas) as string] }
      : {}),
  };
  state.identifiers.push(inputIdentifiers);
  applySubject(state, input.substanceName, input.inciName);

  await runChain(state, cap);
  await terminalCandidates(state, cap);
  return graphOf(state);
}

/** Whether an input addresses a product rather than one ingredient. */
function isProductInput(input: ResolveInput): boolean {
  return (
    input.ndc !== undefined ||
    input.splSetId !== undefined ||
    input.dsldId !== undefined
  );
}

/** Directory strengths keyed by normalized ingredient name. */
function strengthsByIngredient(
  ingredients: readonly IngredientRef[],
): ReadonlyMap<string, string> {
  const strengths = new Map<string, string>();
  for (const ingredient of ingredients) {
    if (ingredient.quantity !== undefined) {
      strengths.set(ingredientKey(ingredient.name), ingredient.quantity);
    }
  }
  return strengths;
}

/** Reads one SPL label's ingredient rows, empty on any failure. */
async function splIngredients(
  setid: string,
  retrievedAt: string,
  deps: IdentityDeps,
  signal: AbortSignal | undefined,
  record: ProductRecord | null,
  errors: ResolutionError[],
): Promise<IngredientRef[]> {
  throwIfAborted(signal);
  let xml: string;
  try {
    xml = await deps.nlm.getSplXml(setid, signal);
  } catch (error) {
    if (signal?.aborted === true) throw error;
    errors.push({
      database: isConfigFailure(error) ? "config" : "DailyMed",
      message: authoredError(error, "DailyMed", "label fetch"),
    });
    return [];
  }
  const entries = parseSplIngredients(xml);
  if (entries.length === 0) return [];
  return splIngredientRefs(
    entries,
    setid,
    retrievedAt,
    strengthsByIngredient(record?.ingredients ?? []),
  );
}

/**
 * Runs one product bridge call, treating a failure as an absent answer while
 * recording it for the result.
 */
async function attempt<T>(
  work: () => Promise<T>,
  errors: ResolutionError[],
  database: DatabaseId,
  signal: AbortSignal | undefined,
): Promise<T | undefined> {
  throwIfAborted(signal);
  try {
    return await work();
  } catch (error) {
    if (signal?.aborted === true) throw error;
    errors.push({
      database: isConfigFailure(error) ? "config" : database,
      message: authoredError(error, database, "bridge call"),
    });
    return undefined;
  }
}

/** The openFDA product link for a resolved product record. */
function openFdaProductLink(
  record: ProductRecord,
  matchedVia: string,
  confidence: LinkConfidence,
): SourceLink {
  return {
    database: "openFDA",
    id: record.product.source.id,
    url: record.product.source.url,
    matchedVia,
    confidence,
  };
}

/** The openFDA application-number link, when the record carries one. */
function applicationLinks(record: ProductRecord): SourceLink[] {
  const applicationNumber =
    record.product.identifiers.applicationNumber ??
    record.details?.applicationNumber;
  if (applicationNumber === undefined) return [];
  return [
    {
      database: "openFDA",
      id: applicationNumber,
      url: applicationUrl(applicationNumber),
      matchedVia: "application-number",
      confidence: "derived",
    },
  ];
}

/** One RxNorm source link. */
function rxnormLink(rxcui: string): SourceLink {
  return {
    database: "RxNorm",
    id: rxcui,
    url: rxnormUrl(rxcui),
    matchedVia: "ndc",
    confidence: "derived",
  };
}

/** One DailyMed source link. */
function dailyMedLink(
  setid: string,
  matchedVia: string,
  confidence: LinkConfidence,
): SourceLink {
  return {
    database: "DailyMed",
    id: setid,
    url: dailyMedLabelUrl(setid),
    matchedVia,
    confidence,
  };
}

/**
 * Runs per-ingredient graphs for the first {@link MAX_INGREDIENT_GRAPHS}
 * ingredients. The returned array is a prefix of the product's ingredient
 * rows, never a claim of complete per-ingredient coverage.
 */
async function ingredientGraphs(
  ingredients: readonly IngredientRef[],
  opts: ResolveOptions,
  signal: AbortSignal | undefined,
  deps: IdentityDeps,
  disabled: ReadonlySet<string>,
): Promise<IdentityGraph[]> {
  const graphs: IdentityGraph[] = [];
  const cap = maxCandidates(opts);
  for (const ingredient of ingredients.slice(0, MAX_INGREDIENT_GRAPHS)) {
    throwIfAborted(signal);
    const unii = ingredient.identifiers.unii;
    const cas = ingredient.identifiers.cas?.[0];
    const input: ResolveInput =
      unii !== undefined
        ? { unii }
        : cas !== undefined
          ? { cas }
          : { substanceName: ingredient.name };
    graphs.push(
      await resolveIngredientGraph(
        input,
        { maxCandidates: cap },
        signal,
        deps,
        disabled,
      ),
    );
  }
  return graphs;
}

/** Resolves an NDC product: links, then its label/record ingredient rows. */
async function resolveNdcProduct(
  input: ResolveInput,
  opts: ResolveOptions,
  signal: AbortSignal | undefined,
  deps: IdentityDeps,
  state: {
    retrievedAt: string;
    links: SourceLink[];
    errors: ResolutionError[];
    disabled: ReadonlySet<string>;
  },
): Promise<IngredientRef[]> {
  const ndc = (input.ndc as string).trim();
  const openfdaEnabled = !state.disabled.has("openfda");
  const nlmEnabled = !state.disabled.has("nlm");
  const record = openfdaEnabled
    ? await attempt(
        () => deps.openfda.productByNdc(ndc, signal),
        state.errors,
        "openFDA",
        signal,
      )
    : undefined;
  if (record !== undefined && record !== null) {
    state.links.push(openFdaProductLink(record, "ndc", "direct"));
    state.links.push(...applicationLinks(record));
  }

  let setids: string[] = [];
  if (nlmEnabled) {
    // A product NDC is not an NLM lookup key; the record's package NDCs are.
    // When openFDA cannot supply them, pass the caller's NDC through so NLM
    // can decide whether it is a package spelling it understands.
    const packageNdcs = record?.product.identifiers.ndc ?? [];
    const nlmNdcs = packageNdcs.length > 0 ? sortedValues(packageNdcs) : [ndc];
    const rxcuis = sortedValues([
      ...((await attempt(
        async () => {
          const lists = await Promise.all(
            nlmNdcs.map((value) => deps.nlm.rxcuisForNdc(value, signal)),
          );
          return lists.flat();
        },
        state.errors,
        "RxNorm",
        signal,
      )) ?? []),
    ]);
    for (const rxcui of rxcuis) state.links.push(rxnormLink(rxcui));

    setids = sortedValues(
      (await attempt(
        async () => {
          const lists = await Promise.all(
            nlmNdcs.map((value) => deps.nlm.splsForNdc(value, signal)),
          );
          return lists.flat();
        },
        state.errors,
        "DailyMed",
        signal,
      )) ?? [],
    );
    for (const setid of setids) {
      state.links.push(dailyMedLink(setid, "ndc", "derived"));
    }
    const productSetid = record?.product.identifiers.splSetId;
    if (productSetid !== undefined) {
      state.links.push(dailyMedLink(productSetid, "ndc", "derived"));
    }
  }

  let ingredients = record?.ingredients ?? [];
  if (opts.includeLabelIngredients === true && nlmEnabled) {
    const setid = record?.product.identifiers.splSetId ?? setids[0];
    if (setid !== undefined) {
      const parsed = await splIngredients(
        setid,
        state.retrievedAt,
        deps,
        signal,
        record ?? null,
        state.errors,
      );
      if (parsed.length > 0) ingredients = parsed;
    }
  }
  return ingredients;
}

/** Resolves an SPL set id: the label is the product and its ingredient rows. */
async function resolveSplProduct(
  input: ResolveInput,
  signal: AbortSignal | undefined,
  deps: IdentityDeps,
  state: {
    retrievedAt: string;
    links: SourceLink[];
    errors: ResolutionError[];
    disabled: ReadonlySet<string>;
  },
): Promise<IngredientRef[]> {
  const setid = (input.splSetId as string).trim().toLowerCase();
  const openfdaEnabled = !state.disabled.has("openfda");
  const nlmEnabled = !state.disabled.has("nlm");
  if (nlmEnabled) state.links.push(dailyMedLink(setid, "splSetId", "direct"));

  const record = openfdaEnabled
    ? await attempt(
        () => deps.openfda.productBySetId(setid, signal),
        state.errors,
        "openFDA",
        signal,
      )
    : undefined;
  if (record !== undefined && record !== null) {
    state.links.push(openFdaProductLink(record, "splSetId", "derived"));
    state.links.push(...applicationLinks(record));
    if (nlmEnabled) {
      for (const rxcui of sortedValues(
        record.product.identifiers.rxcui ?? [],
      )) {
        state.links.push(rxnormLink(rxcui));
      }
    }
  }

  if (!nlmEnabled) return record?.ingredients ?? [];
  const parsed = await splIngredients(
    setid,
    state.retrievedAt,
    deps,
    signal,
    record ?? null,
    state.errors,
  );
  if (parsed.length > 0) return parsed;
  return record?.ingredients ?? [];
}

/** Resolves a DSLD label: its own ingredient rows are the product's rows. */
async function resolveDsldProduct(
  dsldId: number,
  signal: AbortSignal | undefined,
  deps: IdentityDeps,
  state: {
    retrievedAt: string;
    links: SourceLink[];
    errors: ResolutionError[];
    disabled: ReadonlySet<string>;
  },
): Promise<IngredientRef[]> {
  if (state.disabled.has("dsld")) return [];
  state.links.push({
    database: "DSLD",
    id: String(dsldId),
    url: dsldLabelUrl(dsldId),
    matchedVia: "dsldId",
    confidence: "direct",
  });
  const record = await attempt(
    () => deps.dsld.label(dsldId, signal),
    state.errors,
    "DSLD",
    signal,
  );
  if (record === undefined || record === null) return [];
  return record.ingredients;
}

/** Resolves one product-level input into links and ingredient refs. */
async function resolveProduct(
  input: ResolveInput,
  opts: ResolveOptions,
  signal: AbortSignal | undefined,
  deps: IdentityDeps,
  disabled: ReadonlySet<string>,
): Promise<ProductResolution> {
  const retrievedAt = new Date().toISOString();
  const state = {
    retrievedAt,
    links: [] as SourceLink[],
    errors: [] as ResolutionError[],
    disabled,
  };
  let ingredients: IngredientRef[];
  if (input.ndc !== undefined) {
    ingredients = await resolveNdcProduct(input, opts, signal, deps, state);
  } else if (input.splSetId !== undefined) {
    ingredients = await resolveSplProduct(input, signal, deps, state);
  } else {
    ingredients = await resolveDsldProduct(
      input.dsldId as number,
      signal,
      deps,
      state,
    );
  }

  const graphs =
    opts.resolveIngredients === true
      ? await ingredientGraphs(ingredients, opts, signal, deps, disabled)
      : undefined;

  return {
    kind: "product",
    links: sortedLinks(state.links),
    candidates: [],
    ingredients,
    ...(graphs !== undefined ? { graphs } : {}),
    ...(state.errors.length > 0 ? { errors: state.errors } : {}),
  };
}

/** Applies the caller's candidate cap, always at least one option. */
function maxCandidates(opts: ResolveOptions): number {
  const value = opts.maxCandidates;
  if (value === undefined) return DEFAULT_MAX_CANDIDATES;
  return Math.max(1, Math.floor(value));
}

/** The resolver surface returned by {@link createIdentityResolver}. */
export interface IdentityResolver {
  resolve(
    input: ResolveInput,
    opts?: ResolveOptions,
    signal?: AbortSignal,
  ): Promise<IngredientResolution | ProductResolution>;
}

/**
 * Builds a resolver over injectable bridges.
 *
 * @param deps Bridges backed by the repo adapters by default; tests inject
 *   fixture-backed bridges so no network call is made.
 * @param disabled Internal adapter ids switched off for this process (from
 *   `DRUGDATA_DISABLED_SOURCES`). Disabled sources are never queried.
 */
export function createIdentityResolver(
  deps: IdentityDeps = defaultIdentityDeps,
  disabled: readonly string[] = [],
): IdentityResolver {
  const disabledSet = new Set(disabled);
  return {
    resolve: (input, opts, signal) =>
      resolveIdentityWithDeps(input, opts, signal, deps, disabledSet),
  };
}

/** Shared implementation behind the module wrapper and the factory. */
async function resolveIdentityWithDeps(
  input: ResolveInput,
  opts: ResolveOptions = {},
  signal: AbortSignal | undefined,
  deps: IdentityDeps,
  disabled: ReadonlySet<string>,
): Promise<IngredientResolution | ProductResolution> {
  if (isProductInput(input)) {
    return await resolveProduct(input, opts, signal, deps, disabled);
  }
  return {
    kind: "ingredient",
    graph: await resolveIngredientGraph(input, opts, signal, deps, disabled),
  };
}

/** The default INKEEDecoder dep: a failed slug guess is `null`, not an error. */
export function createInkeedecoderIngredientDep(
  bridge: IkdBridges = ikdBridges,
): IdentityDeps["inkeedecoder"] {
  return {
    async getIngredient(slug, signal) {
      try {
        return await bridge.getIngredientBySlug(slug, { signal });
      } catch (error) {
        if (signal?.aborted === true) throw error;
        return null;
      }
    },
  };
}

/** The process-wide default bridges, shared by both entry points. */
export const defaultIdentityDeps: IdentityDeps = {
  pubchem: pubChemBridges,
  openfda: openfdaBridges,
  cosing: cosingBridges,
  nlm: nlmBridges,
  drugcentral: dcBridges,
  dsld: dsldBridges,
  inkeedecoder: createInkeedecoderIngredientDep(),
};

/**
 * Resolves one identifier input using the process-wide source bridges.
 *
 * @param input One ingredient or product identifier family.
 * @param opts Cost and candidate controls.
 * @param signal Optional cancellation for bridges that accept one.
 */
export async function resolveIdentity(
  input: ResolveInput,
  opts?: ResolveOptions,
  signal?: AbortSignal,
): Promise<IngredientResolution | ProductResolution> {
  return await resolveIdentityWithDeps(
    input,
    opts,
    signal,
    defaultIdentityDeps,
    new Set(),
  );
}
