import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  applyCharacterLimit,
  boundStructured,
  formatJson,
  morePagesNote,
  RESPONSE_FORMATS,
  truncationNote,
} from "../lib/format.js";
import { isSplSetId, normalizeNdc, normalizeSlug } from "../lib/ids.js";
import {
  type ProductDetailSubject,
  productDetailNextSteps,
} from "../lib/next-steps.js";
import {
  type DatabaseId,
  ingredientRefSchema,
  labelSectionsSchema,
  type ProductDetails,
  type ProductIdentifiers,
  productDetailSchema,
  productDetailsSchema,
  productRefSchema,
} from "../lib/schemas.js";
import { dailyMedLabelUrl } from "../sources/identity/spl-ingredients.js";
import type { Registry } from "../sources/types.js";
import {
  type IdentifierField,
  identifierText,
  messageError,
  nextStepsText,
  resolveRegistry,
  toolError,
} from "./search-support.js";

/**
 * `drugdata_get_product` — one product record from the database that owns it.
 *
 * The registry routes the lookup, so this module owns only the parts that are
 * tool-level: rejecting identifiers that cannot belong to the named database,
 * normalizing the ones that can, validating the adapter's record into the
 * closed product-detail schema, deriving follow-up calls, and rendering.
 *
 * `include_label_sections` is the costly switch. DailyMed SPL usage sections
 * (dosage, directions, patient guidance) are large, so they are extracted only
 * when asked for; the false path never runs the section parser. Ingredient
 * rows are included by default and can be turned off with
 * `include_ingredients`. `page` pages both collections one page at a time.
 */

/** Databases that can answer a product lookup, in the tool's spelling. */
export const PRODUCT_SOURCES = [
  "openfda",
  "dsld",
  "dailymed",
  "inkeedecoder",
] as const;

/** Databases that can answer a product lookup. */
export type ProductSource = (typeof PRODUCT_SOURCES)[number];

/** The registry's database label for each tool source value. */
const SOURCE_DATABASES: Readonly<Record<ProductSource, DatabaseId>> = {
  openfda: "openFDA",
  dsld: "DSLD",
  dailymed: "DailyMed",
  inkeedecoder: "INKEEDecoder",
};

/** Ingredient rows returned per page. */
const INGREDIENT_PAGE_SIZE = 25;

/** Label sections returned per page. */
const SECTION_PAGE_SIZE = 10;

/** An openFDA NDC directory product id (labeler-product, no package segment). */
const OPENFDA_PRODUCT_NDC = /^\d{4,5}-\d{3,4}$/;

/** A DSLD label id is a positive safe integer. */
const DSLD_ID = /^\d+$/;

const DESCRIPTION =
  "Fetch one product record from openFDA, DSLD, DailyMed, or INKEEDecoder. The `id` is the database's own key: a product NDC (openFDA), a numeric label id (DSLD), an SPL set id (DailyMed), or a product slug/URL (INKEEDecoder). The result carries the unified product ref, source-specific details, ingredient rows (UNIIs, roles, quantities), links, and suggested follow-up calls. `include_ingredients` is true by default; `include_label_sections` extracts DailyMed SPL usage sections — these are large and default false. `page` pages the ingredient and label-section collections one page at a time and re-fetches the record; it never walks pages automatically. A malformed id is an error result naming the search tool that finds a valid one; an upstream miss is an error result, not an empty product.";

const inputSchema = z.object({
  source: z
    .enum(PRODUCT_SOURCES, {
      error: `source must be one of: ${PRODUCT_SOURCES.join(", ")}.`,
    })
    .describe(
      "Upstream database that owns the record: 'openfda', 'dsld', 'dailymed', or 'inkeedecoder'.",
    ),
  id: z
    .string()
    .trim()
    .max(300)
    .describe(
      "The database's own identifier: product NDC (openfda), numeric label id (dsld), SPL set id (dailymed), or slug/URL (inkeedecoder).",
    ),
  include_label_sections: z
    .boolean()
    .default(false)
    .describe(
      "Extract DailyMed SPL usage sections (dosage, directions, patient guidance). Large — default false. Applies to dailymed products; false omits the sections and does not run the section parser.",
    ),
  include_ingredients: z
    .boolean()
    .default(true)
    .describe(
      "Include the product's ingredient rows with UNIIs, roles, and quantities. Default true.",
    ),
  page: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe(
      "Page number for ingredient and label-section collections, starting at 1. One page per call; the record is re-fetched and the tool never walks pages automatically.",
    ),
  response_format: z
    .enum(RESPONSE_FORMATS)
    .default("markdown")
    .describe(
      "Text format: 'markdown' for a readable record, or 'json' for the structured result serialized as JSON.",
    ),
});

type GetProductInput = z.infer<typeof inputSchema>;

/**
 * The record shape adapters return. Unknown top-level fields are stripped by
 * this closed object, and `ingredients` defaults empty for sources that have no
 * rows.
 */
const sourceRecordSchema = z.object({
  product: productRefSchema,
  ingredients: z.array(ingredientRefSchema).default([]),
  details: z.unknown().optional(),
  summary: z.string().optional(),
  labelIngredientsIncluded: z.boolean().optional(),
  labelSections: labelSectionsSchema.optional(),
});

type SourceRecord = z.infer<typeof sourceRecordSchema>;

/** A normalized lookup id, or the model-facing reason it is unusable. */
type PreparedId = { ok: true; id: string } | { ok: false; error: string };

/** Rejects an id with advice naming the search tool that finds a valid one. */
function invalidId(
  source: string,
  received: string,
  expected: string,
): PreparedId {
  return {
    ok: false,
    error: `Error: drugdata_get_product — source "${source}" ${expected}. Received "${received}". Use drugdata_search_products (product ids) or drugdata_search_ingredients (ingredient ids) to find a valid identifier, then pass it back unchanged.`,
  };
}

/**
 * Validates and normalizes a caller-supplied id for its database.
 *
 * Shape checks happen before any request, so a package-style value or a URL
 * pasted into the wrong source fails with the search tool that would find the
 * right record instead of an upstream 404.
 */
export function prepareProductId(
  source: ProductSource,
  rawId: string,
): PreparedId {
  const id = rawId.trim();
  if (id.length === 0) {
    return invalidId(source, rawId, "expects a non-empty identifier");
  }

  switch (source) {
    case "openfda": {
      if (isSplSetId(id)) return { ok: true, id: id.toLowerCase() };
      if (OPENFDA_PRODUCT_NDC.test(id)) return { ok: true, id };
      const ndc = normalizeNdc(id);
      return ndc === null
        ? invalidId(
            source,
            id,
            'expects a product NDC such as "00093-1046" or a valid 10/11-digit NDC',
          )
        : { ok: true, id: ndc };
    }
    case "dailymed":
      return isSplSetId(id)
        ? { ok: true, id: id.toLowerCase() }
        : invalidId(source, id, "expects a DailyMed SPL set id (UUID-shaped)");
    case "dsld": {
      const numeric = Number(id);
      return DSLD_ID.test(id) && Number.isSafeInteger(numeric) && numeric > 0
        ? { ok: true, id: String(numeric) }
        : invalidId(source, id, "expects a positive numeric DSLD label id");
    }
    case "inkeedecoder": {
      try {
        return { ok: true, id: normalizeSlug(id) };
      } catch (error) {
        // normalizeSlug is the only thrower here and always throws Error.
        const reason = (error as Error).message;
        return {
          ok: false,
          error: `Error: drugdata_get_product — ${reason} Use drugdata_search_products to find an INKEEDecoder product slug, then pass it unchanged.`,
        };
      }
    }
  }
}

/** Identifier labels in the order the markdown text shows them. */
const IDENTIFIER_FIELDS: ReadonlyArray<IdentifierField<ProductIdentifiers>> = [
  ["ndc", "NDC"],
  ["upc", "UPC"],
  ["rxcui", "RxCUI"],
  ["splSetId", "SPL set id"],
  ["dsldId", "DSLD id"],
  ["applicationNumber", "Application"],
  ["slug", "slug"],
];

/** Reads a non-blank string field from a parsed detail object. */
function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

/** Reads a string list field from a parsed detail object, dropping blanks. */
function stringListField(
  record: Record<string, unknown>,
  key: string,
): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
}

/** Adds a `Label: value` part when a value is present. */
function pushPart(
  parts: string[],
  value: string | undefined,
  label?: string,
): void {
  if (value === undefined) return;
  parts.push(label === undefined ? value : `${label}: ${value}`);
}

/**
 * A source-faithful overview built from the adapter's detail fields.
 *
 * Product prose from a label is explicitly labeled verbatim; values that are
 * just identifiers or classifications are shown as the source states them.
 */
function detailSummary(
  source: ProductSource,
  details: ProductDetails,
  fallback: string | undefined,
): string | undefined {
  const record = details as Record<string, unknown>;
  const parts: string[] = [];

  if (source === "openfda") {
    pushPart(parts, stringField(record, "labeler"), "Labeler");
    pushPart(
      parts,
      stringField(record, "marketingCategory"),
      "Marketing category",
    );
    pushPart(parts, stringField(record, "productType"), "Product type");
    pushPart(parts, stringField(record, "applicationNumber"), "Application");
    const effectiveTime = stringField(record, "effectiveTime");
    if (effectiveTime !== undefined) {
      parts.push(`Label effective ${effectiveTime}`);
    }
    const version = stringField(record, "version");
    if (version !== undefined) parts.push(`Label version ${version}`);
  } else if (source === "dailymed") {
    const version = stringField(record, "version");
    if (version !== undefined) parts.push(`SPL version ${version}`);
    const effectiveTime = stringField(record, "effectiveTime");
    if (effectiveTime !== undefined) parts.push(`effective ${effectiveTime}`);
    pushPart(parts, stringField(record, "dosageForm"));
    pushPart(parts, stringField(record, "labeler"), "Labeler");
  } else if (source === "dsld") {
    pushPart(parts, stringField(record, "productType"));
    const offMarket = record.offMarket;
    if (typeof offMarket === "boolean") {
      parts.push(offMarket ? "Off market" : "On market");
    }
    const netContents = stringListField(record, "netContents");
    if (netContents.length > 0) {
      parts.push(`Net contents: ${netContents.join(", ")}`);
    }
    const claims = stringListField(record, "claims");
    if (claims.length > 0) {
      parts.push(`Label claims (verbatim): ${claims.join(", ")}`);
    }
    const targetGroups = stringListField(record, "targetGroups");
    if (targetGroups.length > 0) {
      parts.push(`Target groups: ${targetGroups.join(", ")}`);
    }
    pushPart(parts, stringField(record, "entryDate"), "Entered");
  } else {
    const description = stringField(record, "description");
    if (description !== undefined) parts.push(`Description: ${description}`);
    const hashtags = stringListField(record, "hashtags");
    if (hashtags.length > 0) {
      parts.push(`Claims: ${hashtags.join(", ")}`);
    }
    const uploadedBy = stringField(record, "uploadedBy");
    const uploadedAt = stringField(record, "uploadedAt");
    if (uploadedBy !== undefined || uploadedAt !== undefined) {
      parts.push(
        `Uploaded${uploadedBy === undefined ? "" : ` by ${uploadedBy}`}${uploadedAt === undefined ? "" : ` on ${uploadedAt}`}`,
      );
    }
    pushPart(parts, stringField(record, "updatedAt"), "Updated");
  }

  return parts.length > 0 ? parts.join(" · ") : fallback;
}

/** One page of a defined collection. */
function pageSlice<T>(
  items: readonly T[],
  page: number,
  pageSize: number,
): T[] {
  return items.slice((page - 1) * pageSize, page * pageSize);
}

/** One page of a collection, or undefined when the collection is absent. */
function pageOf<T>(
  items: readonly T[] | undefined,
  page: number,
  pageSize: number,
): T[] | undefined {
  if (items === undefined) return undefined;
  return pageSlice(items, page, pageSize);
}

/** Whether a collection has another page after `page`. */
function hasMoreOf<T>(
  items: readonly T[] | undefined,
  page: number,
  pageSize: number,
): boolean {
  return items !== undefined && items.length > page * pageSize;
}

/** Deep links for a product: its own record plus related database records. */
function productLinks(product: SourceRecord["product"]) {
  const links = [
    { label: `${product.source.database} record`, url: product.source.url },
  ];
  const setid = product.identifiers.splSetId;
  if (setid !== undefined && product.source.database !== "DailyMed") {
    links.push({ label: "DailyMed label", url: dailyMedLabelUrl(setid) });
  }
  const dsldId = product.identifiers.dsldId;
  if (dsldId !== undefined && product.source.database !== "DSLD") {
    links.push({
      label: "DSLD label",
      url: `https://dsld.od.nih.gov/label/${dsldId}`,
    });
  }
  const slug = product.identifiers.slug;
  if (slug !== undefined && product.source.database !== "INKEEDecoder") {
    links.push({
      label: "INKEEDecoder product",
      url: `https://inkeedecoder.com/products/${slug}`,
    });
  }
  return links;
}

/** Renders one product detail as markdown. */
function renderMarkdown(
  source: ProductSource,
  output: z.infer<typeof productDetailSchema>,
  truncated: boolean,
): string {
  const { product } = output;
  const identifiers = identifierText(product.identifiers, IDENTIFIER_FIELDS);
  const productLines = [`## ${product.name}`];
  if (product.brand !== undefined)
    productLines.push(`- Brand: ${product.brand}`);
  if (product.category !== undefined) {
    productLines.push(`- Category: ${product.category}`);
  }
  if (output.summary !== undefined) {
    productLines.push(`- Summary: ${output.summary}`);
  }
  if (identifiers !== undefined)
    productLines.push(`- Identifiers: ${identifiers}`);
  productLines.push(
    `- Source: ${product.source.url} (retrieved ${product.source.retrievedAt})`,
  );

  const ingredientLines =
    output.ingredients === undefined
      ? ["- Ingredients omitted (include_ingredients: false)."]
      : output.ingredients.length === 0
        ? [
            product.identifiers.splSetId !== undefined &&
            !output.labelIngredientsIncluded
              ? '- No ingredient rows were loaded from this record. Use source: "dailymed" with this SPL set id for the label\'s ingredient rows.'
              : "- No ingredient rows are available for this product.",
          ]
        : output.ingredients.map((ingredient) => {
            const details = [`**${ingredient.name}**`];
            if (ingredient.role !== undefined) {
              details.push(`role: ${ingredient.role}`);
            }
            if (ingredient.quantity !== undefined) {
              details.push(`quantity: ${ingredient.quantity}`);
            }
            if (ingredient.form !== undefined) {
              details.push(`form: ${ingredient.form}`);
            }
            if (ingredient.identifiers.unii !== undefined) {
              details.push(`UNII: ${ingredient.identifiers.unii}`);
            }
            const cas = ingredient.identifiers.cas?.[0];
            if (cas !== undefined) details.push(`CAS: ${cas}`);
            return `- ${details.join(" · ")}`;
          });

  const blocks = [
    `Product detail — ${source} (${product.source.id}).`,
    productLines.join("\n"),
    [
      `## Ingredients (${
        output.ingredients === undefined ? "omitted" : output.ingredients.length
      })`,
      ...ingredientLines,
    ].join("\n"),
  ];

  const labelSections = output.labelSections;
  if (labelSections !== undefined) {
    const sectionBlocks = [
      `## Label sections (${labelSections.sections.length}${
        labelSections.truncated ? ", truncated" : ""
      })`,
      "_Verbatim SPL text; consult the current official labeling._",
    ];
    if (labelSections.sections.length === 0) {
      sectionBlocks.push("- No usage sections were found in this label.");
    } else {
      for (const section of labelSections.sections) {
        sectionBlocks.push(`### ${section.heading}\n\n${section.text}`);
      }
    }
    blocks.push(sectionBlocks.join("\n\n"));
  }

  blocks.push(
    [
      "## Links",
      ...output.links.map((link) => `- [${link.label}](${link.url})`),
    ].join("\n"),
  );
  const steps = nextStepsText(output.nextSteps);
  if (steps !== undefined) blocks.push(steps);

  let text = blocks.join("\n\n");
  if (
    output.pagination.ingredientsHasMore ||
    output.pagination.sectionsHasMore
  ) {
    text += morePagesNote(true, output.pagination.page + 1);
  }
  if (truncated) text += truncationNote();
  return text;
}

/** Registers the `drugdata_get_product` tool. */
export function registerGetProductTool(
  server: McpServer,
  registry?: Registry,
): void {
  server.registerTool(
    "drugdata_get_product",
    {
      title: "Get one product record from an open drug data source",
      description: DESCRIPTION,
      inputSchema,
      outputSchema: productDetailSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      source,
      id,
      include_label_sections,
      include_ingredients,
      page,
      response_format,
    }: GetProductInput) => {
      try {
        const prepared = prepareProductId(source, id);
        if (!prepared.ok) return messageError(prepared.error);

        const resolved = resolveRegistry(registry);
        if (!resolved.ok) return messageError(resolved.error);

        const raw = await resolved.registry.getProduct(
          SOURCE_DATABASES[source],
          prepared.id,
          {
            includeLabelSections: include_label_sections,
          },
        );
        const record = sourceRecordSchema.parse(raw);
        const details = productDetailsSchema.parse(record.details ?? {});
        const summary = detailSummary(
          source,
          details,
          record.summary ?? record.product.summary,
        );

        const allIngredients = include_ingredients
          ? record.ingredients
          : undefined;
        const ingredientPage = pageOf(
          allIngredients,
          page,
          INGREDIENT_PAGE_SIZE,
        );
        const ingredientsHasMore = hasMoreOf(
          allIngredients,
          page,
          INGREDIENT_PAGE_SIZE,
        );

        const sectionsSource = include_label_sections
          ? record.labelSections
          : undefined;
        const allSections = sectionsSource?.sections;
        const sectionsHasMore = hasMoreOf(allSections, page, SECTION_PAGE_SIZE);
        const labelSections =
          sectionsSource === undefined
            ? undefined
            : {
                sections: pageSlice(
                  sectionsSource.sections,
                  page,
                  SECTION_PAGE_SIZE,
                ),
                truncated: sectionsSource.truncated,
              };

        const skeleton = productDetailSchema.parse({
          product: record.product,
          details,
          ...(ingredientPage !== undefined
            ? { ingredients: ingredientPage }
            : {}),
          ...(labelSections !== undefined ? { labelSections } : {}),
          nextSteps: [],
          links: productLinks(record.product),
          ...(summary !== undefined ? { summary } : {}),
          labelIngredientsIncluded:
            include_ingredients && (record.labelIngredientsIncluded ?? false),
          pagination: {
            page,
            ingredientsHasMore,
            sectionsHasMore,
          },
        });

        // Bound first, then derive follow-ups from what the rendered detail
        // actually contains, so a dropped ingredient cannot leave a step that
        // points at something the model cannot see.
        const bounded = boundStructured(skeleton);
        const subject: ProductDetailSubject = {
          product: bounded.value.product,
          ingredients: bounded.value.ingredients ?? [],
        };
        const withSteps = productDetailSchema.parse({
          ...bounded.value,
          nextSteps: productDetailNextSteps(subject),
        });
        const final = boundStructured(withSteps);
        const truncated = bounded.truncated || final.truncated;
        // Bounding may shorten section text, so the section flag must reflect
        // it even when the extractor itself did not hit its own caps.
        const value =
          truncated && final.value.labelSections !== undefined
            ? productDetailSchema.parse({
                ...final.value,
                labelSections: {
                  ...final.value.labelSections,
                  truncated: true,
                },
              })
            : final.value;

        if (response_format === "json") {
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
                renderMarkdown(source, value, truncated),
              ),
            },
          ],
          structuredContent: value,
        };
      } catch (error) {
        return toolError(error, `the ${source} product lookup`);
      }
    },
  );
}
