import type { NlmDrugsClient } from "@knorby/nlm-drugs-client";
import * as z from "zod/v4";
import { encodeCursor, readCursor } from "./cursor.js";
import type { Reference, ReferenceHandler } from "./types.js";

/**
 * Literature reference handlers: PubMed and ClinicalTrials.gov.
 *
 * Both are link-first surfaces: the handler extracts a title, the stable
 * identifier (PMID or NCT number), and for PubMed the source's own
 * publication date string. Abstracts and study records stay upstream — the
 * deep link is the result.
 */

/** Cursor payload for PubMed: the zero-based offset of the next page. */
const pubmedCursor = z.object({ start: z.number().int().min(0) });

/** Cursor payload for ClinicalTrials.gov: the upstream page token. */
const trialsCursor = z.object({ pageToken: z.string() });

function now(): string {
  return new Date().toISOString();
}

/** A PubMed article as a reference. */
function pubmedReference(summary: {
  uid: string;
  title: string;
  pubdate?: string;
}): Reference {
  return {
    kind: "article",
    title: summary.title,
    ...(summary.pubdate === undefined
      ? {}
      : { publicationDate: summary.pubdate }),
    source: {
      database: "PubMed",
      id: summary.uid,
      url: `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(summary.uid)}/`,
      retrievedAt: now(),
    },
    identifiers: { pmid: summary.uid },
  };
}

/** A ClinicalTrials.gov study as a reference. */
function trialReference(study: {
  nctId: string;
  briefTitle: string;
}): Reference {
  return {
    kind: "trial",
    title: study.briefTitle,
    source: {
      database: "ClinicalTrials.gov",
      id: study.nctId,
      url: `https://clinicaltrials.gov/study/${encodeURIComponent(study.nctId)}`,
      retrievedAt: now(),
    },
    identifiers: { nctId: study.nctId },
  };
}

/**
 * Searches PubMed articles by term.
 *
 * Two upstream calls per page: `esearch` for the id list, `esummary` for
 * titles and dates. `total` is the upstream count, so `hasMore` is exact.
 */
export function pubmedHandler(client: NlmDrugsClient): ReferenceHandler {
  return async (input) => {
    const { start } = readCursor(input, pubmedCursor, { start: 0 });
    const page = await client.pubMed.search(input.query, {
      pageSize: input.limit,
      start,
    });

    if (page.ids.length === 0) {
      return { source: "PubMed", items: [], hasMore: false, total: page.total };
    }
    const summaries = await client.pubMed.summarize(page.ids);
    const items = summaries.map(pubmedReference);
    const hasMore = start + page.ids.length < page.total;
    return {
      source: "PubMed",
      items,
      hasMore,
      total: page.total,
      ...(hasMore
        ? {
            nextCursor: encodeCursor(input, {
              start: start + page.ids.length,
            }),
          }
        : {}),
    };
  };
}

/**
 * Searches ClinicalTrials.gov studies by term.
 *
 * The upstream pages with an opaque `pageToken`; the cursor wraps it. The
 * upstream reports a total only when asked, and asking for it on every page
 * costs accuracy elsewhere, so `total` is omitted and `hasMore` follows the
 * presence of a next-page token.
 */
export function clinicaltrialsHandler(
  client: NlmDrugsClient,
): ReferenceHandler {
  return async (input) => {
    const { pageToken } = readCursor(input, trialsCursor, { pageToken: "" });
    const firstPage = input.cursor === undefined;
    const page = await client.clinicalTrials.searchStudies({
      term: input.query,
      pageSize: input.limit,
      countTotal: true,
      ...(firstPage ? {} : { pageToken }),
    });

    return {
      source: "ClinicalTrials.gov",
      items: page.studies.map(trialReference),
      hasMore: page.nextPageToken !== undefined,
      ...(page.nextPageToken === undefined
        ? {}
        : {
            nextCursor: encodeCursor(input, { pageToken: page.nextPageToken }),
          }),
      ...(page.totalCount === undefined
        ? {}
        : {
            total: page.totalCount,
            limitation:
              "ClinicalTrials.gov pages with opaque tokens; hasMore follows the upstream next-page token.",
          }),
    };
  };
}
