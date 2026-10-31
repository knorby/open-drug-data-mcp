import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { readConfig } from "../config.js";
import { applyCharacterLimit, RESPONSE_FORMATS } from "../lib/format.js";
import {
  type IngredientIdentifiers,
  type IngredientRef,
  ingredientEntitySearchResultSchema,
} from "../lib/schemas.js";
import type { IdentityResolver } from "../sources/identity/chain.js";
import { createSearchCoordinator } from "../sources/search/coordinator.js";
import { INGREDIENT_SEARCH_TYPES, type Registry } from "../sources/types.js";
import {
  boundEntitySearch,
  entityJsonBlocks,
  renderEntitySearch,
} from "./entity-search-support.js";
import { resolveResolver } from "./resolve-identifiers.js";
import {
  type IdentifierField,
  identifierText,
  messageError,
  resolveRegistry,
  toolError,
  type ZeroResultsContext,
} from "./search-support.js";

/**
 * `drugdata_search_ingredients` — one ingredient search across every capable
 * source.
 *
 * The coordinator owns fan-out and bounded enrichment; this module validates
 * the closed entity contract and renders markdown or JSON.
 */

const DESCRIPTION =
  "Search ingredients across openFDA, CosIng, DrugCentral, RxNorm, PubChem, and INKEEDecoder. Start free text with type 'name'; use inci, unii, cas, ec, rxcui, or cid when that is the value you have. There is no ingredient category filter. Returns evidence-grouped entities with original records, confirmed links, source-attributed conflicts, unconfirmed candidates, and per-entity nextSteps. For source+id use drugdata_get_ingredient instead. Search enriches at most five entities, concurrency three, within a shared 45-second default deadline. Read partial, coverage, and sources (status ok/error/timeout); completed results survive a timeout. One page applies to every source and re-queries all of them; each source's hasMore is independent. Selectively fetch supplied URLs only when more page content is needed. No matches is normal, not an error.";

const inputSchema = z.object({
  type: z
    .enum(INGREDIENT_SEARCH_TYPES)
    .describe(
      "What to search by: 'name', 'inci' (INCI name), 'unii', 'cas' (CAS Registry Number), 'ec' (EC number), 'rxcui' (RxNorm concept id), or 'cid' (PubChem compound id).",
    ),
  query: z
    .string()
    .min(1)
    .max(200)
    .describe("The search value, as text or an identifier."),
  page: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe(
      "Page number for the fan-out, starting at 1. One page applies to every source and re-queries all of them.",
    ),
  response_format: z
    .enum(RESPONSE_FORMATS)
    .default("markdown")
    .describe(
      "Text format: 'markdown' for a readable grouped report, or 'json' for the structured result serialized as JSON.",
    ),
});

const outputSchema = ingredientEntitySearchResultSchema;

type IngredientSearchInput = z.infer<typeof inputSchema>;

/** Empty-result advice for a tool that has no category filter. */
const ZERO_CONTEXT: ZeroResultsContext = {
  kind: "ingredient",
  hasCategory: false,
};

/** Identifier labels in the order the markdown text shows them. */
const IDENTIFIER_FIELDS: ReadonlyArray<IdentifierField<IngredientIdentifiers>> =
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

/** Registers the `drugdata_search_ingredients` tool. */
export function registerSearchIngredientsTool(
  server: McpServer,
  registry?: Registry,
  resolver?: IdentityResolver,
): void {
  server.registerTool(
    "drugdata_search_ingredients",
    {
      title: "Search ingredients across open drug and cosmetic data sources",
      description: DESCRIPTION,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (
      { type, query, page, response_format }: IngredientSearchInput,
      ctx,
    ) => {
      try {
        const resolved = resolveRegistry(registry);
        if (!resolved.ok) return messageError(resolved.error);

        const identity = resolveResolver(resolver);
        if (!identity.ok) return messageError(identity.error);
        const config = readConfig();
        if (!config.ok) return messageError(config.error);
        const output = outputSchema.parse(
          await createSearchCoordinator({
            registry: resolved.registry,
            resolver: identity.resolver,
            timeoutMs: config.config.DRUGDATA_SEARCH_TIMEOUT_MS,
          }).searchIngredients({ type, query, page }, ctx.mcpReq.signal),
        );
        const bounded = boundEntitySearch(output);

        if (response_format === "json") {
          return {
            content: entityJsonBlocks(
              bounded.value,
              ZERO_CONTEXT,
              bounded.truncated,
            ),
            structuredContent: bounded.value,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: applyCharacterLimit(
                renderEntitySearch(
                  bounded.value,
                  ZERO_CONTEXT,
                  bounded.truncated,
                  ingredientLine,
                ),
              ),
            },
          ],
          structuredContent: bounded.value,
        };
      } catch (error) {
        return toolError(error, `the ${type} ingredient search`);
      }
    },
  );
}

/** Renders one ingredient as a compact list line. */
function ingredientLine(item: IngredientRef): string {
  const details = [`**${item.name}**`];
  if (item.inciName !== undefined && item.inciName !== item.name) {
    details.push(`INCI: ${item.inciName}`);
  }
  if (item.role !== undefined) details.push(`role: ${item.role}`);
  if (item.quantity !== undefined) details.push(`quantity: ${item.quantity}`);
  const identifiers = identifierText(item.identifiers, IDENTIFIER_FIELDS);
  if (identifiers !== undefined) details.push(identifiers);
  if (item.matchBasis !== undefined) details.push(`match: ${item.matchBasis}`);
  details.push(item.source.url);
  return `- ${details.join(" · ")}`;
}
