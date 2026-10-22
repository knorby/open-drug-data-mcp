import type {
  IngredientGroup,
  IngredientSearchType,
  ProductGroup,
  ProductSearchType,
} from "../sources/types.js";
import type {
  DatabaseId,
  IngredientRef,
  NextStep,
  ProductRef,
} from "./schemas.js";

/**
 * Suggested follow-up calls for search results.
 *
 * A search is the entry point to the search → resolve → get loop, so every
 * result carries a short list of calls that continue it. Suggestions are
 * derived from identifiers the sources actually returned: a UNII invites a
 * cross-database resolve, a source-local id invites that database's record
 * lookup. Nothing is guessed — a ref without a usable identifier produces no
 * step.
 *
 * The list stays short on purpose: at most one step per source group (so the
 * suggestions cover the fan-out instead of repeating the first source) and at
 * most {@link MAX_NEXT_STEPS} overall, deduplicated by tool and input.
 */

const MAX_NEXT_STEPS = 3;

const GET_PRODUCT = "drugdata_get_product";
const GET_INGREDIENT = "drugdata_get_ingredient";
const RESOLVE_IDENTIFIERS = "drugdata_resolve_identifiers";

type SearchType = ProductSearchType | IngredientSearchType;
type SearchGroup = ProductGroup | IngredientGroup;

/** A product lookup reachable from one database's product refs. */
interface ProductTarget {
  tool: typeof GET_PRODUCT | typeof GET_INGREDIENT;
  source: string;
  what: string;
}

/** An ingredient lookup reachable from one database's ingredient refs. */
interface IngredientTarget {
  source: string;
  what: string;
  id: (ref: IngredientRef) => string | undefined;
}

/** The first value, or undefined for an absent or empty list. */
function first(values: readonly string[] | undefined): string | undefined {
  return values?.[0];
}

/** A numeric identifier as text, or undefined when absent. */
function decimal(value: number | undefined): string | undefined {
  return value?.toString();
}

/**
 * Product lookup per database.
 *
 * A product ref is looked up in the database that produced it, except RxNorm,
 * whose product refs are concepts: the ingredient lookup is the useful record.
 * CosIng and DrugCentral serve ingredients only, so they have no product entry.
 *
 * Every adapter sets `source.id` to that database's canonical lookup key — the
 * product NDC for openFDA, the label id for DSLD, the set id for DailyMed, the
 * slug for INKEEDecoder — so no identifier field has to be re-derived here.
 */
const PRODUCT_TARGETS: Partial<Record<DatabaseId, ProductTarget>> = {
  openFDA: {
    tool: GET_PRODUCT,
    source: "openfda",
    what: "an openFDA product record",
  },
  DailyMed: {
    tool: GET_PRODUCT,
    source: "dailymed",
    what: "a DailyMed SPL document",
  },
  DSLD: {
    tool: GET_PRODUCT,
    source: "dsld",
    what: "a DSLD supplement label",
  },
  INKEEDecoder: {
    tool: GET_PRODUCT,
    source: "inkeedecoder",
    what: "an INKEEDecoder product page",
  },
  RxNorm: {
    tool: GET_INGREDIENT,
    source: "nlm",
    what: "an RxNorm concept",
  },
};

/** Ingredient lookup per database; a found UNII is handled before this table. */
const INGREDIENT_TARGETS: Partial<Record<DatabaseId, IngredientTarget>> = {
  CosIng: {
    source: "cosing",
    what: "a CosIng inventory record",
    id: (ref) => ref.source.id,
  },
  DrugCentral: {
    source: "drugcentral",
    what: "a DrugCentral structure",
    id: (ref) => decimal(ref.identifiers.structId),
  },
  RxNorm: {
    source: "nlm",
    what: "an RxNorm concept",
    id: (ref) => first(ref.identifiers.rxcui),
  },
  INKEEDecoder: {
    source: "inkeedecoder",
    what: "an INKEEDecoder ingredient page",
    id: (ref) => ref.identifiers.slug,
  },
};

/** Product-only identifier fields, used when a ref carries no category. */
const PRODUCT_ONLY_IDENTIFIERS = [
  "ndc",
  "upc",
  "splSetId",
  "dsldId",
  "applicationNumber",
] as const;

/** Whether a ref came from a product search. */
function isProductRef(ref: ProductRef | IngredientRef): ref is ProductRef {
  if ("category" in ref) return true;
  return PRODUCT_ONLY_IDENTIFIERS.some((key) => key in ref.identifiers);
}

/** Builds the follow-up for one product ref, or null when none applies. */
function productStep(ref: ProductRef, type: SearchType): NextStep | null {
  const target = PRODUCT_TARGETS[ref.source.database];
  if (target === undefined) return null;

  return {
    tool: target.tool,
    input: {
      source: target.source,
      id: ref.source.id,
      ...(target.source === "dailymed" ? { include_label_sections: true } : {}),
    },
    why: `The ${type} search found ${target.what}; open its full record to continue the loop.`,
  };
}

/** Builds the follow-up for one ingredient ref, or null when none applies. */
function ingredientStep(ref: IngredientRef, type: SearchType): NextStep | null {
  const { unii } = ref.identifiers;
  if (unii !== undefined) {
    return {
      tool: RESOLVE_IDENTIFIERS,
      input: { unii },
      why: `The ${type} search found UNII ${unii}; resolve it across the other databases for linked records.`,
    };
  }

  const target = INGREDIENT_TARGETS[ref.source.database];
  if (target === undefined) return null;
  const id = target.id(ref);
  if (id === undefined) return null;

  return {
    tool: GET_INGREDIENT,
    input: { source: target.source, id },
    why: `The ${type} search found ${target.what}; open its full record to continue the loop.`,
  };
}

/** Chooses the follow-up for one ref of either family. */
function stepFor(
  ref: ProductRef | IngredientRef,
  type: SearchType,
): NextStep | null {
  return isProductRef(ref) ? productStep(ref, type) : ingredientStep(ref, type);
}

/**
 * Derives follow-up calls from the identifiers a search returned.
 *
 * @param type The search type, used in each step's explanation.
 * @param groups Source-grouped results from one fan-out.
 * @returns At most three unique steps, at most one per source group.
 */
export function searchNextSteps(
  type: SearchType,
  groups: readonly SearchGroup[],
): NextStep[] {
  const steps: NextStep[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    for (const item of group.items) {
      const step = stepFor(item, type);
      if (step === null) continue;

      const key = `${step.tool}:${JSON.stringify(step.input)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      steps.push(step);
      break;
    }
    if (steps.length === MAX_NEXT_STEPS) break;
  }

  return steps;
}

/**
 * Derives follow-up calls from one ingredient detail.
 *
 * Cross-database identifiers are the strongest pivots, so a UNII, RxCUI, or
 * CAS number invites the resolve tool; a structure id or slug invites the
 * database's own record lookup. A record lookup is skipped for the database
 * that already produced the detail, and the list is capped at
 * {@link MAX_NEXT_STEPS} so a rich profile stays actionable.
 */
export function ingredientDetailNextSteps(
  ingredient: IngredientRef,
): NextStep[] {
  const steps: NextStep[] = [];
  const { identifiers, source } = ingredient;
  const add = (step: NextStep): void => {
    if (steps.length === MAX_NEXT_STEPS) return;
    steps.push(step);
  };

  const unii = identifiers.unii;
  if (unii !== undefined) {
    add({
      tool: RESOLVE_IDENTIFIERS,
      input: { unii },
      why: `The ingredient carries UNII ${unii}; resolve it across the other databases for linked records.`,
    });
  }

  const rxcui = first(identifiers.rxcui);
  if (rxcui !== undefined) {
    add({
      tool: RESOLVE_IDENTIFIERS,
      input: { rxcui },
      why: `The ingredient carries RxCUI ${rxcui}; resolve it across the other databases for linked records.`,
    });
  }

  const structId = identifiers.structId;
  if (structId !== undefined && source.database !== "DrugCentral") {
    add({
      tool: GET_INGREDIENT,
      input: { source: "drugcentral", id: String(structId) },
      why: `The ingredient carries DrugCentral structure ${structId}; open its identity crosswalk and ATC classifications.`,
    });
  }

  const cas = first(identifiers.cas);
  if (cas !== undefined) {
    add({
      tool: RESOLVE_IDENTIFIERS,
      input: { cas },
      why: `The ingredient carries CAS ${cas}; resolve it across the other databases for linked records.`,
    });
  }

  const inci = ingredient.inciName;
  if (inci !== undefined) {
    add({
      tool: "drugdata_search_ingredients",
      input: { type: "inci", query: inci },
      why:
        source.database === "INKEEDecoder"
          ? `Search the INCI name "${inci}" to compare other cosmetic records and find cross-source CosIng identifiers.`
          : `Search the INCI name "${inci}" to find the cosmetic records that share it.`,
    });
  }

  const slug = identifiers.slug;
  if (slug !== undefined && source.database !== "INKEEDecoder") {
    add({
      tool: GET_INGREDIENT,
      input: { source: "inkeedecoder", id: slug },
      why: `The ingredient carries INKEEDecoder slug ${slug}; open its cosmetic ingredient page.`,
    });
  }

  return steps;
}

/** What a product detail offers as follow-up: its ref and ingredient rows. */
export interface ProductDetailSubject {
  product: ProductRef;
  ingredients: readonly IngredientRef[];
}

/**
 * Derives follow-up calls from a product detail.
 *
 * The order leads with the strongest pivot: a labeled ingredient's UNII, then
 * the same product in another database (a DailyMed label behind an openFDA
 * record), the RxNorm concept, and finally the product NDC resolution. When
 * none of those apply, an ingredient's CAS number or INKEEDecoder slug is the
 * remaining usable identifier. At most {@link MAX_NEXT_STEPS} calls are
 * returned, so a multi-ingredient label stays a short, actionable list.
 */
export function productDetailNextSteps(
  subject: ProductDetailSubject,
): NextStep[] {
  const steps: NextStep[] = [];
  const { product, ingredients } = subject;

  const add = (step: NextStep): void => {
    if (steps.length === MAX_NEXT_STEPS) return;
    steps.push(step);
  };

  const unii = ingredients.find(
    (ingredient) => ingredient.identifiers.unii !== undefined,
  )?.identifiers.unii;
  if (unii !== undefined) {
    add({
      tool: RESOLVE_IDENTIFIERS,
      input: { unii },
      why: `The product lists UNII ${unii}; resolve it across the other databases for linked records.`,
    });
  }

  const setid = product.identifiers.splSetId;
  if (setid !== undefined && product.source.database !== "DailyMed") {
    add({
      tool: GET_PRODUCT,
      input: {
        source: "dailymed",
        id: setid,
        include_label_sections: true,
      },
      why: "The product carries a DailyMed SPL set id; open the label with its usage sections for ingredient and dosing detail.",
    });
  }

  const rxcui = first(product.identifiers.rxcui);
  if (rxcui !== undefined) {
    add({
      tool: GET_INGREDIENT,
      input: { source: "nlm", id: rxcui },
      why: `The product carries RxCUI ${rxcui}; open the RxNorm concept for its identifiers and NDCs.`,
    });
  }

  const ndc = first(product.identifiers.ndc);
  if (ndc !== undefined) {
    add({
      tool: RESOLVE_IDENTIFIERS,
      input: { ndc },
      why: `Resolve NDC ${ndc} across the other databases to link this product by its package code.`,
    });
  }

  const casIngredient = ingredients.find(
    (ingredient) =>
      ingredient.identifiers.unii === undefined &&
      first(ingredient.identifiers.cas) !== undefined,
  );
  const cas = first(casIngredient?.identifiers.cas);
  if (casIngredient !== undefined && cas !== undefined) {
    add({
      tool: "drugdata_search_ingredients",
      input: { type: "cas", query: cas },
      why: `The product lists ${casIngredient.name} with CAS ${cas}; search ingredients by that number to identify it across sources.`,
    });
  }

  const slugIngredient = ingredients.find(
    (ingredient) =>
      ingredient.identifiers.unii === undefined &&
      ingredient.source.database === "INKEEDecoder" &&
      ingredient.identifiers.slug !== undefined,
  );
  const slug = slugIngredient?.identifiers.slug;
  if (slugIngredient !== undefined && slug !== undefined) {
    add({
      tool: GET_INGREDIENT,
      input: { source: "inkeedecoder", id: slug },
      why: `Open the INKEEDecoder ingredient page for ${slugIngredient.name} to continue with its CosIng identifiers.`,
    });
  }

  return steps;
}
