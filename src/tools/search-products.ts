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
import { searchNextSteps } from "../lib/next-steps.js";
import {
  databaseIdSchema,
  nextStepSchema,
  type ProductIdentifiers,
  type ProductRef,
  paginatedFields,
  productCategorySchema,
  productRefSchema,
} from "../lib/schemas.js";
import {
  PRODUCT_SEARCH_TYPES,
  type ProductSearchType,
  type Registry,
} from "../sources/types.js";
import {
  type IdentifierField,
  identifierText,
  itemCount,
  messageError,
  nextStepsText,
  resolveRegistry,
  sanitizeGroups,
  toolError,
  zeroResultsNote,
} from "./search-support.js";

/**
 * `drugdata_search_products` — one product search across every capable source.
 *
 * The tool is deliberately thin: the registry decides which sources can answer
 * the requested search type and category, isolates failures, and returns
 * groups already labeled by upstream database. Here we validate the result
 * against a closed schema, derive follow-up calls, and render either markdown
 * or JSON.
 */

const DESCRIPTION =
  "Search products across openFDA, DSLD, INKEEDecoder, RxNorm, and DailyMed. Choose the kind of value you have (name, brand, ingredient, barcode, or NDC); results are grouped by upstream database with identifiers, a deep link, and suggested follow-up calls. One `page` value applies to every source in the fan-out and re-queries all of them; each group's `hasMore` reports whether that source has another page. A group with an `error` means that one database failed — retry, or proceed with the other groups. No matches is a normal empty result, not an error.";

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

const groupSchema = z.object({
  source: databaseIdSchema,
  items: z.array(productRefSchema),
  ...paginatedFields,
  error: z
    .string()
    .optional()
    .describe(
      "Set when this database failed for the whole search; the other groups are still valid.",
    ),
});

const outputSchema = z.object({
  query: z.string(),
  page: z.number().int().min(1),
  groups: z.array(groupSchema),
  nextSteps: z.array(nextStepSchema),
});

type ProductSearchInput = z.infer<typeof inputSchema>;
type ProductSearchOutput = z.infer<typeof outputSchema>;

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
    async ({
      type,
      query,
      category,
      page,
      response_format,
    }: ProductSearchInput) => {
      const resolved = resolveRegistry(registry);
      if (!resolved.ok) return messageError(resolved.error);

      try {
        const groups = sanitizeGroups(
          await resolved.registry.searchProducts(type, query, {
            category,
            page,
          }),
        );
        const output = outputSchema.parse({
          query,
          page,
          groups,
          nextSteps: searchNextSteps(type, groups),
        });
        const bounded = boundStructured(output);
        const anyHasMore = groups.some((group) => group.hasMore);

        const text =
          response_format === "json"
            ? applyCharacterLimit(formatJson(bounded.value))
            : applyCharacterLimit(
                renderMarkdown(
                  type,
                  bounded.value,
                  anyHasMore,
                  bounded.truncated,
                ),
              );

        return {
          content: [{ type: "text" as const, text }],
          structuredContent: bounded.value,
        };
      } catch (error) {
        return toolError(error, `the ${type} product search`);
      }
    },
  );
}

/** Renders the markdown text block for a product search. */
function renderMarkdown(
  type: ProductSearchType,
  output: ProductSearchOutput,
  anyHasMore: boolean,
  truncated: boolean,
): string {
  const sections = [
    `Product search for ${JSON.stringify(output.query)} (type: ${type}) — page ${output.page}.`,
    ...output.groups.map(groupSection),
  ];

  if (itemCount(output.groups) === 0) {
    sections.push(zeroResultsNote(output.groups));
  }

  const steps = nextStepsText(output.nextSteps);
  if (steps !== undefined) sections.push(steps);

  let text = sections.join("\n\n");
  text += morePagesNote(anyHasMore, output.page + 1);
  if (truncated) text += truncationNote();
  return text;
}

/** Renders one source's section, including its failure as a warning. */
function groupSection(group: ProductGroupOutput): string {
  if (group.error !== undefined) {
    return `### ${group.source} — unavailable\n⚠ ${group.source}: ${group.error}`;
  }

  const count = group.items.length;
  const results = `${count} ${count === 1 ? "result" : "results"}`;
  const more = group.hasMore ? ", more available" : "";
  const header = `### ${group.source} — ${results} (page ${group.page}${more})`;
  const lines =
    group.items.length === 0
      ? ["- No matches on this page."]
      : group.items.map(productLine);
  return [header, ...lines].join("\n");
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

/** The group shape after output-schema parsing. */
type ProductGroupOutput = ProductSearchOutput["groups"][number];
