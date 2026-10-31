import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { readConfig } from "../config.js";
import { applyCharacterLimit, RESPONSE_FORMATS } from "../lib/format.js";
import {
  type ProductIdentifiers,
  type ProductRef,
  productCategorySchema,
  productEntitySearchResultSchema,
} from "../lib/schemas.js";
import type { IdentityResolver } from "../sources/identity/chain.js";
import { createSearchCoordinator } from "../sources/search/coordinator.js";
import { PRODUCT_SEARCH_TYPES, type Registry } from "../sources/types.js";
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
 * `drugdata_search_products` — one product search across every capable source.
 *
 * The coordinator selects capable sources, clusters identity evidence and
 * enriches a bounded prefix; this tool validates and renders the result.
 */

const DESCRIPTION =
  "Search products across openFDA, DSLD, INKEEDecoder, RxNorm, and DailyMed. Start free text with type 'name'; use 'brand' deliberately for brand-only search, which covers fewer sources. Use ingredient, barcode, or ndc when appropriate, and pass category medication/supplement/cosmetic when known. Returns evidence-grouped entities with original records, confirmed links, source-attributed conflicts, unconfirmed candidates, and per-entity nextSteps. A product RxCUI or shared name alone does not merge products. For source+id use drugdata_get_product instead. Search enriches at most five entities, concurrency three, within a shared 45-second default deadline. Read partial, coverage, and sources (status ok/error/timeout); completed results survive a timeout. One page applies to every source and re-queries all of them; each source's hasMore is independent. Selectively fetch supplied URLs only when more page content is needed. No matches is normal, not an error.";

const inputSchema = z.object({
  type: z
    .enum(PRODUCT_SEARCH_TYPES)
    .describe(
      "What to search by: 'name' for a product name, 'brand' for a brand name, 'ingredient' for an ingredient name, 'barcode' for a UPC/EAN, or 'ndc' for an NDC.",
    ),
  query: z
    .string()
    .min(1)
    .max(200)
    .describe("The search value, as text or an identifier."),
  category: productCategorySchema
    .optional()
    .describe(
      "Optional category filter: 'medication', 'supplement', or 'cosmetic'. Only sources about that category are queried.",
    ),
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

const outputSchema = productEntitySearchResultSchema;

type ProductSearchInput = z.infer<typeof inputSchema>;

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

/** Registers the `drugdata_search_products` tool. */
export function registerSearchProductsTool(
  server: McpServer,
  registry?: Registry,
  resolver?: IdentityResolver,
): void {
  server.registerTool(
    "drugdata_search_products",
    {
      title: "Search products across open drug data sources",
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
      { type, query, category, page, response_format }: ProductSearchInput,
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
          }).searchProducts({ type, query, category, page }, ctx.mcpReq.signal),
        );
        const bounded = boundEntitySearch(output);
        const context: ZeroResultsContext = {
          kind: "product",
          hasCategory: category !== undefined,
        };

        if (response_format === "json") {
          return {
            content: entityJsonBlocks(
              bounded.value,
              context,
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
                  context,
                  bounded.truncated,
                  productLine,
                ),
              ),
            },
          ],
          structuredContent: bounded.value,
        };
      } catch (error) {
        return toolError(error, `the ${type} product search`);
      }
    },
  );
}

/** Renders one product as a compact list line. */
function productLine(item: ProductRef): string {
  const details = [`**${item.name}**`];
  if (item.brand !== undefined) details.push(`brand: ${item.brand}`);
  if (item.category !== undefined) details.push(`category: ${item.category}`);
  const identifiers = identifierText(item.identifiers, IDENTIFIER_FIELDS);
  if (identifiers !== undefined) details.push(identifiers);
  if (item.matchBasis !== undefined) details.push(`match: ${item.matchBasis}`);
  details.push(item.source.url);
  return `- ${details.join(" · ")}`;
}
