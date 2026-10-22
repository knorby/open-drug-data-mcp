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
  matchBasis: z
    .string()
    .optional()
    .describe(
      "How the product was matched, for weak or name-based hits (for example a brand query answered as a name search).",
    ),
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
  form: z
    .string()
    .optional()
    .describe("Dosage or physical form as the source states it."),
  identifiers: ingredientIdentifiersSchema,
  source: sourceRefSchema,
  matchBasis: z
    .string()
    .optional()
    .describe("How the ingredient was matched, for weak or name-based hits."),
  summary: z
    .string()
    .optional()
    .describe("Short source-faithful summary, including regulatory notes."),
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
 * Source-specific detail fields for one product.
 *
 * Sources are asymmetric, so every field is optional and the object is closed:
 * an adapter contributes the fields its database actually knows, and a stray
 * upstream key cannot reach `structuredContent`.
 */
export const productDetailsSchema = z.object({
  source: z
    .enum(["ndc", "label"])
    .optional()
    .describe("Which openFDA record backed the result."),
  labeler: z.string().optional(),
  marketingCategory: z.string().optional(),
  applicationNumber: z.string().optional(),
  productType: z.string().optional(),
  splSetId: z.string().optional(),
  effectiveTime: z.string().optional(),
  version: z.string().optional(),
  dosageForm: z.string().optional(),
  tty: z.string().optional(),
  synonym: z.string().optional(),
  targetGroups: z.array(z.string()).optional(),
  netContents: z.array(z.string()).optional(),
  claims: z.array(z.string()).optional(),
  offMarket: z.boolean().optional(),
  entryDate: z.string().optional(),
  description: z.string().optional(),
  hashtags: z.array(z.string()).optional(),
  uploadedBy: z.string().optional(),
  uploadedAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

/** Source-specific detail fields for one product. */
export type ProductDetails = z.infer<typeof productDetailsSchema>;

/** One usage-oriented section extracted from a DailyMed SPL label. */
export const labelSectionSchema = z.object({
  heading: z.string(),
  text: z.string(),
});

/** One usage-oriented section extracted from a DailyMed SPL label. */
export type LabelSection = z.infer<typeof labelSectionSchema>;

/** Usage sections plus whether the extraction had to shorten them. */
export const labelSectionsSchema = z.object({
  sections: z.array(labelSectionSchema),
  truncated: z.boolean(),
});

/** Usage sections plus whether the extraction had to shorten them. */
export type LabelSections = z.infer<typeof labelSectionsSchema>;

/** A follow-up link on a detail record. */
export const recordLinkSchema = z.object({
  label: z.string().describe("Short human-readable label for the link."),
  url: z.string().describe("Deep link to the related record."),
});

/** A follow-up link on a detail record. */
export type RecordLink = z.infer<typeof recordLinkSchema>;

/** A follow-up link on a product detail. */
export const productLinkSchema = recordLinkSchema;

/** A follow-up link on a product detail. */
export type ProductLink = z.infer<typeof productLinkSchema>;

/** Collection paging state for one product lookup. */
export const productPaginationSchema = z.object({
  page: z.number().int().min(1),
  ingredientsTotal: z.number().int().min(0),
  ingredientsHasMore: z.boolean(),
  sectionsTotal: z.number().int().min(0),
  sectionsHasMore: z.boolean(),
});

/** Collection paging state for one product lookup. */
export type ProductPagination = z.infer<typeof productPaginationSchema>;

/**
 * A full product record.
 *
 * The briefed shape is `product`, `details`, optional `ingredients` and
 * `labelSections`, and `nextSteps`. `links`, `summary`,
 * `labelIngredientsIncluded`, and `pagination` are additive fields that keep
 * the record navigable without changing the briefed keys' types.
 *
 * Closed like every result schema: an adapter's stray field cannot reach
 * `structuredContent`. `ingredients` is omitted when the caller turns
 * `include_ingredients` off; `labelSections` is omitted unless a DailyMed
 * lookup asked for them.
 */
export const productDetailSchema = z.object({
  product: productRefSchema,
  details: productDetailsSchema,
  ingredients: z.array(ingredientRefSchema).optional(),
  labelSections: labelSectionsSchema.optional(),
  nextSteps: z.array(nextStepSchema),
  links: z.array(productLinkSchema),
  summary: z
    .string()
    .optional()
    .describe("Source-faithful overview assembled from the record."),
  labelIngredientsIncluded: z.boolean(),
  pagination: productPaginationSchema,
});

/** A full product record in the unified vocabulary. */
export type ProductDetail = z.infer<typeof productDetailSchema>;

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

/**
 * Source-specific ingredient profile.
 *
 * Sources are asymmetric, so every field is optional and the object is closed:
 * openFDA supplies names/codes/relationships, CosIng supplies functions and
 * regulatory references, DrugCentral supplies the identity crosswalk and
 * clinical assertions, RxNorm supplies the concept and RxTerms, and
 * INKEEDecoder supplies its page's editorial fields. A source contributes what
 * it actually knows; absent facts stay absent.
 */
export const ingredientNameSchema = z.object({
  name: z.string(),
  type: z.string().optional(),
  preferred: z.boolean().optional(),
  displayName: z.boolean().optional(),
  organizations: z.array(z.string()),
});

/** One name variant recorded by a source. */
export type IngredientName = z.infer<typeof ingredientNameSchema>;

/** One source-assigned code (for example a CAS number or ChEMBL id). */
export const ingredientCodeSchema = z.object({
  code: z.string(),
  system: z.string(),
  type: z.string().optional(),
});

/** One source-assigned code. */
export type IngredientCode = z.infer<typeof ingredientCodeSchema>;

/** One relationship from a substance record to another substance. */
export const ingredientRelationshipSchema = z.object({
  type: z.string().optional(),
  qualification: z.string().optional(),
  relatedName: z.string().optional(),
  relatedUnii: z.string().optional(),
  relatedSubstanceClass: z.string().optional(),
});

/** One substance relationship. */
export type IngredientRelationship = z.infer<
  typeof ingredientRelationshipSchema
>;

/** One row of a source's identifier crosswalk. */
export const ingredientCrosswalkSchema = z.object({
  type: z.string().describe("Source identifier vocabulary, e.g. DRUGBANK_ID."),
  value: z.string(),
});

/** One row of a source's identifier crosswalk. */
export type IngredientCrosswalk = z.infer<typeof ingredientCrosswalkSchema>;

/** The RxTerms presentation fields RxNorm publishes for a concept. */
export const rxTermSchema = z.object({
  displayName: z.string(),
  fullName: z.string().optional(),
  brandName: z.string().optional(),
  strength: z.string().optional(),
  route: z.string().optional(),
});

/** RxTerms presentation fields for a concept. */
export type RxTerm = z.infer<typeof rxTermSchema>;

/** One drug-condition assertion, preserving the source's relationship label. */
export const conditionAssertionSchema = z.object({
  name: z.string(),
  relationship: z
    .string()
    .describe("Verbatim source relationship label, e.g. indication."),
  conceptId: z.number().int().optional(),
  snomedConceptId: z.string().optional(),
  snomedFullName: z.string().optional(),
  umlsCui: z.string().optional(),
});

/** One drug-condition assertion. */
export type ConditionAssertion = z.infer<typeof conditionAssertionSchema>;

/**
 * One FAERS disproportionality signal. The count fields are report
 * contingencies for the drug x event table, never incidence rates.
 */
export const faersSignalSchema = z.object({
  population: z.enum(["all", "male", "female"]),
  term: z.string(),
  llr: z.number().optional(),
  llrThreshold: z.number().optional(),
  drugAe: z.number().int().optional(),
  drugNoAe: z.number().int().optional(),
  noDrugAe: z.number().int().optional(),
  noDrugNoAe: z.number().int().optional(),
});

/** One FAERS signal. */
export type FaersSignal = z.infer<typeof faersSignalSchema>;

/** DrugCentral clinical assertions plus FAERS signals. */
export const ingredientClinicalSchema = z.object({
  indications: z.array(conditionAssertionSchema),
  offLabelUses: z.array(conditionAssertionSchema),
  contraindications: z.array(conditionAssertionSchema),
  faers: z.array(faersSignalSchema),
  truncated: z
    .boolean()
    .describe("Whether any clinical list was capped before emission."),
});

/** DrugCentral clinical assertions plus FAERS signals. */
export type IngredientClinical = z.infer<typeof ingredientClinicalSchema>;

/** Source-specific ingredient profile fields. */
export const ingredientProfileSchema = z.object({
  // openFDA substance records.
  substanceClass: z.string().optional(),
  definitionLevel: z.string().optional(),
  definitionType: z.string().optional(),
  names: z.array(ingredientNameSchema).optional(),
  codes: z.array(ingredientCodeSchema).optional(),
  relationships: z.array(ingredientRelationshipSchema).optional(),

  // CosIng inventory records.
  glossaryName: z.string().optional(),
  inciName: z.string().optional(),
  innName: z.string().optional(),
  inciUsaName: z.string().optional(),
  phEurName: z.string().optional(),
  chemicalName: z.string().optional(),
  chemicalDescription: z.string().optional(),
  functions: z.array(z.string()).optional(),
  status: z.string().optional(),
  annexNumbers: z.array(z.string()).optional(),
  identifiedIngredientIds: z.array(z.string()).optional(),
  cosmeticRestriction: z.string().optional(),
  otherRestrictions: z.array(z.string()).optional(),
  sccsOpinions: z.array(z.string()).optional(),
  notes: z.array(z.string()).optional(),
  perfuming: z.boolean().optional(),
  officialJournalPublication: z.boolean().optional(),

  // DrugCentral structure profiles.
  structId: z.number().int().optional(),
  cas: z.string().optional().describe("DrugCentral's primary CAS number."),
  inchiKey: z.string().optional(),
  cid: z.number().int().optional(),
  formula: z.string().optional(),
  molecularWeight: z.number().optional(),
  smiles: z.string().optional(),
  inchi: z.string().optional(),
  identifiers: z.array(ingredientCrosswalkSchema).optional(),
  atc: z.array(z.string()).optional(),
  synonyms: z.array(z.string()).optional(),
  clinical: ingredientClinicalSchema.optional(),

  // RxNorm concepts and RxTerms.
  rxcui: z.string().optional(),
  tty: z.string().optional(),
  synonym: z.string().optional(),
  rxTerm: rxTermSchema.optional(),
  ndcs: z.array(z.string()).optional(),

  // INKEEDecoder ingredient pages.
  alsoCalled: z.string().optional(),
  irritancy: z.string().optional(),
  comedogenicity: z.string().optional(),
  cosingFunctions: z.string().optional(),
  iupacName: z.string().optional(),
  image: z.string().optional(),
  details: z.string().optional(),
  proof: z.array(z.string()).optional(),
});

/** Source-specific ingredient profile fields. */
export type IngredientProfile = z.infer<typeof ingredientProfileSchema>;

/** One regulatory notice, with its verbatim text and match basis. */
export const regulatoryNoticeSchema = z.object({
  text: z.string().describe("Source regulatory text, preserved verbatim."),
  basis: z
    .string()
    .describe("Why the notice applies, e.g. annex III or CAS substring match."),
  source: databaseIdSchema.describe("Upstream database that supplied it."),
});

/** One regulatory notice. */
export type RegulatoryNotice = z.infer<typeof regulatoryNoticeSchema>;

/** Regulatory notices attached to an ingredient profile. */
export const ingredientRegulatorySchema = z.object({
  notices: z.array(regulatoryNoticeSchema),
});

/** Regulatory notices attached to an ingredient profile. */
export type IngredientRegulatory = z.infer<typeof ingredientRegulatorySchema>;

/**
 * A full ingredient record.
 *
 * The briefed shape is `ingredient`, `profile`, and `nextSteps`. `regulatory`
 * and `links` are additive: regulatory notices keep verbatim source text and
 * its basis visible at the top level, and links make the record navigable
 * without re-deriving URLs.
 */
export const ingredientDetailSchema = z.object({
  ingredient: ingredientRefSchema,
  profile: ingredientProfileSchema,
  regulatory: ingredientRegulatorySchema.optional(),
  links: z.array(recordLinkSchema),
  nextSteps: z.array(nextStepSchema),
});

/** A full ingredient record in the unified vocabulary. */
export type IngredientDetail = z.infer<typeof ingredientDetailSchema>;
