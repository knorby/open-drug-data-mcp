import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { DISCLAIMER, TOOL_CHOICE_GUIDE } from "../constants.js";

/**
 * A reusable, user-invocable prompt: "research this drug or ingredient".
 *
 * Prompts are user-driven (slash commands, palette entries) rather than
 * model-driven, which makes this the place to teach the whole loop at once:
 * search by name, resolve an identifier across sources, then fetch the full
 * record from the database that owns it. The caller's value is threaded into
 * the prompt, and the prompt deliberately does not guess its type — an NDC, a
 * UNII, a CAS number, and a name all take different first calls.
 */

/** Registers the `research_drug` prompt. */
export function registerResearchDrugPrompt(server: McpServer): void {
  server.registerPrompt(
    "research_drug",
    {
      title: "Research a drug, supplement, or cosmetic",
      description:
        "Research a product or ingredient across openFDA, CosIng, RxNorm/DailyMed, DrugCentral, NIH DSLD, INKEEDecoder, and PubChem: search by name or identifier, resolve identity across sources, and fetch selected records with citations.",
      argsSchema: z.object({
        name_or_identifier: z
          .string()
          .min(1)
          .max(200)
          .describe(
            'What to research: a product or ingredient name, an NDC, UNII, RxCUI, PubChem CID, CAS or EC number, an INCI name, an SPL set id, or a DSLD label id — for example "atorvastatin" or "00093-1046".',
          ),
        context: z
          .string()
          .max(2_000)
          .optional()
          .describe(
            'Optional context or question to weigh the research toward, for example "compare it with rosuvastatin" or "is it safe in pregnancy?".',
          ),
      }),
    },
    ({ name_or_identifier, context }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Research this using the Open Drug Data tools: ${name_or_identifier}`,
              ...(context === undefined
                ? []
                : ["", `User context: ${context}`]),
              "",
              "Work through it like this:",
              TOOL_CHOICE_GUIDE,
              "1. Identify what you have. An identifier — an NDC, UNII, RxCUI, PubChem CID, CAS number, INCI name, SPL setid, or DSLD id — goes to drugdata_resolve_identifiers with exactly one matching argument (ndc, unii, rxcui, cid, cas, inci_name, spl_setid, or dsld_id). A name goes to drugdata_search_products (types: name, brand, ingredient, barcode, ndc) or drugdata_search_ingredients (types: name, inci, unii, cas, ec, rxcui, cid). If several records plausibly match, list them with names and source links and ask which one is meant; do not guess.",
              "2. Read the result carefully. In resolve output, links are trusted matches (direct means the same identifier, derived a documented crosswalk); candidates are possible matches that need judgment. Follow the nextSteps calls the result returns instead of inventing an identifier.",
              "3. Fetch selected records with drugdata_get_product (sources: openfda, dsld, dailymed, inkeedecoder) or drugdata_get_ingredient (sources: openfda, cosing, drugcentral, nlm, inkeedecoder, pubchem), using the database's own id from the result. Turn on costly flags only when the question needs them.",
              "4. Report back: what the record is, the identifiers that establish its identity, the key facts with units, and the upstream database and deep link behind each claim. Summarize regulatory or label text rather than republishing it.",
              "5. Say what could not be confirmed: a source that was unavailable, a candidate left unresolved, or an identifier no database knows. Zero matches are a normal result, not an error.",
              "",
              `Cite the upstream database and deep link in the answer. ${DISCLAIMER}`,
            ].join("\n"),
          },
        },
      ],
    }),
  );
}
