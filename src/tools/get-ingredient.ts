import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { SourceInputError, SourceRoutingError } from "../lib/errors.js";
import {
  applyCharacterLimit,
  boundStructured,
  formatJson,
  RESPONSE_FORMATS,
  truncationNote,
} from "../lib/format.js";
import { isUnii, normalizeSlug } from "../lib/ids.js";
import { ingredientDetailNextSteps } from "../lib/next-steps.js";
import {
  type DatabaseId,
  type IngredientClinical,
  type IngredientDetail,
  type IngredientProfile,
  type IngredientRef,
  ingredientDetailSchema,
  ingredientProfileSchema,
  ingredientRefSchema,
  ingredientRegulatorySchema,
  type RecordLink,
} from "../lib/schemas.js";
import { DRUGCENTRAL_IDENTIFIER_TYPES } from "../sources/drugcentral.js";
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
 * `drugdata_get_ingredient` — one ingredient record from the database that
 * owns it.
 *
 * The registry routes the lookup, so this module owns the tool-level parts:
 * rejecting identifiers that cannot belong to the named database, normalizing
 * the ones that can, validating the adapter's record into the closed
 * ingredient-detail schema, deriving follow-up calls, and rendering.
 *
 * The two cost flags are source-specific on purpose. `include_clinical` makes
 * DrugCentral fetch indications, off-label uses, contraindications, and FAERS
 * signals (extra requests, often verbose); `include_cosing_panel` includes
 * INKEEDecoder's CosIng panel (CAS/EC/IUPAC) from the same page fetch. Both
 * default false, and neither changes the other sources.
 */

/** Databases that can answer an ingredient lookup, in the tool's spelling. */
export const INGREDIENT_SOURCES = [
  "openfda",
  "cosing",
  "drugcentral",
  "nlm",
  "inkeedecoder",
] as const;

/** Databases that can answer an ingredient lookup. */
export type IngredientSource = (typeof INGREDIENT_SOURCES)[number];

/** The registry's database label for each tool source value. */
const SOURCE_DATABASES: Readonly<Record<IngredientSource, DatabaseId>> = {
  openfda: "openFDA",
  cosing: "CosIng",
  drugcentral: "DrugCentral",
  nlm: "RxNorm",
  inkeedecoder: "INKEEDecoder",
};

/** A CAS Registry Number, in the conventional dashed spelling. */
const CAS = /^\d{2,7}-\d{2}-\d$/;

/** A caller-supplied crosswalk identifier, e.g. `DRUGBANK_ID:DB00945`. */
const PREFIXED_IDENTIFIER = /^([A-Za-z][A-Za-z0-9_]{1,30}):(\S+)$/;

const DESCRIPTION =
  "Fetch one ingredient profile from openFDA, CosIng, DrugCentral, RxNorm, or INKEEDecoder. The `id` is the database's own key: a UNII or dashed CAS number (openfda), a numeric substance id or exact INCI/glossary name (cosing), a numeric structure id, UNII, dashed CAS number, or a supported TYPE:value crosswalk identifier (drugcentral), a numeric RxCUI (nlm), or an ingredient slug/URL (inkeedecoder). The result carries the unified ingredient ref, the source's profile fields and identifier crosswalk, verbatim regulatory notices where the source publishes them, links, and suggested follow-up calls. `include_clinical` asks DrugCentral for indications, off-label uses, contraindications, and FAERS counts — extra requests, verbose, default false. `include_cosing_panel` asks INKEEDecoder to include its CosIng CAS/EC/IUPAC panel from the same page fetch — no extra request, default false. A malformed id is an error result naming the search tool that finds a valid one; an upstream miss is an error result, not an empty profile.";

const inputSchema = z.object({
  source: z
    .enum(INGREDIENT_SOURCES, {
      error: `source must be one of: ${INGREDIENT_SOURCES.join(", ")}.`,
    })
    .describe(
      "Upstream database that owns the record: 'openfda', 'cosing', 'drugcentral', 'nlm', or 'inkeedecoder'.",
    ),
  id: z
    .string()
    .trim()
    .max(300)
    .describe(
      "The database's own identifier: UNII or dashed CAS (openfda), substance id or INCI/glossary name (cosing), structure id, UNII, CAS, or TYPE:value crosswalk id (drugcentral), numeric RxCUI (nlm), or slug/URL (inkeedecoder).",
    ),
  include_clinical: z
    .boolean()
    .default(false)
    .describe(
      "DrugCentral only: fetch indications, off-label uses, contraindications, and FAERS counts. Extra requests and often verbose — default false.",
    ),
  include_cosing_panel: z
    .boolean()
    .default(false)
    .describe(
      "INKEEDecoder only: include the CosIng panel (CAS numbers, EC numbers, IUPAC name) from the same page fetch — no extra request. Default false.",
    ),
  response_format: z
    .enum(RESPONSE_FORMATS)
    .default("markdown")
    .describe(
      "Text format: 'markdown' for a readable profile, or 'json' for the structured result serialized as JSON.",
    ),
});

type GetIngredientInput = z.infer<typeof inputSchema>;

/** A normalized lookup id, or the model-facing reason it is unusable. */
type PreparedId = { ok: true; id: string } | { ok: false; error: string };

/** The adapter record shape this tool accepts, with unknown keys stripped. */
const sourceRecordSchema = z.object({
  ingredient: ingredientRefSchema,
  profile: ingredientProfileSchema,
  regulatory: ingredientRegulatorySchema.optional(),
});

/** Rejects an id with advice naming the search tool that finds a valid one. */
function invalidId(
  source: string,
  received: string,
  expected: string,
): PreparedId {
  return {
    ok: false,
    error: `Error: drugdata_get_ingredient — source "${source}" ${expected}. Received "${received}". Use drugdata_search_ingredients to find a valid identifier, then pass it unchanged.`,
  };
}

/**
 * Validates and normalizes a caller-supplied id for its database.
 *
 * Shape checks happen before any request, so a URL pasted into the wrong
 * source or a product NDC handed to an ingredient lookup fails with the search
 * tool that would find the right record instead of an upstream 404.
 */
export function prepareIngredientId(
  source: IngredientSource,
  rawId: string,
): PreparedId {
  const id = rawId.trim();
  if (id.length === 0) {
    return invalidId(source, rawId, "expects a non-empty identifier");
  }

  switch (source) {
    case "openfda": {
      if (isUnii(id)) return { ok: true, id: id.toUpperCase() };
      return CAS.test(id)
        ? { ok: true, id }
        : invalidId(
            source,
            id,
            "expects a UNII (10 letters or digits) or a dashed CAS number",
          );
    }
    case "cosing": {
      if (/^\d+$/.test(id)) {
        const numeric = Number(id);
        return Number.isSafeInteger(numeric) && numeric > 0
          ? { ok: true, id: String(numeric) }
          : invalidId(source, id, "expects a positive numeric substance id");
      }
      return id.length <= 200 && !/[/:?#]/.test(id)
        ? { ok: true, id }
        : invalidId(
            source,
            id,
            "expects a numeric substance id or an exact INCI/glossary name",
          );
    }
    case "drugcentral": {
      if (/^\d+$/.test(id)) {
        const numeric = Number(id);
        return Number.isSafeInteger(numeric) && numeric > 0
          ? { ok: true, id: String(numeric) }
          : invalidId(source, id, "expects a positive numeric structure id");
      }
      if (isUnii(id)) return { ok: true, id: id.toUpperCase() };
      if (CAS.test(id)) return { ok: true, id };
      const prefixed = PREFIXED_IDENTIFIER.exec(id);
      if (prefixed !== null) {
        const type = (prefixed[1] as string).toUpperCase();
        return DRUGCENTRAL_IDENTIFIER_TYPES.includes(type)
          ? { ok: true, id }
          : {
              ok: false,
              error: `Error: drugdata_get_ingredient — source "drugcentral" does not support crosswalk type "${prefixed[1]}". Supported types: ${DRUGCENTRAL_IDENTIFIER_TYPES.join(", ")}. Pass identifiers.structId from a DrugCentral result, or use drugdata_search_ingredients to find a valid identifier.`,
            };
      }
      return invalidId(
        source,
        id,
        'expects a numeric structure id, a UNII, a dashed CAS number, or a supported "TYPE:value" crosswalk identifier',
      );
    }
    case "nlm": {
      if (/^\d+$/.test(id)) {
        const numeric = Number(id);
        return Number.isSafeInteger(numeric) && numeric > 0
          ? { ok: true, id: String(numeric) }
          : invalidId(source, id, "expects a positive numeric RxCUI");
      }
      return invalidId(source, id, "expects a numeric RxCUI");
    }
    case "inkeedecoder": {
      try {
        return { ok: true, id: normalizeSlug(id) };
      } catch (error) {
        // normalizeSlug is the only thrower here and always throws Error.
        const reason = (error as Error).message;
        return {
          ok: false,
          error: `Error: drugdata_get_ingredient — ${reason} Use drugdata_search_ingredients to find an INKEEDecoder ingredient slug, then pass it unchanged.`,
        };
      }
    }
  }
}

/** Identifier labels in the order the markdown text shows them. */
const IDENTIFIER_FIELDS: ReadonlyArray<
  IdentifierField<IngredientRef["identifiers"]>
> = [
  ["unii", "UNII"],
  ["cas", "CAS"],
  ["ec", "EC"],
  ["rxcui", "RxCUI"],
  ["structId", "DrugCentral structure"],
  ["cid", "PubChem CID"],
  ["inchiKey", "InChIKey"],
  ["slug", "slug"],
];

/** A non-blank string, trimmed, or `undefined` when absent or blank. */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/** Adds one `Label: value` part when a value is present. */
function pushPart(
  parts: string[],
  value: string | number | undefined,
  label?: string,
): void {
  if (value === undefined) return;
  const text = String(value);
  if (text.trim().length === 0) return;
  parts.push(label === undefined ? text : `${label}: ${text}`);
}

/** Renders a titled bullet list block. */
function bullets(title: string, lines: readonly string[]): string | undefined {
  if (lines.length === 0) return undefined;
  return [
    `### ${title} (${lines.length})`,
    ...lines.map((line) => `- ${line}`),
  ].join("\n");
}

/** Renders a named string list, omitting blanks. */
function namesList(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => nonEmpty(value))
    .filter((value): value is string => value !== undefined);
}

/** Renders the openFDA substance sections. */
function openFdaSections(profile: IngredientProfile): string[] {
  const blocks: string[] = [];
  const names = (profile.names ?? []).map((entry) => {
    const parts = [entry.name];
    if (entry.type !== undefined) parts.push(`type ${entry.type}`);
    if (entry.preferred === true) parts.push("preferred");
    if (entry.displayName === true) parts.push("display name");
    if (entry.organizations.length > 0) {
      parts.push(`organizations: ${entry.organizations.join(", ")}`);
    }
    return parts.join(" · ");
  });
  const nameBlock = bullets("Names", names);
  if (nameBlock !== undefined) blocks.push(nameBlock);

  const codes = (profile.codes ?? []).map((entry) =>
    [`${entry.system}: ${entry.code}`, entry.type]
      .filter((part): part is string => part !== undefined)
      .join(" · "),
  );
  const codeBlock = bullets("Codes", codes);
  if (codeBlock !== undefined) blocks.push(codeBlock);

  const relationships = (profile.relationships ?? []).map((entry) => {
    const parts: string[] = [];
    pushPart(parts, entry.type, "type");
    pushPart(parts, entry.qualification);
    pushPart(parts, entry.relatedName, "related");
    pushPart(parts, entry.relatedUnii, "UNII");
    pushPart(parts, entry.relatedSubstanceClass, "class");
    return parts.join(" · ");
  });
  const relationshipBlock = bullets("Relationships", relationships);
  if (relationshipBlock !== undefined) blocks.push(relationshipBlock);

  return blocks;
}

/** Renders the CosIng inventory sections. */
function cosingSections(profile: IngredientProfile): string[] {
  const blocks: string[] = [];
  const identity: string[] = [];
  pushPart(identity, nonEmpty(profile.glossaryName), "Glossary name");
  pushPart(identity, nonEmpty(profile.inciName), "INCI name");
  pushPart(identity, nonEmpty(profile.innName), "INN");
  pushPart(identity, nonEmpty(profile.inciUsaName), "INCI USA");
  pushPart(identity, nonEmpty(profile.phEurName), "Ph. Eur.");
  pushPart(identity, nonEmpty(profile.chemicalName), "Chemical name");
  pushPart(identity, nonEmpty(profile.status), "Status");
  if (profile.functions !== undefined && profile.functions.length > 0) {
    identity.push(`Functions: ${profile.functions.join(", ")}`);
  }
  if (profile.annexNumbers !== undefined && profile.annexNumbers.length > 0) {
    identity.push(`Annex: ${profile.annexNumbers.join(", ")}`);
  }
  if (
    profile.identifiedIngredientIds !== undefined &&
    profile.identifiedIngredientIds.length > 0
  ) {
    identity.push(
      `Annex substance ids: ${profile.identifiedIngredientIds.join(", ")}`,
    );
  }
  if (profile.perfuming !== undefined) {
    identity.push(`Perfuming: ${profile.perfuming ? "yes" : "no"}`);
  }
  if (profile.officialJournalPublication !== undefined) {
    identity.push(
      `Official Journal publication: ${profile.officialJournalPublication ? "yes" : "no"}`,
    );
  }
  if (identity.length > 0)
    blocks.push(
      ["### CosIng inventory", ...identity.map((line) => `- ${line}`)].join(
        "\n",
      ),
    );

  const description = nonEmpty(profile.chemicalDescription);
  if (description !== undefined) {
    blocks.push(`### Chemical description (verbatim)\n\n${description}`);
  }
  const notes = namesList(profile.notes);
  if (notes.length > 0) {
    blocks.push(
      [
        `### Notes (verbatim) (${notes.length})`,
        ...notes.map((note) => `- ${note}`),
      ].join("\n"),
    );
  }
  const related = namesList(profile.relatedRegulations);
  const relatedBlock = bullets("Related regulations (verbatim)", related);
  if (relatedBlock !== undefined) blocks.push(relatedBlock);
  const other = namesList(profile.otherRegulations);
  const otherBlock = bullets("Other regulations (verbatim)", other);
  if (otherBlock !== undefined) blocks.push(otherBlock);
  return blocks;
}

/** Renders one drug-condition list. */
function conditionLines(
  rows: readonly {
    name: string;
    relationship: string;
    conceptId?: number;
    snomedConceptId?: string;
    umlsCui?: string;
  }[],
): string[] {
  return rows.map((row) => {
    const references: string[] = [];
    pushPart(references, row.conceptId, "concept");
    pushPart(references, row.snomedConceptId, "SNOMED");
    pushPart(references, row.umlsCui, "UMLS");
    const suffix = references.length > 0 ? ` (${references.join("; ")})` : "";
    return `${row.name} — ${row.relationship}${suffix}`;
  });
}

/** Renders the DrugCentral profile and clinical sections. */
function drugCentralSections(profile: IngredientProfile): string[] {
  const blocks: string[] = [];
  const identity: string[] = [];
  pushPart(identity, profile.structId, "Structure id");
  pushPart(identity, nonEmpty(profile.cas), "Primary CAS");
  pushPart(identity, nonEmpty(profile.inchiKey), "InChIKey");
  pushPart(identity, profile.cid, "PubChem CID");
  pushPart(identity, nonEmpty(profile.formula), "Formula");
  pushPart(identity, profile.molecularWeight, "Molecular weight");
  pushPart(identity, nonEmpty(profile.status), "Status");
  if (identity.length > 0) {
    blocks.push(
      ["### Structure", ...identity.map((line) => `- ${line}`)].join("\n"),
    );
  }

  const crosswalk = (profile.identifiers ?? []).map(
    (row) => `${row.type}: ${row.value}`,
  );
  const crosswalkBlock = bullets("Identifier crosswalk", crosswalk);
  if (crosswalkBlock !== undefined) blocks.push(crosswalkBlock);

  const atc = namesList(profile.atc);
  const atcBlock = bullets("ATC codes", atc);
  if (atcBlock !== undefined) blocks.push(atcBlock);

  const synonyms = namesList(profile.synonyms);
  const synonymBlock = bullets("Synonyms", synonyms);
  if (synonymBlock !== undefined) blocks.push(synonymBlock);

  const clinical = profile.clinical;
  if (clinical !== undefined) {
    const indicationBlock = bullets(
      "Indications (source assertions)",
      conditionLines(clinical.indications),
    );
    if (indicationBlock !== undefined) blocks.push(indicationBlock);
    const offLabelBlock = bullets(
      "Off-label uses (source assertions)",
      conditionLines(clinical.offLabelUses),
    );
    if (offLabelBlock !== undefined) blocks.push(offLabelBlock);
    const contraindicationBlock = bullets(
      "Contraindications (source assertions)",
      conditionLines(clinical.contraindications),
    );
    if (contraindicationBlock !== undefined) blocks.push(contraindicationBlock);

    const faers = clinical.faers.map((signal) => {
      const parts = [signal.term];
      pushPart(parts, signal.llr, "LLR");
      pushPart(parts, signal.llrThreshold, "threshold");
      pushPart(parts, signal.drugAe, "drug + event");
      pushPart(parts, signal.drugNoAe, "drug, no event");
      pushPart(parts, signal.noDrugAe, "no drug, event");
      pushPart(parts, signal.noDrugNoAe, "no drug, no event");
      return `${parts.join(" · ")} (${signal.population})`;
    });
    if (faers.length > 0) {
      blocks.push(
        [
          `### FAERS signals (${faers.length})`,
          "_Report contingencies from the all-population stratum — not incidence rates and not causality._",
          ...faers.map((line) => `- ${line}`),
        ].join("\n"),
      );
    } else {
      blocks.push(
        "### FAERS signals (0)\n\n_No signal rows were returned; that is not evidence of no risk._",
      );
    }
    if (clinical.truncated) {
      blocks.push(
        "_Clinical lists were capped. Narrow the request or consult DrugCentral for the complete set._",
      );
    }
  }
  return blocks;
}

/** Renders the RxNorm profile sections. */
function rxNormSections(profile: IngredientProfile): string[] {
  const blocks: string[] = [];
  const identity: string[] = [];
  pushPart(identity, nonEmpty(profile.rxcui), "RxCUI");
  pushPart(identity, nonEmpty(profile.tty), "Term type");
  pushPart(identity, nonEmpty(profile.synonym), "Synonym");
  const term = profile.rxTerm;
  if (term !== undefined) {
    pushPart(identity, term.displayName, "Display name");
    pushPart(identity, term.fullName, "Full name");
    pushPart(identity, term.brandName, "Brand name");
    pushPart(identity, term.strength, "Strength");
    pushPart(identity, term.route, "Route");
  }
  if (identity.length > 0) {
    blocks.push(
      ["### RxNorm concept", ...identity.map((line) => `- ${line}`)].join("\n"),
    );
  }
  const ndcs = namesList(profile.ndcs);
  const ndcBlock = bullets("NDC crosswalk", ndcs);
  if (ndcBlock !== undefined) blocks.push(ndcBlock);
  return blocks;
}

/** Renders the INKEEDecoder page sections. */
function inkeeSections(profile: IngredientProfile): string[] {
  const blocks: string[] = [];
  const identity: string[] = [];
  if (profile.functions !== undefined && profile.functions.length > 0) {
    identity.push(`Functions: ${profile.functions.join(", ")}`);
  }
  pushPart(identity, nonEmpty(profile.alsoCalled), "Also called");
  pushPart(identity, nonEmpty(profile.irritancy), "Irritancy");
  pushPart(identity, nonEmpty(profile.comedogenicity), "Comedogenicity");
  pushPart(identity, nonEmpty(profile.cosingFunctions), "CosIng functions");
  pushPart(identity, nonEmpty(profile.iupacName), "IUPAC name");
  if (identity.length > 0) {
    blocks.push(
      ["### Page profile", ...identity.map((line) => `- ${line}`)].join("\n"),
    );
  }
  const details = nonEmpty(profile.details);
  if (details !== undefined) {
    blocks.push(`### Page write-up (verbatim)\n\n${details}`);
  }
  const proof = namesList(profile.proof);
  const proofBlock = bullets("References (verbatim)", proof);
  if (proofBlock !== undefined) blocks.push(proofBlock);
  return blocks;
}

/** Profile sections for the database that answered. */
function profileSections(
  source: DatabaseId,
  profile: IngredientProfile,
): string[] {
  switch (source) {
    case "openFDA":
      return openFdaSections(profile);
    case "CosIng":
      return cosingSections(profile);
    case "DrugCentral":
      return drugCentralSections(profile);
    case "RxNorm":
      return rxNormSections(profile);
    case "INKEEDecoder":
      return inkeeSections(profile);
    default:
      return [];
  }
}

/** Cross-database links a profile can offer beyond its own record. */
function ingredientLinks(
  ingredient: IngredientRef,
  profile: IngredientProfile,
): RecordLink[] {
  const links: RecordLink[] = [
    {
      label: `${ingredient.source.database} record`,
      url: ingredient.source.url,
    },
  ];
  const seen = new Set(links.map((link) => link.url));
  const add = (label: string, url: string): void => {
    if (seen.has(url)) return;
    seen.add(url);
    links.push({ label, url });
  };

  const structId = profile.structId ?? ingredient.identifiers.structId;
  if (structId !== undefined && ingredient.source.database !== "DrugCentral") {
    add(
      "DrugCentral structure",
      `https://drugcentral.org/drugcard/${structId}`,
    );
  }

  const rxcui = ingredient.identifiers.rxcui?.[0];
  if (rxcui !== undefined && ingredient.source.database !== "RxNorm") {
    add(
      "RxNorm concept",
      `https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm=${encodeURIComponent(
        rxcui,
      )}`,
    );
  }

  const slug = ingredient.identifiers.slug;
  if (slug !== undefined && ingredient.source.database !== "INKEEDecoder") {
    add(
      "INKEEDecoder ingredient",
      `https://inkeedecoder.com/ingredients/${encodeURIComponent(slug)}`,
    );
  }

  for (const url of profile.sccsOpinionUrls ?? []) {
    add("SCCS opinion", url);
  }

  return links;
}

/** Whether bounding shortened any clinical content. */
function clinicalShortened(
  before: IngredientClinical | undefined,
  after: IngredientClinical | undefined,
): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

/** Renders one ingredient detail as markdown. */
function renderMarkdown(output: IngredientDetail, truncated: boolean): string {
  const { ingredient, profile } = output;
  const identityLines = [`## ${ingredient.name}`];
  if (ingredient.inciName !== undefined) {
    identityLines.push(`- INCI: ${ingredient.inciName}`);
  }
  const identifiers = identifierText(ingredient.identifiers, IDENTIFIER_FIELDS);
  if (identifiers !== undefined) {
    identityLines.push(`- Identifiers: ${identifiers}`);
  }
  if (ingredient.summary !== undefined) {
    identityLines.push(`- Summary: ${ingredient.summary}`);
  }
  identityLines.push(
    `- Source: ${ingredient.source.url} (retrieved ${ingredient.source.retrievedAt})`,
  );

  const blocks: string[] = [
    `Ingredient profile — ${ingredient.source.database} (${ingredient.source.id}).`,
    identityLines.join("\n"),
    ...profileSections(ingredient.source.database, profile),
  ];

  if (output.regulatory !== undefined && output.regulatory.notices.length > 0) {
    blocks.push(
      [
        `## Regulatory notices (verbatim) (${output.regulatory.notices.length})`,
        ...output.regulatory.notices.map(
          (notice) =>
            `- ${notice.text} — basis: ${notice.basis}; source: ${notice.source}`,
        ),
      ].join("\n"),
    );
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
  if (truncated) text += truncationNote();
  return text;
}

/** Registers the `drugdata_get_ingredient` tool. */
export function registerGetIngredientTool(
  server: McpServer,
  registry?: Registry,
): void {
  server.registerTool(
    "drugdata_get_ingredient",
    {
      title: "Get one ingredient profile from an open drug data source",
      description: DESCRIPTION,
      inputSchema,
      outputSchema: ingredientDetailSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (
      {
        source,
        id,
        include_clinical,
        include_cosing_panel,
        response_format,
      }: GetIngredientInput,
      ctx,
    ) => {
      try {
        const prepared = prepareIngredientId(source, id);
        if (!prepared.ok) return messageError(prepared.error);

        const resolved = resolveRegistry(registry);
        if (!resolved.ok) return messageError(resolved.error);

        const raw = await resolved.registry.getIngredient(
          SOURCE_DATABASES[source],
          prepared.id,
          {
            includeClinical: include_clinical,
            includeCosingPanel: include_cosing_panel,
          },
          ctx.mcpReq.signal,
        );
        const record = sourceRecordSchema.parse(raw);

        const skeleton = ingredientDetailSchema.parse({
          ingredient: record.ingredient,
          profile: record.profile,
          ...(record.regulatory !== undefined
            ? { regulatory: record.regulatory }
            : {}),
          links: ingredientLinks(record.ingredient, record.profile),
          nextSteps: [],
        });

        // Bound first, then derive follow-ups from what the rendered detail
        // actually contains, so a dropped field cannot leave a step pointing
        // at something the model cannot see.
        const bounded = boundStructured(skeleton);
        const withSteps = ingredientDetailSchema.parse({
          ...bounded.value,
          nextSteps: ingredientDetailNextSteps(bounded.value.ingredient),
        });
        const final = boundStructured(withSteps);
        const clinicalWasShortened = clinicalShortened(
          skeleton.profile.clinical,
          final.value.profile.clinical,
        );
        const withClinicalFlag =
          final.value.profile.clinical !== undefined &&
          !final.value.profile.clinical.truncated &&
          clinicalWasShortened
            ? ingredientDetailSchema.parse({
                ...final.value,
                profile: {
                  ...final.value.profile,
                  clinical: {
                    ...final.value.profile.clinical,
                    truncated: true,
                  },
                },
              })
            : final.value;
        const value = boundStructured(withClinicalFlag).value;
        const truncated = bounded.truncated || final.truncated;

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
              text: applyCharacterLimit(renderMarkdown(value, truncated)),
            },
          ],
          structuredContent: value,
        };
      } catch (error) {
        if (
          error instanceof SourceInputError ||
          error instanceof SourceRoutingError
        ) {
          return messageError(
            `Error: drugdata_get_ingredient — ${error.message}`,
          );
        }
        return toolError(error, `the ${source} ingredient lookup`);
      }
    },
  );
}
