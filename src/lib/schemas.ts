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
 *   the data (openFDA, CosIng, RxNorm, RxTerms, RxClass, DailyMed,
 *   DrugCentral, DSLD, INKEEDecoder, MeSH, PubMed, MedlinePlus, UMLS,
 *   ClinicalTrials.gov, PubChem) — never a client library. Tool output is
 *   built from these schemas, so a client name here would leak into the
 *   model's context.
 * - **Closed objects.** Every `z.object` strips unknown keys (zod's default),
 *   so a stray upstream field cannot reach `structuredContent` and break a
 *   host's schema validation. Nested objects are closed the same way.
 */

/** Upstream database credited for a result. */
export const databaseIdSchema = z.enum([
  "openFDA",
  "CosIng",
  "RxNorm",
  "RxTerms",
  "RxClass",
  "DailyMed",
  "DrugCentral",
  "DSLD",
  "INKEEDecoder",
  "MeSH",
  "PubMed",
  "MedlinePlus",
  "UMLS",
  "ClinicalTrials.gov",
  "PubChem",
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
    .describe(
      "National Drug Code values as the source spells them: 10- or 11-digit, dashed or plain.",
    ),
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

/** How sure the identity chain is that a source link names the same substance. */
export const linkConfidenceSchema = z.enum(["direct", "derived"]);

/** How sure the identity chain is that a source link names the same substance. */
export type LinkConfidence = z.infer<typeof linkConfidenceSchema>;

/** One confident cross-source link in an identity graph. */
export const sourceLinkSchema = z.object({
  database: databaseIdSchema,
  id: z.string().describe("Identifier of the linked record upstream."),
  url: z.string().describe("Deep link to the linked record upstream."),
  matchedVia: z
    .string()
    .describe("Which identifier or name established the link."),
  confidence: linkConfidenceSchema,
});

/** One confident cross-source link in an identity graph. */
export type SourceLink = z.infer<typeof sourceLinkSchema>;

/** One ambiguous source result, never auto-linked. */
export const candidateSetSchema = z.object({
  database: databaseIdSchema,
  matchedVia: z.string(),
  reason: z.string().describe("Why the chain kept this as a candidate set."),
  options: z
    .array(ingredientRefSchema)
    .describe("Ingredient records the caller must choose between."),
  optionsTruncated: z
    .boolean()
    .optional()
    .describe(
      "True when the chain's cap kept some options out of this list; the tool text names the cap when set.",
    ),
});

/** One ambiguous source result, never auto-linked. */
export type CandidateSet = z.infer<typeof candidateSetSchema>;

/** Competing identifier values with the exact upstream record attribution. */
export const identifierConflictSchema = z.object({
  field: z.string(),
  values: z.array(
    z.object({
      record: sourceRefSchema,
      value: z.union([
        z.string(),
        z.number(),
        z.array(z.string()),
        z.array(z.number()),
      ]),
    }),
  ),
});
export type IdentifierConflict = z.infer<typeof identifierConflictSchema>;
export const resolutionStateSchema = z.enum([
  "complete",
  "partial",
  "skipped",
  "unavailable",
]);
export type ResolutionState = z.infer<typeof resolutionStateSchema>;
const entityFields = {
  name: z.string(),
  links: z.array(sourceLinkSchema),
  evidence: z.array(
    z.object({
      kind: z.string(),
      value: z.string(),
      confidence: linkConfidenceSchema,
    }),
  ),
  conflicts: z.array(identifierConflictSchema),
  candidates: z.array(candidateSetSchema),
  resolution: resolutionStateSchema,
  nextSteps: z.array(nextStepSchema),
};
export const ingredientSearchEntitySchema = z.object({
  ...entityFields,
  identifiers: ingredientIdentifiersSchema,
  records: z.array(ingredientRefSchema),
});
export const productSearchEntitySchema = z.object({
  ...entityFields,
  identifiers: productIdentifiersSchema,
  records: z.array(productRefSchema),
});
export type IngredientSearchEntity = z.infer<
  typeof ingredientSearchEntitySchema
>;
export type ProductSearchEntity = z.infer<typeof productSearchEntitySchema>;
export const sourceSearchStatusSchema = z.object({
  source: databaseIdSchema,
  status: z.enum(["ok", "error", "timeout"]),
  page: z.number().int(),
  hasMore: z.boolean(),
  resultCount: z.number().int(),
  error: z.string().optional(),
});
export type SourceSearchStatus = z.infer<typeof sourceSearchStatusSchema>;
export const searchCoverageSchema = z.object({
  entities: z.number().int(),
  records: z.number().int(),
  resolutionAttempted: z.number().int(),
  resolutionCompleted: z.number().int(),
  resolutionCapped: z.boolean(),
});
export type SearchCoverage = z.infer<typeof searchCoverageSchema>;
const searchResultFields = {
  query: z.string(),
  type: z.string(),
  page: z.number().int(),
  sources: z.array(sourceSearchStatusSchema),
  coverage: searchCoverageSchema,
  partial: z.boolean(),
  nextSteps: z.array(nextStepSchema),
};
export const ingredientEntitySearchResultSchema = z.object({
  ...searchResultFields,
  entities: z.array(ingredientSearchEntitySchema),
});
export const productEntitySearchResultSchema = z.object({
  ...searchResultFields,
  category: productCategorySchema.optional(),
  entities: z.array(productSearchEntitySchema),
});

/** One non-fatal source failure recorded during identity resolution. */
export const resolutionErrorSchema = z.object({
  database: z
    .union([databaseIdSchema, z.literal("config")])
    .describe(
      "Upstream database that failed, or 'config' when the server environment is the problem.",
    ),
  message: z
    .string()
    .describe("Actionable, database-only explanation of the failure."),
});

/** One non-fatal source failure recorded during identity resolution. */
export type ResolutionError = z.infer<typeof resolutionErrorSchema>;

/** The resolved identity graph for one ingredient. */
export const identityGraphSchema = z.object({
  subject: z.object({
    name: z.string().optional(),
    inciName: z.string().optional(),
  }),
  identifiers: ingredientIdentifiersSchema,
  links: z.array(sourceLinkSchema),
  candidates: z.array(candidateSetSchema),
  errors: z
    .array(resolutionErrorSchema)
    .optional()
    .describe(
      "Sources that failed or were misconfigured during this resolution; absent when every source answered.",
    ),
});

/** The resolved identity graph for one ingredient. */
export type IdentityGraph = z.infer<typeof identityGraphSchema>;

/** A compact count of the links and candidate sets in a result. */
export const resolveConfidenceSchema = z.object({
  directLinks: z.number().int().min(0),
  derivedLinks: z.number().int().min(0),
  candidateSets: z.number().int().min(0),
});

/** A compact count of the links and candidate sets in a result. */
export type ResolveConfidence = z.infer<typeof resolveConfidenceSchema>;

/** An ingredient-level resolution: one identity graph. */
export const ingredientResolutionSchema = z.object({
  kind: z.literal("ingredient"),
  graph: identityGraphSchema,
});

/** An ingredient-level resolution: one identity graph. */
export type IngredientResolution = z.infer<typeof ingredientResolutionSchema>;

/**
 * How much of a product's ingredient list the emitted graphs cover.
 *
 * `included` and `total` are counts of ingredient rows; `cap` is the chain's
 * per-call graph bound. `capped` is true when the result carries fewer graphs
 * than rows, whether from the chain cap or response bounding.
 */
export const graphCoverageSchema = z.object({
  included: z.number().int().min(0),
  total: z.number().int().min(0),
  cap: z.number().int().min(1),
  capped: z.boolean(),
});

/** How much of a product's ingredient list the emitted graphs cover. */
export type GraphCoverage = z.infer<typeof graphCoverageSchema>;

/** A product-level resolution: links plus the ingredient rows it carries. */
export const productResolutionSchema = z.object({
  kind: z.literal("product"),
  links: z.array(sourceLinkSchema),
  candidates: z.array(candidateSetSchema),
  ingredients: z.array(ingredientRefSchema),
  graphs: z
    .array(identityGraphSchema)
    .optional()
    .describe(
      "Graphs for an ordered prefix of `ingredients`, when resolve_ingredients was requested.",
    ),
  graphCoverage: graphCoverageSchema
    .optional()
    .describe(
      "Present with `graphs`: how many ingredient rows the graphs cover, the total, the chain cap, and whether coverage is partial.",
    ),
  errors: z
    .array(resolutionErrorSchema)
    .optional()
    .describe(
      "Sources that failed or were misconfigured while resolving this product; absent when every source answered.",
    ),
});

/** A product-level resolution: links plus the ingredient rows it carries. */
export type ProductResolution = z.infer<typeof productResolutionSchema>;

/**
 * The `drugdata_resolve_identifiers` result.
 *
 * The briefed outcome union (`ingredient` graph or `product` links/ingredients)
 * plus the shared `nextSteps` and a compact confidence count. The union is
 * discriminated on `kind`, so a host can branch without inspecting fields.
 */
export const resolveIdentifiersResultSchema = z.discriminatedUnion("kind", [
  ingredientResolutionSchema.extend({
    nextSteps: z.array(nextStepSchema),
    confidence: resolveConfidenceSchema,
  }),
  productResolutionSchema.extend({
    nextSteps: z.array(nextStepSchema),
    confidence: resolveConfidenceSchema,
  }),
]);

/** The `drugdata_resolve_identifiers` result. */
export type ResolveIdentifiersResult = z.infer<
  typeof resolveIdentifiersResultSchema
>;

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

/**
 * The RxTerms presentation fields RxNorm publishes for a concept, with the
 * RxTerms record link that credits them. The enclosing ingredient stays
 * RxNorm-owned; this nested reference is the RxTerms attribution.
 */
export const rxTermSchema = z.object({
  displayName: z.string(),
  fullName: z.string().optional(),
  brandName: z.string().optional(),
  strength: z.string().optional(),
  route: z.string().optional(),
  source: sourceRefSchema.describe(
    "The RxTerms record this presentation data came from.",
  ),
});

/** RxTerms presentation fields for a concept. */
export type RxTerm = z.infer<typeof rxTermSchema>;

/**
 * PubChem chemistry fields for a compound, as PubChem reports them (strings).
 * Kept separate from DrugCentral's structure fields, which use numbers.
 */
export const pubChemChemistrySchema = z.object({
  iupacName: z.string().optional(),
  molecularFormula: z.string().optional(),
  molecularWeight: z.string().optional(),
  inChIKey: z.string().optional(),
});

/** PubChem chemistry fields for a compound. */
export type PubChemChemistry = z.infer<typeof pubChemChemistrySchema>;

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
  sccsOpinionUrls: z.array(z.string()).optional(),
  relatedRegulations: z.array(z.string()).optional(),
  otherRegulations: z.array(z.string()).optional(),
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

  // PubChem compound chemistry (separate from DrugCentral's structure block
  // because PubChem reports values as strings).
  chemistry: pubChemChemistrySchema.optional(),

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
