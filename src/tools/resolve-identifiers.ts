import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  applyCharacterLimit,
  boundStructured,
  formatJson,
  RESPONSE_FORMATS,
  truncationNote,
} from "../lib/format.js";
import { isSplSetId, isUnii, normalizeNdc } from "../lib/ids.js";
import {
  type DatabaseId,
  type GraphCoverage,
  type IngredientIdentifiers,
  type IngredientRef,
  type NextStep,
  type ResolveConfidence,
  resolveIdentifiersResultSchema,
} from "../lib/schemas.js";
import {
  type CandidateSet,
  createIdentityResolver,
  type IdentityGraph,
  type IdentityResolver,
  MAX_INGREDIENT_GRAPHS,
  type ResolveInput,
  type ResolveOptions,
  type SourceLink,
} from "../sources/identity/chain.js";
import {
  type IdentifierField,
  identifierText,
  messageError,
  nextStepsText,
  toolError,
} from "./search-support.js";

/**
 * `drugdata_resolve_identifiers` — the identity chain behind one tool.
 *
 * The chain in `sources/identity/chain.ts` owns the source steps, confidence
 * rules, and product extraction; this module owns what a host sees: the
 * exactly-one identifier contract, shape checks before any request, mapping
 * the engine's union into the closed result schema, a compact confidence
 * count, and follow-up calls derived from the bounded result.
 *
 * `include_label_ingredients` and `resolve_ingredients` are the costly
 * switches. The first parses SPL XML for ingredient UNIIs; the second runs the
 * whole chain once per discovered ingredient. Per-product graphs cover only a
 * prefix of the ingredient rows (at most 20), which the markdown states
 * explicitly rather than implying complete coverage.
 */

/** Identifier keys accepted by the tool, in the documented order. */
const IDENTIFIER_KEYS = [
  "unii",
  "ndc",
  "rxcui",
  "cas",
  "inci_name",
  "substance_name",
  "spl_setid",
  "dsld_id",
] as const;

type IdentifierKey = (typeof IDENTIFIER_KEYS)[number];

/** Text listing every accepted identifier key. */
const IDENTIFIER_LIST = IDENTIFIER_KEYS.join(", ");

/** A product NDC: labeler-product, in a 4-4, 5-3, or 5-4 layout. */
const PRODUCT_NDC = /^(?:\d{4}-\d{4}|\d{5}-\d{3}|\d{5}-\d{4})$/;

/** A CAS Registry Number in the conventional dashed spelling. */
const CAS_NUMBER = /^\d{2,7}-\d{2}-\d$/;

/** A numeric upstream identifier (RxCUI, CosIng substance id, struct id). */
const NUMERIC_ID = /^\d+$/;

/** A positive numeric DSLD label id. */
const DSLD_ID = /^\d+$/;

/** Follow-up tools this result may suggest. */
const RESOLVE_IDENTIFIERS = "drugdata_resolve_identifiers";
const GET_PRODUCT = "drugdata_get_product";
const GET_INGREDIENT = "drugdata_get_ingredient";
const SEARCH_INGREDIENTS = "drugdata_search_ingredients";

/** Follow-up calls stay short so a rich answer stays actionable. */
const MAX_NEXT_STEPS = 3;

/** Longest name the next-step tools accept. */
const MAX_NAME_LENGTH = 200;

/** Longest raw value echoed in a validation refusal. */
const MAX_PREVIEW_LENGTH = 80;

/** Identifier labels in the order the markdown shows them. */
const INGREDIENT_FIELDS: ReadonlyArray<IdentifierField<IngredientIdentifiers>> =
  [
    ["unii", "UNII"],
    ["cas", "CAS"],
    ["ec", "EC"],
    ["rxcui", "RxCUI"],
    ["structId", "structId"],
    ["cid", "CID"],
    ["inchiKey", "InChIKey"],
    ["slug", "slug"],
  ];

const DESCRIPTION =
  "Resolve one identifier across openFDA, CosIng, RxNorm, DrugCentral, DailyMed, DSLD, and INKEEDecoder. Pass exactly one of unii, ndc, rxcui, cas, inci_name, substance_name, spl_setid, or dsld_id. Ingredient identifiers return an identity graph of confident cross-source links with labeled candidate sets for ambiguity; product identifiers (ndc, spl_setid, dsld_id) return the product's cross-source links plus its ingredient rows. `include_label_ingredients` parses SPL XML for ingredient UNIIs — extra request, default false. `resolve_ingredients` runs the full resolution per ingredient — many requests on multi-ingredient products, default false — and returns graphs for a prefix of the ingredient rows, capped at 20. `max_candidates` caps the options per ambiguous source result. Results carry a compact confidence count and suggested follow-up calls. An identifier of the wrong shape is an error result naming the search tool that finds a valid one; zero matches are ordinary and in-band.";

/** The fields one identifier family may be supplied through. */
const identifierFields = {
  unii: z
    .string()
    .optional()
    .describe(
      'FDA Unique Ingredient Identifier — exactly 10 letters or digits, for example "R16CO5Y76E".',
    ),
  ndc: z
    .string()
    .optional()
    .describe(
      'National Drug Code — a 10- or 11-digit package NDC or a labeler-product NDC such as "00093-1046".',
    ),
  rxcui: z
    .string()
    .optional()
    .describe('RxNorm concept identifier — numeric, for example "1191".'),
  cas: z
    .string()
    .optional()
    .describe('CAS Registry Number in dashed form, for example "50-78-2".'),
  inci_name: z
    .string()
    .optional()
    .describe(
      "INCI (cosmetic ingredient) name; a name lookup, not an exact identifier.",
    ),
  substance_name: z
    .string()
    .optional()
    .describe(
      "Substance or ingredient name; a fuzzy name lookup when no identifier is known.",
    ),
  spl_setid: z
    .string()
    .optional()
    .describe(
      'DailyMed Structured Product Label set id — UUID-shaped, for example "a1e07d5c-2056-46f3-8737-f03ed0b4bae8".',
    ),
  dsld_id: z
    .union([z.number(), z.string()])
    .optional()
    .describe("NIH DSLD label id — a positive integer, as a number or digits."),
};

/**
 * The identifier contract, enforced in the handler.
 *
 * The registered schema keeps fields optional so a zero- or multi-identifier
 * call reaches the handler and comes back as `isError` text naming the
 * allowed keys; the SDK's input validation would otherwise turn it into an
 * opaque protocol error before the model could act on it.
 */
const identifierInputSchema = z
  .object(identifierFields)
  .superRefine((value, context) => {
    const present = presentIdentifierKeys(value);
    if (present.length !== 1) {
      context.addIssue({
        code: "custom",
        message: exactlyOneMessage(present),
      });
    }
  });

const inputSchema = z.object({
  ...identifierFields,
  include_label_ingredients: z
    .boolean()
    .default(false)
    .describe(
      "Parse SPL XML for ingredient UNIIs — extra request, default false.",
    ),
  resolve_ingredients: z
    .boolean()
    .default(false)
    .describe(
      "Runs full resolution per ingredient — many requests on multi-ingredient products, default false.",
    ),
  max_candidates: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(5)
    .describe(
      "Maximum candidate options kept per ambiguous source result, 1-10. Default 5.",
    ),
  response_format: z
    .enum(RESPONSE_FORMATS)
    .default("markdown")
    .describe(
      "Text format: 'markdown' for a readable identity report, or 'json' for the structured result serialized as JSON.",
    ),
});

type ResolveToolInput = z.infer<typeof inputSchema>;

/** The result a tool call returns, before it is bounded. */
type ResolveOutput = z.infer<typeof resolveIdentifiersResultSchema>;

/** A prepared engine call, or the model-facing reason it is unusable. */
type PreparedInput =
  | {
      ok: true;
      input: ResolveInput;
      opts: ResolveOptions;
      query: string;
    }
  | { ok: false; error: string };

/** The identifier keys a call actually supplied. */
function presentIdentifierKeys(
  value: Partial<Record<IdentifierKey, unknown>>,
): IdentifierKey[] {
  return IDENTIFIER_KEYS.filter((key) => value[key] !== undefined);
}

/** One exactly-one refusal naming every allowed key. */
function exactlyOneMessage(present: readonly IdentifierKey[]): string {
  const detail =
    present.length === 0
      ? "None were provided."
      : `received ${present.join(", ")}.`;
  return `Error: ${RESOLVE_IDENTIFIERS} — pass exactly one identifier: ${IDENTIFIER_LIST}. ${detail} Resolve each identifier in a separate call.`;
}

/** A bounded preview of a caller-supplied value. */
function preview(value: unknown): string {
  const text = String(value);
  return text.length > MAX_PREVIEW_LENGTH
    ? `${text.slice(0, MAX_PREVIEW_LENGTH)}…`
    : text;
}

/** A shape refusal naming the expected spelling and where to find a good one. */
function invalidIdentifier(
  key: IdentifierKey,
  expected: string,
  received: unknown,
  advice: string,
): { ok: false; error: string } {
  return {
    ok: false,
    error: `Error: ${RESOLVE_IDENTIFIERS} — "${key}" ${expected}. Received "${preview(received)}". ${advice}`,
  };
}

/** Advice for a malformed exact identifier. */
const IDENTIFIER_ADVICE: Readonly<Record<IdentifierKey, string>> = {
  unii: 'Use drugdata_search_ingredients with type "unii" to find a valid UNII, or pass inci_name or substance_name for a name lookup.',
  ndc: 'Use drugdata_search_products with type "ndc" to find a valid NDC, then pass it back unchanged.',
  rxcui:
    'Use drugdata_search_ingredients with type "rxcui" to find a valid RxCUI.',
  cas: 'Use drugdata_search_ingredients with type "cas" to find a valid CAS number, or check the dashed spelling.',
  inci_name:
    "Pass a non-empty name up to 200 characters, or a specific identifier (unii, cas, rxcui) for an exact match.",
  substance_name:
    "Pass a non-empty name up to 200 characters, or a specific identifier (unii, cas, rxcui) for an exact match.",
  spl_setid:
    "Pass the UUID-shaped SPL set id from a DailyMed record, or use drugdata_search_products to find one.",
  dsld_id:
    "Use drugdata_search_products to find a DSLD label id, then pass that positive integer.",
};

/**
 * Validates and normalizes one caller-supplied identifier.
 *
 * Shape checks run before the chain, so a package NDC handed in as a UNII or a
 * malformed CAS number fails with the search tool that finds the right value
 * instead of an empty upstream answer.
 */
function prepareResolveInput(input: ResolveToolInput): PreparedInput {
  const key = IDENTIFIER_KEYS.find(
    (candidate) => input[candidate] !== undefined,
  ) as IdentifierKey;

  const opts: ResolveOptions = {
    includeLabelIngredients: input.include_label_ingredients,
    resolveIngredients: input.resolve_ingredients,
    maxCandidates: input.max_candidates,
  };

  switch (key) {
    case "unii": {
      const value = String(input.unii).trim();
      if (!isUnii(value)) {
        return invalidIdentifier(
          key,
          "expects a UNII of exactly 10 letters or digits",
          input.unii,
          IDENTIFIER_ADVICE.unii,
        );
      }
      const unii = value.toUpperCase();
      return { ok: true, input: { unii }, opts, query: `unii ${unii}` };
    }
    case "ndc": {
      const value = String(input.ndc).trim();
      const normalized = normalizeNdc(value);
      const productNdc = PRODUCT_NDC.test(value) ? value : undefined;
      const ndc = normalized ?? productNdc;
      if (ndc === undefined) {
        return invalidIdentifier(
          key,
          "expects a 10- or 11-digit NDC, dashed or plain",
          input.ndc,
          IDENTIFIER_ADVICE.ndc,
        );
      }
      return { ok: true, input: { ndc }, opts, query: `ndc ${ndc}` };
    }
    case "rxcui": {
      const value = String(input.rxcui).trim();
      if (
        !NUMERIC_ID.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        Number(value) <= 0
      ) {
        return invalidIdentifier(
          key,
          "expects a numeric RxCUI",
          input.rxcui,
          IDENTIFIER_ADVICE.rxcui,
        );
      }
      return {
        ok: true,
        input: { rxcui: value },
        opts,
        query: `rxcui ${value}`,
      };
    }
    case "cas": {
      const value = String(input.cas).trim();
      if (!CAS_NUMBER.test(value)) {
        return invalidIdentifier(
          key,
          "expects a dashed CAS Registry Number such as 50-78-2",
          input.cas,
          IDENTIFIER_ADVICE.cas,
        );
      }
      return { ok: true, input: { cas: value }, opts, query: `cas ${value}` };
    }
    case "inci_name": {
      const value = String(input.inci_name).trim();
      if (value.length === 0 || value.length > 200) {
        return invalidIdentifier(
          key,
          "expects a non-empty name up to 200 characters",
          input.inci_name,
          IDENTIFIER_ADVICE.inci_name,
        );
      }
      return {
        ok: true,
        input: { inciName: value },
        opts,
        query: `inci_name ${value}`,
      };
    }
    case "substance_name": {
      const value = String(input.substance_name).trim();
      if (value.length === 0 || value.length > 200) {
        return invalidIdentifier(
          key,
          "expects a non-empty name up to 200 characters",
          input.substance_name,
          IDENTIFIER_ADVICE.substance_name,
        );
      }
      return {
        ok: true,
        input: { substanceName: value },
        opts,
        query: `substance_name ${value}`,
      };
    }
    case "spl_setid": {
      const value = String(input.spl_setid).trim();
      if (!isSplSetId(value)) {
        return invalidIdentifier(
          key,
          "expects a DailyMed SPL set id (UUID-shaped)",
          input.spl_setid,
          IDENTIFIER_ADVICE.spl_setid,
        );
      }
      const splSetId = value.toLowerCase();
      return {
        ok: true,
        input: { splSetId },
        opts,
        query: `spl_setid ${splSetId}`,
      };
    }
    case "dsld_id": {
      const value = Number(input.dsld_id);
      if (!Number.isSafeInteger(value) || value <= 0) {
        return invalidIdentifier(
          key,
          "expects a positive integer DSLD label id",
          input.dsld_id,
          IDENTIFIER_ADVICE.dsld_id,
        );
      }
      return {
        ok: true,
        input: { dsldId: value },
        opts,
        query: `dsld_id ${value}`,
      };
    }
  }
}

/** One follow-up target for a source link. */
interface LinkTarget {
  tool: string;
  source: string;
  id: (link: SourceLink) => string | undefined;
}

/** An openFDA product id: a product NDC or an SPL set id. */
function openFdaProductId(link: SourceLink): string | undefined {
  if (isSplSetId(link.id)) return link.id.toLowerCase();
  return PRODUCT_NDC.test(link.id) ? link.id : undefined;
}

/** A DailyMed set id, lowercased. */
function splSetIdOf(link: SourceLink): string | undefined {
  return isSplSetId(link.id) ? link.id.toLowerCase() : undefined;
}

/** A positive numeric identifier. */
function numericId(link: SourceLink): string | undefined {
  return NUMERIC_ID.test(link.id) ? link.id : undefined;
}

/** A positive numeric DSLD label id. */
function dsldIdOf(link: SourceLink): string | undefined {
  return DSLD_ID.test(link.id) && Number(link.id) > 0 ? link.id : undefined;
}

/** An openFDA ingredient id: a UNII or a dashed CAS number. */
function openFdaIngredientId(link: SourceLink): string | undefined {
  if (isUnii(link.id)) return link.id.toUpperCase();
  return CAS_NUMBER.test(link.id) ? link.id : undefined;
}

/** An INKEEDecoder slug is already the link id. */
function slugOf(link: SourceLink): string | undefined {
  return link.id;
}

/** Ingredient-to-product lookups, in the database vocabulary. */
const PRODUCT_LINK_TARGETS: Partial<Record<DatabaseId, LinkTarget>> = {
  openFDA: {
    tool: GET_PRODUCT,
    source: "openfda",
    id: openFdaProductId,
  },
  DailyMed: {
    tool: GET_PRODUCT,
    source: "dailymed",
    id: splSetIdOf,
  },
  DSLD: {
    tool: GET_PRODUCT,
    source: "dsld",
    id: dsldIdOf,
  },
  RxNorm: {
    tool: GET_INGREDIENT,
    source: "nlm",
    id: numericId,
  },
};

/** Product-to-ingredient lookups, in the database vocabulary. */
const INGREDIENT_LINK_TARGETS: Partial<Record<DatabaseId, LinkTarget>> = {
  openFDA: {
    tool: GET_INGREDIENT,
    source: "openfda",
    id: openFdaIngredientId,
  },
  CosIng: {
    tool: GET_INGREDIENT,
    source: "cosing",
    id: numericId,
  },
  RxNorm: {
    tool: GET_INGREDIENT,
    source: "nlm",
    id: numericId,
  },
  DrugCentral: {
    tool: GET_INGREDIENT,
    source: "drugcentral",
    id: numericId,
  },
  DailyMed: {
    tool: GET_PRODUCT,
    source: "dailymed",
    id: splSetIdOf,
  },
  DSLD: {
    tool: GET_PRODUCT,
    source: "dsld",
    id: dsldIdOf,
  },
  INKEEDecoder: {
    tool: GET_INGREDIENT,
    source: "inkeedecoder",
    id: slugOf,
  },
};

/** The follow-up for one confident source link, or null when unusable. */
function linkStep(
  link: SourceLink,
  kind: "ingredient" | "product",
): NextStep | null {
  const table =
    kind === "product" ? PRODUCT_LINK_TARGETS : INGREDIENT_LINK_TARGETS;
  const target = table[link.database];
  if (target === undefined) return null;
  const id = target.id(link);
  if (id === undefined) return null;
  return {
    tool: target.tool,
    input: { source: target.source, id },
    why: `The identity graph links ${link.database} record ${link.id}; open its full record to continue the loop.`,
  };
}

/** The resolve-by-UNII follow-up for a product ingredient row. */
function uniiStep(unii: string): NextStep {
  return {
    tool: RESOLVE_IDENTIFIERS,
    input: { unii },
    why: `The product lists UNII ${unii}; resolve it across the other databases for linked records.`,
  };
}

/** A trimmed name the follow-up tools will accept, or undefined. */
function usableName(value: string | undefined): string | undefined {
  const name = value?.trim();
  if (name === undefined || name.length === 0) return undefined;
  return name.slice(0, MAX_NAME_LENGTH);
}

/** The resolve-by-name follow-up for a product ingredient without a UNII. */
function ingredientStep(ingredient: IngredientRef): NextStep | null {
  const inciName = usableName(ingredient.inciName);
  if (inciName !== undefined) {
    return {
      tool: RESOLVE_IDENTIFIERS,
      input: { inci_name: inciName },
      why: `The product lists ${ingredient.name} with INCI ${inciName}; resolve the INCI name across the other databases.`,
    };
  }
  const name = usableName(ingredient.name);
  if (name === undefined) return null;
  return {
    tool: RESOLVE_IDENTIFIERS,
    input: { substance_name: name },
    why: `The product lists ${name}; resolve it by name to identify the ingredient across databases.`,
  };
}

/** The search follow-up for one ambiguous candidate set. */
function candidateStep(set: CandidateSet): NextStep | null {
  const option = set.options[0];
  if (option === undefined) return null;
  const query = usableName(option.name);
  if (query === undefined) return null;
  return {
    tool: SEARCH_INGREDIENTS,
    input: { type: "name", query },
    why: `Candidate from ${set.database} matched by ${set.matchedVia} (${set.reason}); search the name to identify it across sources.`,
  };
}

/**
 * Derives follow-up calls from the bounded result.
 *
 * The strongest pivot leads: a product ingredient's UNII, then each confident
 * source link's own record, then a name resolution for an ingredient without a
 * UNII, and finally the first option of each ambiguous candidate set. The list
 * is capped and deduplicated by tool and input.
 */
export function resolveNextSteps(result: ResolveOutput): NextStep[] {
  const steps: NextStep[] = [];
  const seen = new Set<string>();

  const add = (step: NextStep | null): void => {
    if (step === null || steps.length >= MAX_NEXT_STEPS) return;
    const key = `${step.tool}:${JSON.stringify(step.input)}`;
    if (seen.has(key)) return;
    seen.add(key);
    steps.push(step);
  };

  if (result.kind === "product") {
    const unii = result.ingredients.find(
      (ingredient) => ingredient.identifiers.unii !== undefined,
    )?.identifiers.unii;
    if (unii !== undefined) add(uniiStep(unii));
  }

  const links = result.kind === "product" ? result.links : result.graph.links;
  for (const link of links) add(linkStep(link, result.kind));

  if (result.kind === "product") {
    const named = result.ingredients.find(
      (ingredient) => ingredient.identifiers.unii === undefined,
    );
    if (named !== undefined) add(ingredientStep(named));
  }

  const candidates =
    result.kind === "product" ? result.candidates : result.graph.candidates;
  for (const set of candidates) add(candidateStep(set));

  return steps;
}

/** Every graph in a result, including a product's per-ingredient prefix. */
function graphsOf(result: ResolveOutput): readonly IdentityGraph[] {
  if (result.kind === "ingredient") return [result.graph];
  return result.graphs ?? [];
}

/** A compact count of the links and candidate sets actually emitted. */
export function confidenceOf(result: ResolveOutput): ResolveConfidence {
  const graphs = graphsOf(result);
  const links = [
    ...(result.kind === "product" ? result.links : []),
    ...graphs.flatMap((graph) => graph.links),
  ];
  const candidates = [
    ...(result.kind === "product" ? result.candidates : []),
    ...graphs.flatMap((graph) => graph.candidates),
  ];
  return {
    directLinks: links.filter((link) => link.confidence === "direct").length,
    derivedLinks: links.filter((link) => link.confidence === "derived").length,
    candidateSets: candidates.length,
  };
}

/**
 * Adds graph coverage to a product result that carries graphs.
 *
 * Recomputed after every bounding pass, so the counts describe the graphs a
 * host actually receives rather than the pre-bounding prefix. The cap comes
 * from the chain's own constant.
 */
function withGraphCoverage(value: ResolveOutput): ResolveOutput {
  if (value.kind !== "product" || value.graphs === undefined) return value;
  return {
    ...value,
    graphCoverage: {
      included: value.graphs.length,
      total: value.ingredients.length,
      cap: MAX_INGREDIENT_GRAPHS,
      capped: value.ingredients.length > value.graphs.length,
    },
  };
}

/** A database-ordered list of links as markdown bullets. */
function linkBlocks(
  links: readonly SourceLink[],
  title: string,
  empty: string,
  level: string,
): string[] {
  if (links.length === 0) return [`${level} ${title} (0)`, `- ${empty}`];
  return [
    `${level} ${title} (${links.length})`,
    ...links.map(
      (link) =>
        `- ${link.database} \`${link.id}\` — matched via ${link.matchedVia} (${link.confidence}) — ${link.url}`,
    ),
  ];
}

/** Candidate sets as markdown, one heading per ambiguous source. */
function candidateBlocks(
  candidates: readonly CandidateSet[],
  level: string,
): string[] {
  if (candidates.length === 0) {
    return [
      `${level} Candidates (0)`,
      "- No ambiguous candidates were found for this subject.",
    ];
  }
  return [
    `${level} Candidates (${candidates.length})`,
    ...candidates.flatMap((set) => [
      `${level}# ${set.database} — matched via ${set.matchedVia} (${set.reason})`,
      ...set.options.map((option) => {
        const identifiers = identifierText(
          option.identifiers,
          INGREDIENT_FIELDS,
        );
        return `- ${option.name}${identifiers === undefined ? "" : ` · ${identifiers}`} — ${option.source.url}`;
      }),
    ]),
  ];
}

/** The common identity-graph body used by both result kinds. */
function graphBlocks(
  graph: IdentityGraph,
  title: string,
  level: string,
): string[] {
  const inci =
    graph.subject.inciName === undefined
      ? []
      : [`- INCI: ${graph.subject.inciName}`];
  const identifiers = identifierText(graph.identifiers, INGREDIENT_FIELDS);
  return [
    title,
    ...inci,
    ...(identifiers === undefined ? [] : [`- Identifiers: ${identifiers}`]),
    ...linkBlocks(
      graph.links,
      "Links",
      "No confident cross-source links were found.",
      level,
    ),
    ...candidateBlocks(graph.candidates, level),
  ];
}

/** One ingredient row as a markdown bullet. */
function ingredientLine(ingredient: IngredientRef): string {
  const identifiers = identifierText(ingredient.identifiers, INGREDIENT_FIELDS);
  const details = [
    `**${ingredient.name}**`,
    ...(ingredient.inciName === undefined
      ? []
      : [`INCI: ${ingredient.inciName}`]),
    ...(ingredient.role === undefined ? [] : [`role: ${ingredient.role}`]),
    ...(ingredient.quantity === undefined
      ? []
      : [`quantity: ${ingredient.quantity}`]),
    ...(ingredient.form === undefined ? [] : [`form: ${ingredient.form}`]),
    ...(identifiers === undefined ? [] : [identifiers]),
  ];
  return `- ${details.join(" · ")}`;
}

/** The per-ingredient graph section, including coverage counts. */
function graphSection(
  graphs: readonly IdentityGraph[],
  coverage: GraphCoverage,
): string[] {
  return [
    `## Per-ingredient graphs (${coverage.included} of ${coverage.total})`,
    ...(graphs.length === 0
      ? ["- No per-ingredient graphs were returned."]
      : []),
    ...graphs.flatMap((graph) =>
      graphBlocks(
        graph,
        `### ${graph.subject.name ?? graph.subject.inciName ?? "Unknown subject"}`,
        "####",
      ),
    ),
  ];
}

/** The prefix disclosure shown when graph coverage is partial. */
function graphCoverageNote(coverage: GraphCoverage): string[] {
  if (!coverage.capped) return [];
  return [
    `_Graphs cover only the first ${coverage.included} of ${coverage.total} ingredient rows: the chain caps per-call graphs at ${coverage.cap}, and the response limit can reduce that further. Resolve the remaining ingredients individually with ${RESOLVE_IDENTIFIERS}._`,
  ];
}

/** Renders one identity resolution as markdown. */
function renderMarkdown(
  value: ResolveOutput,
  query: string,
  truncated: boolean,
): string {
  const title =
    value.kind === "ingredient"
      ? `Resolved identity — ${query}`
      : `Resolved product — ${query}`;
  const graphSectionLines =
    value.kind === "ingredient"
      ? graphBlocks(
          value.graph,
          `## Identity — ${value.graph.subject.name ?? value.graph.subject.inciName ?? "Unknown subject"}`,
          "##",
        )
      : [
          linkBlocks(
            value.links,
            "Product links",
            "No confident product links were found.",
            "##",
          ),
          [
            `## Ingredients (${value.ingredients.length})`,
            ...(value.ingredients.length === 0
              ? ["- No ingredient rows were found on this product."]
              : value.ingredients.map(ingredientLine)),
          ],
          value.graphs === undefined
            ? [
                "## Per-ingredient graphs (not requested)",
                "- Set `resolve_ingredients: true` to run the full chain for each ingredient. That is many requests on multi-ingredient products.",
              ]
            : [
                ...graphSection(
                  value.graphs,
                  value.graphCoverage as GraphCoverage,
                ),
                ...graphCoverageNote(value.graphCoverage as GraphCoverage),
              ],
          candidateBlocks(value.candidates, "##"),
        ].flat();
  const steps = nextStepsText(value.nextSteps);
  const blocks = [
    title,
    ...graphSectionLines,
    [
      "## Confidence",
      `- ${value.confidence.directLinks} direct · ${value.confidence.derivedLinks} derived · ${value.confidence.candidateSets} candidate sets`,
    ].join("\n"),
    ...(steps === undefined ? [] : [steps]),
  ];
  return `${blocks.join("\n\n")}${truncated ? truncationNote() : ""}`;
}

/** Registers the `drugdata_resolve_identifiers` tool. */
export function registerResolveIdentifiersTool(
  server: McpServer,
  resolver: IdentityResolver = createIdentityResolver(),
): void {
  server.registerTool(
    RESOLVE_IDENTIFIERS,
    {
      title: "Resolve one drug identifier across open data sources",
      description: DESCRIPTION,
      inputSchema,
      outputSchema: resolveIdentifiersResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (request: ResolveToolInput) => {
      try {
        const checked = identifierInputSchema.safeParse(request);
        if (!checked.success) {
          return messageError(
            checked.error.issues.map((issue) => issue.message).join(" "),
          );
        }

        const prepared = prepareResolveInput(request);
        if (!prepared.ok) return messageError(prepared.error);

        const resolution = await resolver.resolve(
          prepared.input,
          prepared.opts,
        );
        const skeleton = withGraphCoverage(
          resolveIdentifiersResultSchema.parse({
            ...resolution,
            nextSteps: [],
            confidence: {
              directLinks: 0,
              derivedLinks: 0,
              candidateSets: 0,
            },
          }),
        );

        // Bound first, then derive follow-ups from what the host will actually
        // see, so a dropped link cannot leave a step pointing at missing data.
        const bounded = boundStructured(skeleton);
        const boundedWithCoverage = withGraphCoverage(bounded.value);
        const withSteps = resolveIdentifiersResultSchema.parse({
          ...boundedWithCoverage,
          nextSteps: resolveNextSteps(boundedWithCoverage),
          confidence: confidenceOf(boundedWithCoverage),
        });
        const final = boundStructured(withSteps);
        const finalWithCoverage = withGraphCoverage(final.value);
        const value = resolveIdentifiersResultSchema.parse({
          ...finalWithCoverage,
          confidence: confidenceOf(finalWithCoverage),
        });

        if (request.response_format === "json") {
          return {
            content: [{ type: "text" as const, text: formatJson(value) }],
            structuredContent: value,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: applyCharacterLimit(
                renderMarkdown(
                  value,
                  prepared.query,
                  bounded.truncated || final.truncated,
                ),
              ),
            },
          ],
          structuredContent: value,
        };
      } catch (error) {
        return toolError(error, "the identifier resolution");
      }
    },
  );
}
