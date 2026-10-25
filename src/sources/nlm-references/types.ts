import * as z from "zod/v4";
import { databaseIdSchema, sourceRefSchema } from "../../lib/schemas.js";

/**
 * Types and output schemas for the NLM reference searches.
 *
 * `drugdata_search_references` covers the NLM surfaces that are neither
 * product/ingredient records nor identity bridges: terminology lookups
 * (Prescribable RxNorm, RxClass, MeSH, UMLS), consumer-health pages
 * (MedlinePlus), and the literature (PubMed, ClinicalTrials.gov). Each
 * returns links back to the upstream record — per the sourcing posture, a
 * link is a valid result, and only titles, identifiers, and dates are
 * extracted.
 *
 * A reference search always answers from exactly one source, so its result
 * is one group, not a fan-out.
 */

/** The NLM reference surfaces the tool exposes. */
export const REFERENCE_SOURCES = [
  "prescribable",
  "rxclass",
  "mesh",
  "pubmed",
  "medlineplus",
  "medlineplus_genetics",
  "medlineplus_connect",
  "umls",
  "clinicaltrials",
] as const;

export type ReferenceSourceId = (typeof REFERENCE_SOURCES)[number];

/** What kind of value the `query` holds. */
export const REFERENCE_TYPES = ["name", "rxcui", "ndc", "cui"] as const;

export type ReferenceTypeId = (typeof REFERENCE_TYPES)[number];

/** Which query types each source accepts; checked before any network call. */
export const ALLOWED_REFERENCE_TYPES: Record<
  ReferenceSourceId,
  readonly ReferenceTypeId[]
> = {
  prescribable: ["name", "rxcui"],
  rxclass: ["name", "rxcui"],
  mesh: ["name"],
  pubmed: ["name"],
  medlineplus: ["name"],
  medlineplus_genetics: ["name"],
  medlineplus_connect: ["name", "rxcui", "ndc"],
  umls: ["name", "cui"],
  clinicaltrials: ["name"],
};

/**
 * One referenced upstream record: what it is, where it lives, and the
 * identifiers that name it. Titles are kept short (upstream title text);
 * bodies are never extracted — the link is the result.
 */
export const referenceSchema = z.object({
  kind: z.enum([
    "drug",
    "class",
    "descriptor",
    "article",
    "health_topic",
    "genetics",
    "terminology",
    "trial",
  ]),
  title: z.string().optional(),
  publicationDate: z
    .string()
    .optional()
    .describe("Publication date as the source states it, e.g. '2020 Jan'."),
  source: sourceRefSchema,
  identifiers: z.object({
    rxcui: z.string().optional(),
    classId: z.string().optional(),
    classType: z.string().optional(),
    meshId: z.string().optional(),
    pmid: z.string().optional(),
    cui: z.string().optional(),
    nctId: z.string().optional(),
  }),
  dataset: z
    .string()
    .optional()
    .describe(
      "Named subset of the database, e.g. 'Prescribable' for the prescribable RxNorm dataset.",
    ),
});

/** One referenced upstream record. */
export type Reference = z.infer<typeof referenceSchema>;

/**
 * The single source group a reference search returns.
 *
 * `error` replaces the items when the source failed; `limitation` documents
 * an upstream constraint the caller should know (for example that the source
 * reports no totals, so `hasMore` is conservative).
 */
export const referenceGroupSchema = z.object({
  source: databaseIdSchema,
  items: z.array(referenceSchema),
  hasMore: z.boolean(),
  nextCursor: z
    .string()
    .optional()
    .describe("Opaque continuation token; pass back as `cursor`."),
  total: z.number().int().optional(),
  error: z.string().optional(),
  limitation: z.string().optional(),
});

/** The single source group a reference search returns. */
export type ReferenceGroup = z.infer<typeof referenceGroupSchema>;

/** The validated input one reference handler executes. */
export interface ReferenceSearchInput {
  source: ReferenceSourceId;
  type: ReferenceTypeId;
  query: string;
  limit: number;
  cursor?: string;
}

/**
 * One reference source's search.
 *
 * Handlers own their cursors: they decode the opaque token themselves (via
 * {@link ../nlm-references/cursor.js}) and return `nextCursor` only when
 * another page genuinely exists. `signal` carries the host's cancellation.
 */
export type ReferenceHandler = (
  input: ReferenceSearchInput,
  signal?: AbortSignal,
) => Promise<ReferenceGroup>;
