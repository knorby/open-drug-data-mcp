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
 * Terminology reference handlers: Prescribable RxNorm, RxClass, MeSH, UMLS.
 *
 * These sources answer with identifiers and names — a link is the result, so
 * each handler extracts only a title, the identifiers, and a deep link. The
 * sliced sources (prescribable, rxclass, mesh) re-query upstream and skip
 * `offset` rows, because their APIs expose no native paging; their
 * `hasMore` is therefore conservative and carries a limitation note.
 */

/** Cursor payload for the sliced sources: how many rows to skip. */
const offsetPayload = z.object({ offset: z.number().int().min(0) });

/** The note sliced sources attach, because upstream reports no totals. */
const NO_TOTALS_NOTE =
  "This source reports no result totals; hasMore is true only when another page is known to exist.";

function now(): string {
  return new Date().toISOString();
}

/** The RxNav browser link for one RxNorm concept. */
function rxnavConceptUrl(rxcui: string): string {
  return `https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm=${encodeURIComponent(rxcui)}`;
}

/** The RxClass API link for one drug class. */
function rxclassUrl(classId: string): string {
  return `https://rxnav.nlm.nih.gov/REST/rxclass/class/byId.json?classId=${encodeURIComponent(classId)}`;
}

/** The UTS browser link for one UMLS concept. */
function umlsConceptUrl(cui: string): string {
  return `https://uts.nlm.nih.gov/uts/umls/concept/${encodeURIComponent(cui)}`;
}

/** A type guard that drops undefined entries after a map. */
function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/**
 * Runs a sliced search: re-query upstream, skip `offset`, keep `limit`.
 *
 * @param input The validated request, carrying the cursor when present.
 * @param database The upstream database the group credits.
 * @param fetchAll Fetches the full upstream row list for this query.
 * @param build Turns one row into a reference.
 */
async function sliced<T>(
  input: ReferenceSearchInput,
  database: ReferenceGroup["source"],
  fetchAll: () => Promise<readonly T[]>,
  build: (row: T) => Reference,
): Promise<ReferenceGroup> {
  const { offset } = readCursor(input, offsetPayload, { offset: 0 });
  const rows = await fetchAll();
  const page = rows.slice(offset, offset + input.limit);
  const items = page.map(build);
  const hasMore = offset + input.limit < rows.length;
  return {
    source: database,
    items,
    hasMore,
    ...(hasMore
      ? { nextCursor: encodeCursor(input, { offset: offset + input.limit }) }
      : {}),
    limitation: NO_TOTALS_NOTE,
  };
}

/** A Prescribable RxNorm concept as a reference. */
function prescribableReference(concept: {
  rxcui: string;
  name: string;
}): Reference {
  return {
    kind: "drug",
    title: concept.name,
    source: {
      database: "RxNorm",
      id: concept.rxcui,
      url: rxnavConceptUrl(concept.rxcui),
      retrievedAt: now(),
    },
    identifiers: { rxcui: concept.rxcui },
    dataset: "Prescribable",
  };
}

/** Searches the prescribable RxNorm dataset by name or RxCUI. */
export function prescribableHandler(client: NlmDrugsClient): ReferenceHandler {
  return async (input) => {
    if (input.type === "rxcui") {
      const concept = await client.prescribable.getConcept(input.query);
      return {
        source: "RxNorm",
        items: concept === undefined ? [] : [prescribableReference(concept)],
        hasMore: false,
      };
    }

    // Name searches need one follow-up per page row to learn the concept's
    // name, so this source pages its own slice rather than using `sliced`.
    const { offset } = readCursor(input, offsetPayload, { offset: 0 });
    const rxcuis = await client.prescribable.findConcepts(input.query);
    const page = rxcuis.slice(offset, offset + input.limit);
    const concepts = await Promise.all(
      page.map((rxcui) => client.prescribable.getConcept(rxcui)),
    );
    const items = concepts.filter(isDefined).map(prescribableReference);
    const hasMore = offset + input.limit < rxcuis.length;
    return {
      source: "RxNorm",
      items,
      hasMore,
      ...(hasMore
        ? { nextCursor: encodeCursor(input, { offset: offset + input.limit }) }
        : {}),
      limitation: NO_TOTALS_NOTE,
    };
  };
}

/** A drug class as a reference. */
function rxclassReference(clazz: {
  classId: string;
  className: string;
  classType: string;
}): Reference {
  return {
    kind: "class",
    title: clazz.className,
    source: {
      database: "RxClass",
      id: clazz.classId,
      url: rxclassUrl(clazz.classId),
      retrievedAt: now(),
    },
    identifiers: {
      classId: clazz.classId,
      classType: clazz.classType,
    },
  };
}

/** Searches RxClass drug classes by class name or member RxCUI. */
export function rxclassHandler(client: NlmDrugsClient): ReferenceHandler {
  return (input) =>
    sliced(
      input,
      "RxClass",
      () =>
        input.type === "rxcui"
          ? client.rxClass.findClassesForRxCui(input.query)
          : client.rxClass.findClasses(input.query),
      rxclassReference,
    );
}

/** A MeSH descriptor as a reference. */
function meshReference(descriptor: {
  id: string;
  label: string;
  resource: string;
}): Reference {
  return {
    kind: "descriptor",
    title: descriptor.label,
    source: {
      database: "MeSH",
      id: descriptor.id,
      url: descriptor.resource,
      retrievedAt: now(),
    },
    identifiers: { meshId: descriptor.id },
  };
}

/** Searches MeSH descriptors by label. */
export function meshHandler(client: NlmDrugsClient): ReferenceHandler {
  return (input) =>
    sliced(
      input,
      "MeSH",
      () => client.mesh.findDescriptors(input.query),
      meshReference,
    );
}

/**
 * Searches UMLS concepts by name or CUI.
 *
 * UMLS is the one gated source: without `UMLS_API_KEY` the handler returns
 * an actionable error group instead of a TypeError from the client. UMLS
 * search answers with up to 200 results in one response, so the handler
 * serves the first page only and says so in a limitation note.
 */
export function umlsHandler(
  client: NlmDrugsClient,
  isConfigured: () => boolean,
): ReferenceHandler {
  return async (input) => {
    if (!isConfigured()) {
      return {
        source: "UMLS",
        items: [],
        hasMore: false,
        error:
          "UMLS needs an API key. Set UMLS_API_KEY to an NLM UTS API key for this process; every other source works without one.",
      };
    }

    if (input.type === "cui") {
      const record: Record<string, unknown> = await client.umls.getConcept(
        input.query,
      );
      const cui = typeof record.ui === "string" ? record.ui : undefined;
      const name = typeof record.name === "string" ? record.name : undefined;
      if (cui === undefined || name === undefined) {
        throw new Error("UMLS returned a concept without a ui or name");
      }
      return {
        source: "UMLS",
        items: [
          {
            kind: "terminology",
            title: name,
            source: {
              database: "UMLS",
              id: cui,
              url: umlsConceptUrl(cui),
              retrievedAt: now(),
            },
            identifiers: { cui },
          },
        ],
        hasMore: false,
      };
    }

    const results = await client.umls.search(input.query, {
      returnIdType: "concept",
    });
    const items = results.slice(0, input.limit).map(
      (result): Reference => ({
        kind: "terminology",
        title: result.name,
        source: {
          database: "UMLS",
          id: result.ui,
          url: umlsConceptUrl(result.ui),
          retrievedAt: now(),
        },
        identifiers: { cui: result.ui },
        ...(result.rootSource === undefined
          ? {}
          : { dataset: result.rootSource }),
      }),
    );
    return {
      source: "UMLS",
      items,
      hasMore: false,
      limitation:
        "UMLS search returns up to 200 results in one response; this tool returns the first page only.",
    };
  };
}
