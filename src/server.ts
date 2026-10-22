import { McpServer } from "@modelcontextprotocol/server";
import { DISCLAIMER, SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { registerResearchDrugPrompt } from "./prompts/research-drug.js";
import { registerInfoResource } from "./resources/info.js";
import type { IdentityResolver } from "./sources/identity/chain.js";
import type { Registry } from "./sources/types.js";
import { registerGetIngredientTool } from "./tools/get-ingredient.js";
import { registerGetProductTool } from "./tools/get-product.js";
import { registerPingTool } from "./tools/ping.js";
import { registerResolveIdentifiersTool } from "./tools/resolve-identifiers.js";
import { registerSearchIngredientsTool } from "./tools/search-ingredients.js";
import { registerSearchProductsTool } from "./tools/search-products.js";

/**
 * Builds the MCP server and registers every primitive.
 *
 * This factory is deliberately transport-agnostic and side-effect free: the
 * stdio entrypoint (`src/index.ts`) calls it through `serveStdio`, and tests
 * call it through `createMcpHandler` to drive the server in-process. Adding an
 * HTTP transport later means adding an entrypoint, not touching this file.
 *
 * Registration order is fixed and deliberate. The 2026-07-28 revision says a
 * server SHOULD keep `tools/list` stable so a client can cache it, so the six
 * tools are registered in the documented order instead of being spread through
 * a map or sorted at request time.
 */

/**
 * How to use the server, handed to the host at initialization.
 *
 * Hosts surface this to the model, so it carries what individual tool
 * descriptions cannot: the loop that connects the tools, the identifier
 * vocabulary that makes cross-source pivots possible, how to read confident
 * links versus candidates, the pagination contract, and the sourcing etiquette
 * that keeps every answer attributable.
 */
const INSTRUCTIONS = `Open Drug Data is one research interface over openFDA, CosIng, RxNorm/DailyMed, DrugCentral, NIH DSLD, and INKEEDecoder. Every record is credited to the upstream database that supplied it and carries a deep link.

The loop is search → resolve → get. Every search and resolve result ends with nextSteps; follow them instead of inventing an identifier.

1. Search by what you have. drugdata_search_products accepts a product name, brand, ingredient, barcode, or NDC. drugdata_search_ingredients accepts a name, INCI name, UNII, CAS number, EC number, or RxCUI. Choose the type that matches the value in hand.
2. Resolve cross-source identity. When a result carries a cross-source identifier, call drugdata_resolve_identifiers with exactly one of unii, ndc, rxcui, cas, inci_name, substance_name, spl_setid, or dsld_id. That runs the identity chain across sources and returns what it could link plus what remains ambiguous.
3. get the full record from the database that owns it. drugdata_get_product takes source openfda, dsld, dailymed, or inkeedecoder; drugdata_get_ingredient takes source openfda, cosing, drugcentral, nlm, or inkeedecoder. Pass the database's own id from the result unchanged. Costly sections are opt-in; turn them on only when the question needs them.

Identifier vocabulary: NDC is a US drug product or package code; UNII is an FDA ingredient identifier; RxCUI is an RxNorm concept; CAS and EC are chemical registry numbers; INCI is a cosmetic ingredient name; an SPL setid identifies a DailyMed label document; a structId identifies a DrugCentral structure. DSLD label ids and source slugs appear alongside them. An identifier one source knows often unlocks records in another, and resolve_identifiers is the bridge.

Confidence: in resolve results, links are trusted matches — direct means the same identifier, derived means a documented crosswalk. candidates are possible matches that need judgment: never silently treat one as confirmed or choose one for the user. When identity matters, prefer a direct link or ask which record is meant.

Pagination: a search takes one page number, applies it to every source in the fan-out, and re-queries all of them; read each group's hasMore rather than assuming a shared page count. Lookups page their own ingredient and label-section collections. Never walk every page by default — request page + 1 only when the answer needs it. Responses are character-bounded; when text is shortened, it says which parts were cut.

Sourcing etiquette: cite the upstream database and its deep link in your answer, and do not present this server as the source. Regulatory text — annex notices, label sections, indication wording — is verbatim: summarize or quote briefly with attribution rather than republishing it. Zero matches are a normal result, not an error; use drugdata_ping when a source looks unavailable.

${DISCLAIMER}`;

/** Test-only overrides for the source registry and identity resolver. */
export interface ServerDependencies {
  /** Registry to use instead of one built lazily from process configuration. */
  registry?: Registry;
  /** Resolver to use instead of the shared identity-chain instance. */
  resolver?: IdentityResolver;
}

/** Builds the server and registers every tool, resource, and prompt. */
export function createServer({
  registry,
  resolver,
}: ServerDependencies = {}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  // Fixed order: see the module comment. Do not sort or regroup these.
  registerPingTool(server);
  registerSearchProductsTool(server, registry);
  registerSearchIngredientsTool(server, registry);
  registerGetProductTool(server, registry);
  registerGetIngredientTool(server, registry);
  registerResolveIdentifiersTool(server, resolver);

  registerInfoResource(server);
  registerResearchDrugPrompt(server);

  return server;
}
