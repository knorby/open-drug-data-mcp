import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  applyCharacterLimit,
  boundStructured,
  formatJson,
  RESPONSE_FORMATS,
  truncationNote,
} from "../lib/format.js";
import { isSplSetId, normalizeNdc, normalizeSlug } from "../lib/ids.js";
import {
  type ProductDetailSubject,
  productDetailNextSteps,
} from "../lib/next-steps.js";
import {
  type IngredientRef,
  ingredientRefSchema,
  type ProductIdentifiers,
  type ProductIngredient,
  productDetailSchema,
  productRefSchema,
} from "../lib/schemas.js";
import { dailyMedLabelUrl } from "../sources/identity/spl.js";
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
 * `include_label_ingredients` is the one costly switch. An openFDA product
 * may carry an SPL set id, and parsing that label XML adds ingredient rows
 * with UNIIs and active/inactive roles at the cost of one extra DailyMed
 * request. It defaults off so an ordinary openFDA lookup stays cheap. A
 * DailyMed product is the label itself, so its ingredients are parsed without
 * the flag; structured sources (DSLD, INKEEDecoder) already publish their
 * ingredient rows and need no flag either.
 */

/** Databases that can answer a product lookup, as agent-visible labels. */
export const PRODUCT_SOURCES = [
  "openFDA",
  "RxNorm",
  "DailyMed",
  "DSLD",
  "INKEEDecoder",
] as const;

/** Databases that can answer a product lookup. */
export type ProductSource = (typeof PRODUCT_SOURCES)[number];

/** An openFDA NDC directory product id (labeler-product, no package segment). */
const OPENFDA_PRODUCT_NDC = /^\d{4,5}-\d{3,4}$/;

/** RxNorm concepts are decimal identifiers. */
const RXCUI = /^\d+$/;

/** A DSLD label id is a positive safe integer. */
const DSLD_ID = /^\d+$/;

const DESCRIPTION =
  "Fetch one product record from openFDA, RxNorm, DailyMed, DSLD, or INKEEDecoder. The `id` is the database's own key: a product NDC or SPL set id for openFDA, an RxCUI for RxNorm, an SPL set id for DailyMed, a label id for DSLD, and a product slug (or product URL) for INKEEDecoder. The result carries the unified product ref, its ingredient rows, links to the source records, and suggested follow-up calls. Set `include_label_ingredients: true` to parse an openFDA product's SPL XML for ingredient UNIIs, strengths, and active/inactive roles — this costs one extra DailyMed request; default false. DailyMed products always include their label ingredients because the label is the record. A malformed id is an error result naming the search tool that finds a valid one; an upstream miss is an error result, not an empty product.";

const inputSchema = z.object({
  source: z
    .enum(PRODUCT_SOURCES, {
      error: `source must be one of: ${PRODUCT_SOURCES.join(", ")}.`,
    })
    .describe(
      "Upstream database that owns the record: 'openFDA', 'RxNorm', 'DailyMed', 'DSLD', or 'INKEEDecoder'.",
    ),
  id: z
    .string()
    .trim()
    .max(300)
    .describe(
      "The database's own identifier: product NDC or SPL set id (openFDA), rxcui (RxNorm), SPL set id (DailyMed), numeric label id (DSLD), or slug/URL (INKEEDecoder).",
    ),
  include_label_ingredients: z
    .boolean()
    .default(false)
    .describe(
      "Parse an openFDA product's SPL XML to add ingredient rows with UNIIs, strengths, and active/inactive roles. One extra DailyMed request; DailyMed products always include their label ingredients; default false.",
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
    case "openFDA": {
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
    case "RxNorm":
      return RXCUI.test(id)
        ? { ok: true, id }
        : invalidId(
            source,
            id,
            "expects an RxNorm concept id (rxcui, decimal digits)",
          );
    case "DailyMed":
      return isSplSetId(id)
        ? { ok: true, id: id.toLowerCase() }
        : invalidId(source, id, "expects a DailyMed SPL set id (UUID-shaped)");
    case "DSLD": {
      const numeric = Number(id);
      return DSLD_ID.test(id) && Number.isSafeInteger(numeric) && numeric > 0
        ? { ok: true, id: String(numeric) }
        : invalidId(source, id, "expects a positive numeric DSLD label id");
    }
    case "INKEEDecoder": {
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

/** Whether a value is a plain object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Reads a non-blank string field from a record. */
function stringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

/** Reads a string list field from a record, dropping blank entries. */
function stringListField(
  record: Record<string, unknown> | undefined,
  key: string,
): string[] {
  const value = record?.[key];
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
  details: unknown,
  fallback: string | undefined,
): string | undefined {
  const record = asRecord(details);
  const parts: string[] = [];

  if (source === "openFDA") {
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
  } else if (source === "RxNorm") {
    pushPart(parts, stringField(record, "tty"), "RxNorm term type");
    pushPart(parts, stringField(record, "synonym"), "Synonym");
  } else if (source === "DailyMed") {
    const version = stringField(record, "version");
    if (version !== undefined) parts.push(`SPL version ${version}`);
    const effectiveTime = stringField(record, "effectiveTime");
    if (effectiveTime !== undefined) parts.push(`effective ${effectiveTime}`);
    pushPart(parts, stringField(record, "dosageForm"));
    pushPart(parts, stringField(record, "labeler"), "Labeler");
  } else if (source === "DSLD") {
    pushPart(parts, stringField(record, "productType"));
    const offMarket = record?.offMarket;
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

/** Maps an adapter ingredient ref to the flatter product-detail row. */
function detailIngredient(ref: IngredientRef): ProductIngredient {
  const cas = ref.identifiers.cas?.[0];
  return {
    name: ref.name,
    ...(ref.identifiers.unii !== undefined
      ? { unii: ref.identifiers.unii }
      : {}),
    ...(cas !== undefined ? { cas } : {}),
    ...(ref.role !== undefined ? { role: ref.role } : {}),
    ...(ref.quantity !== undefined ? { strength: ref.quantity } : {}),
    ...(ref.form !== undefined ? { form: ref.form } : {}),
    source: ref.source,
  };
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
    output.ingredients.length === 0
      ? [
          product.identifiers.splSetId !== undefined &&
          !output.labelIngredientsIncluded
            ? "- No ingredient rows were loaded. Call again with include_label_ingredients: true to parse the SPL label (one extra request)."
            : "- No ingredient rows are available for this product.",
        ]
      : output.ingredients.map((ingredient) => {
          const details = [
            `**${ingredient.name}**`,
            `role: ${ingredient.role ?? "unknown"}`,
          ];
          if (ingredient.strength !== undefined) {
            details.push(`strength: ${ingredient.strength}`);
          }
          if (ingredient.form !== undefined)
            details.push(`form: ${ingredient.form}`);
          if (ingredient.unii !== undefined)
            details.push(`UNII: ${ingredient.unii}`);
          if (ingredient.cas !== undefined)
            details.push(`CAS: ${ingredient.cas}`);
          return `- ${details.join(" · ")}`;
        });

  const sections = [
    `Product detail — ${source} (${product.source.id}).`,
    productLines.join("\n"),
    [`## Ingredients (${output.ingredients.length})`, ...ingredientLines].join(
      "\n",
    ),
    [
      "## Links",
      ...output.links.map((link) => `- [${link.label}](${link.url})`),
    ].join("\n"),
  ];
  const steps = nextStepsText(output.nextSteps);
  if (steps !== undefined) sections.push(steps);

  let text = sections.join("\n\n");
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
      include_label_ingredients,
      response_format,
    }: GetProductInput) => {
      try {
        const prepared = prepareProductId(source, id);
        if (!prepared.ok) return messageError(prepared.error);

        const resolved = resolveRegistry(registry);
        if (!resolved.ok) return messageError(resolved.error);

        const raw = await resolved.registry.getProduct(source, prepared.id, {
          includeLabelIngredients: include_label_ingredients,
        });
        const record = sourceRecordSchema.parse(raw);
        const summary = detailSummary(
          source,
          record.details,
          record.summary ?? record.product.summary,
        );
        const skeleton = productDetailSchema.parse({
          product: record.product,
          ingredients: record.ingredients.map(detailIngredient),
          links: productLinks(record.product),
          ...(summary !== undefined ? { summary } : {}),
          nextSteps: [],
          labelIngredientsIncluded: record.labelIngredientsIncluded ?? false,
        });

        // Bound first, then derive follow-ups from what the rendered detail
        // actually contains, so a dropped ingredient cannot leave a step that
        // points at something the model cannot see.
        const bounded = boundStructured(skeleton);
        const subject: ProductDetailSubject = {
          product: bounded.value.product,
          ingredients: bounded.value.ingredients,
        };
        const withSteps = productDetailSchema.parse({
          ...bounded.value,
          nextSteps: productDetailNextSteps(subject),
        });
        const final = boundStructured(withSteps);
        const truncated = bounded.truncated || final.truncated;

        if (response_format === "json") {
          return {
            content: [{ type: "text" as const, text: formatJson(final.value) }],
            structuredContent: final.value,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: applyCharacterLimit(
                renderMarkdown(source, final.value, truncated),
              ),
            },
          ],
          structuredContent: final.value,
        };
      } catch (error) {
        return toolError(error, `the ${source} product lookup`);
      }
    },
  );
}
