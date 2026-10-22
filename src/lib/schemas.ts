import { z } from "zod/v4";

/**
 * Shared result schemas.
 *
 * These are output shapes: the tool layer validates what it returns against
 * them, so every consumer (tools, tests, the identity graph) agrees on one
 * vocabulary.
 *
 * Two rules hold throughout:
 *
 * - **Upstream databases only.** `database` names the database that supplied
 *   the data (openFDA, CosIng, RxNorm, DailyMed, DrugCentral, DSLD,
 *   INKEEDecoder) — never a client library. Tool output is built from these
 *   schemas, so a client name here would leak into the model's context.
 * - **Closed objects.** Every `z.object` strips unknown keys (zod's default),
 *   so a stray upstream field cannot reach `structuredContent` and break a
 *   host's schema validation. Nested objects are closed the same way.
 */

/** Upstream database credited for a result. */
export const databaseIdSchema = z.enum([
  "openFDA",
  "CosIng",
  "RxNorm",
  "DailyMed",
  "DrugCentral",
  "DSLD",
  "INKEEDecoder",
]);

/** Upstream database credited for a result. */
export type DatabaseId = z.infer<typeof databaseIdSchema>;

/** Where a record came from, with a deep link and the fetch timestamp. */
export const sourceRefSchema = z.object({
  database: databaseIdSchema,
  id: z
    .string()
    .describe("Identifier of the record within the upstream database."),
  url: z.string().describe("Deep link to the record in the upstream database."),
  retrievedAt: z.iso
    .datetime()
    .describe("When the record was fetched, as an ISO 8601 UTC timestamp."),
});

/** Where a record came from, with a deep link and the fetch timestamp. */
export type SourceRef = z.infer<typeof sourceRefSchema>;

/** Identifiers a product may carry across the sources. */
export const productIdentifiersSchema = z.object({
  ndc: z
    .array(z.string())
    .optional()
    .describe("National Drug Code values, canonical 11-digit form."),
  upc: z.array(z.string()).optional().describe("Package barcodes (UPC/EAN)."),
  rxcui: z.array(z.string()).optional().describe("RxNorm concept identifiers."),
  splSetId: z
    .string()
    .optional()
    .describe("Structured Product Label set id (DailyMed)."),
  dsldId: z
    .number()
    .int()
    .optional()
    .describe("NIH DSLD label record identifier."),
  applicationNumber: z
    .string()
    .optional()
    .describe("FDA application number (NDA, ANDA, or OTC monograph)."),
  slug: z
    .string()
    .optional()
    .describe("INKEEDecoder product slug for follow-up lookups."),
});

/** Identifiers a product may carry across the sources. */
export type ProductIdentifiers = z.infer<typeof productIdentifiersSchema>;

/** Identifiers an ingredient may carry across the sources. */
export const ingredientIdentifiersSchema = z.object({
  unii: z
    .string()
    .optional()
    .describe("FDA Unique Ingredient Identifier (UNII)."),
  cas: z.array(z.string()).optional().describe("CAS Registry Numbers."),
  ec: z
    .array(z.string())
    .optional()
    .describe("European Community (EC) numbers for cosmetic ingredients."),
  rxcui: z.array(z.string()).optional().describe("RxNorm concept identifiers."),
  structId: z
    .number()
    .int()
    .optional()
    .describe("DrugCentral structure identifier."),
  cid: z.array(z.number().int()).optional().describe("PubChem compound ids."),
  inchiKey: z.string().optional().describe("InChIKey."),
  slug: z
    .string()
    .optional()
    .describe("INKEEDecoder ingredient slug for follow-up lookups."),
});

/** Identifiers an ingredient may carry across the sources. */
export type IngredientIdentifiers = z.infer<typeof ingredientIdentifiersSchema>;

/** Coarse product category, used by search filters and result labels. */
export const productCategorySchema = z.enum([
  "medication",
  "supplement",
  "cosmetic",
]);

/** Coarse product category, used by search filters and result labels. */
export type ProductCategory = z.infer<typeof productCategorySchema>;

/** How an ingredient participates in a product. */
export const ingredientRoleSchema = z.enum(["active", "inactive"]);

/** How an ingredient participates in a product. */
export type IngredientRole = z.infer<typeof ingredientRoleSchema>;

/** A product found in one upstream database. */
export const productRefSchema = z.object({
  name: z.string(),
  brand: z.string().optional(),
  category: productCategorySchema.optional(),
  identifiers: productIdentifiersSchema,
  source: sourceRefSchema,
  summary: z.string().optional(),
});

/** A product found in one upstream database. */
export type ProductRef = z.infer<typeof productRefSchema>;

/** An ingredient found in one upstream database. */
export const ingredientRefSchema = z.object({
  name: z.string(),
  inciName: z.string().optional(),
  role: ingredientRoleSchema.optional(),
  quantity: z
    .string()
    .optional()
    .describe("Strength or concentration as the source states it."),
  identifiers: ingredientIdentifiersSchema,
  source: sourceRefSchema,
  matchBasis: z
    .string()
    .optional()
    .describe("How the ingredient was matched, for weak or name-based hits."),
});

/** An ingredient found in one upstream database. */
export type IngredientRef = z.infer<typeof ingredientRefSchema>;

/**
 * A suggested follow-up call that continues the search → resolve → get loop.
 * `why` is model-facing text, and `input` is the argument object to pass
 * verbatim to `tool`.
 */
export const nextStepSchema = z.object({
  tool: z.string(),
  input: z.record(z.string(), z.unknown()),
  why: z.string(),
});

/** A suggested follow-up call that continues the search → resolve → get loop. */
export type NextStep = z.infer<typeof nextStepSchema>;

/**
 * Pagination fields shared by grouped results.
 *
 * Exported as a raw shape (not a schema) so a group can spread it:
 * `z.object({ source, items, ...paginatedFields })`. `paginatedFieldsSchema`
 * is the standalone object form for direct parsing.
 */
export const paginatedFields = {
  page: z.number().int().min(1),
  hasMore: z.boolean(),
};

/** Pagination fields shared by grouped results. */
export const paginatedFieldsSchema = z.object(paginatedFields);

/** Pagination fields shared by grouped results. */
export type PaginatedFields = z.infer<typeof paginatedFieldsSchema>;
