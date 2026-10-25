import type { NlmDrugsClient } from "@knorby/nlm-drugs-client";
import * as z from "zod/v4";
import { encodeCursor, readCursor } from "./cursor.js";
import type {
  Reference,
  ReferenceGroup,
  ReferenceHandler,
  ReferenceSearchInput,
} from "./types.js";

/**
 * Consumer-health reference handlers: MedlinePlus topic search, MedlinePlus
 * Genetics search, and MedlinePlus Connect drug-page lookup.
 *
 * The MedlinePlus databases address a page by its URL — there is no separate
 * stable identifier — so the URL is both the record id and the deep link.
 * Titles are the source's own. Topic and genetics searches page with the
 * upstream `file`/`server` continuation handles; Connect has no paging, so
 * it uses a client-side slice.
 */

/**
 * Cursor payload for the wsearch-backed sources: where to resume, plus the
 * continuation handles the upstream requires (`file` and `server` must be
 * supplied together once `start` is past zero).
 */
const pageCursor = z.object({
  start: z.number().int().min(0),
  file: z.string(),
  server: z.string(),
});

/** Cursor payload for the sliced Connect source. */
const offsetPayload = z.object({ offset: z.number().int().min(0) });

/** The note a health search attaches when it cannot continue. */
const NO_HANDLES_NOTE =
  "This search returned more results but no continuation handles, so the first page is all this tool can reach.";

function now(): string {
  return new Date().toISOString();
}

/** One MedlinePlus-addressed page as a reference. */
function pageReference(
  page: { url: string; title?: string },
  database: Reference["source"]["database"],
  kind: Reference["kind"],
  dataset?: string,
): Reference {
  return {
    kind,
    ...(page.title === undefined ? {} : { title: page.title }),
    source: {
      database,
      id: page.url,
      url: page.url,
      retrievedAt: now(),
    },
    identifiers: {},
    ...(dataset === undefined ? {} : { dataset }),
  };
}

/**
 * Shared shape for the two wsearch-backed handlers: both page with
 * `start`/`file`/`server` and both report the upstream total.
 */
async function pagedSearch(
  input: ReferenceSearchInput,
  database: ReferenceGroup["source"],
  search: (options: {
    pageSize: number;
    start?: number;
    file?: string;
    server?: string;
  }) => Promise<{
    results: ReadonlyArray<{ url: string; title?: string }>;
    total: number;
    file?: string;
    server?: string;
  }>,
  kind: Reference["kind"],
  dataset?: string,
): Promise<ReferenceGroup> {
  const cursor = readCursor(input, pageCursor, {
    start: 0,
    file: "",
    server: "",
  });
  const firstPage = input.cursor === undefined;
  const page = await search({
    pageSize: input.limit,
    ...(firstPage
      ? {}
      : { start: cursor.start, file: cursor.file, server: cursor.server }),
  });

  const items = page.results.map((result) =>
    pageReference(result, database, kind, dataset),
  );
  const start = firstPage ? 0 : cursor.start;
  const hasMore = start + page.results.length < page.total;
  const canContinue =
    hasMore && page.file !== undefined && page.server !== undefined;
  return {
    source: database,
    items,
    hasMore,
    total: page.total,
    ...(canContinue
      ? {
          nextCursor: encodeCursor(input, {
            start: start + page.results.length,
            file: page.file,
            server: page.server,
          }),
        }
      : {}),
    ...(hasMore && !canContinue ? { limitation: NO_HANDLES_NOTE } : {}),
  };
}

/** Searches MedlinePlus consumer-health topic pages by term. */
export function medlineplusHandler(client: NlmDrugsClient): ReferenceHandler {
  return (input) =>
    pagedSearch(
      input,
      "MedlinePlus",
      (options) => client.medlinePlus.searchTopics(input.query, options),
      "health_topic",
    );
}

/**
 * Searches MedlinePlus Genetics pages by term.
 *
 * Genetics search results carry no titles — only URLs with relevance order —
 * so references are link-only, which is a valid result under the sourcing
 * posture.
 */
export function medlineplusGeneticsHandler(
  client: NlmDrugsClient,
): ReferenceHandler {
  return (input) =>
    pagedSearch(
      input,
      "MedlinePlus",
      (options) => client.medlinePlusGenetics.search(input.query, options),
      "genetics",
      "MedlinePlus Genetics",
    );
}

/**
 * Looks up MedlinePlus drug pages through MedlinePlus Connect.
 *
 * Connect accepts a drug name, an NDC, or an RxCUI and answers with the
 * matching consumer-health pages; it reports no totals and takes no paging,
 * so the handler slices client-side.
 */
export function medlineplusConnectHandler(
  client: NlmDrugsClient,
): ReferenceHandler {
  return async (input) => {
    const drugInput =
      input.type === "name"
        ? { kind: "drugName" as const, name: input.query }
        : input.type === "rxcui"
          ? { kind: "rxcui" as const, code: input.query }
          : { kind: "ndc" as const, code: input.query };

    const { offset } = readCursor(input, offsetPayload, { offset: 0 });
    const pages = await client.medlinePlusConnect.findDrugPages(drugInput);
    const page = pages.slice(offset, offset + input.limit);
    const items = page.map((page_) =>
      pageReference(
        page_,
        "MedlinePlus",
        "health_topic",
        "MedlinePlus Connect",
      ),
    );
    const hasMore = offset + input.limit < pages.length;
    return {
      source: "MedlinePlus",
      items,
      hasMore,
      ...(hasMore
        ? { nextCursor: encodeCursor(input, { offset: offset + input.limit }) }
        : {}),
      limitation:
        "MedlinePlus Connect reports no result totals; hasMore is true only when another page is known to exist.",
    };
  };
}
