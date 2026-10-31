import type { NlmDrugsClient } from "@knorby/nlm-drugs-client";
import { getClients } from "../clients.js";
import type { IngredientRef } from "../lib/schemas.js";
import type {
  IngredientGroup,
  IngredientLookupRecord,
  IngredientSearchType,
  SourceAdapter,
} from "./types.js";

/**
 * The PubChem adapter.
 *
 * PubChem is reached through the shared NLM client but reported as its own
 * database: a compound is a chemical record, not a drug concept, and its
 * lookup key is the CID. The adapter's id is `nlm` so the existing
 * `DRUGDATA_DISABLED_SOURCES` switch controls every NLM-served source
 * together.
 *
 * What PubChem answers is deliberately small: a name search returns CIDs
 * (the name that matched is the name shown), and a lookup returns the four
 * chemistry fields the properties service reports. PUG View's full record
 * stays upstream — the compound's page link is the result.
 */

/** How many CIDs one search page carries. */
const PAGE_SIZE = 20;

/** The chemistry fields requested from the PubChem properties service. */
const PROPERTIES = [
  "IUPACName",
  "MolecularFormula",
  "MolecularWeight",
  "InChIKey",
] as const;

/** A positive safe integer, as the CID input contract. */
const CID_PATTERN = /^[1-9]\d*$/;

/** The compound page link for one CID. */
function pubchemUrl(cid: number): string {
  return `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`;
}

/** An HTTP status carried by a client error, when present. */
function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === "number" ? status : undefined;
}

/** Whether a CID is a positive safe integer. */
function isCid(value: string): boolean {
  return CID_PATTERN.test(value.trim()) && Number.isSafeInteger(Number(value));
}

/** Rewords a PubChem failure so it names only the database. */
function pubchemFailure(context: string, error: unknown): Error {
  const status = statusOf(error);
  if (status === 429) {
    return new Error(
      `${context} was rate limited by PubChem (HTTP 429). Wait a few seconds, then retry.`,
    );
  }
  if (typeof status === "number" && status >= 500) {
    return new Error(
      `${context} failed: PubChem returned HTTP ${status} and may be temporarily unavailable. Retry shortly.`,
    );
  }
  if (typeof status === "number") {
    return new Error(
      `${context} failed: PubChem rejected the request (HTTP ${status}). Check the search value and try again.`,
    );
  }
  return new Error(
    `${context} failed: PubChem did not return a usable response. Retry shortly.`,
  );
}

/** Builds one ingredient ref for a CID. */
function cidRef(
  cid: number,
  name: string,
  retrievedAt: string,
  matchBasis?: string,
  inchiKey?: string,
): IngredientRef {
  return {
    name,
    identifiers: {
      cid: [cid],
      ...(inchiKey === undefined ? {} : { inchiKey }),
    },
    source: {
      database: "PubChem",
      id: String(cid),
      url: pubchemUrl(cid),
      retrievedAt,
    },
    ...(matchBasis === undefined ? {} : { matchBasis }),
  };
}

/** What the properties service said about one CID. */
interface CompoundRecord {
  /** The compound's display name: its IUPAC name, or the CID. */
  name: string;
  /** The chemistry fields the ingredient profile carries. */
  chemistry: {
    iupacName?: string;
    molecularFormula?: string;
    molecularWeight?: string;
    inChIKey?: string;
  };
  /** Identifier fields derived from the same response. */
  identifiers: { cid: number[]; inchiKey?: string };
}

/** Reads the chemistry fields for one CID, dropping empty values. */
async function compoundRecord(
  client: NlmDrugsClient,
  cid: number,
  signal: AbortSignal | undefined,
): Promise<CompoundRecord> {
  const properties = await client.pubChem.getProperties(cid, PROPERTIES, {
    signal,
  });
  const text = (value: string | number | undefined): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined;

  const iupacName = text(properties.IUPACName);
  const molecularFormula = text(properties.MolecularFormula);
  const molecularWeight = text(properties.MolecularWeight);
  const inChIKey = text(properties.InChIKey);
  return {
    name: iupacName ?? `PubChem CID ${cid}`,
    chemistry: {
      ...(iupacName === undefined ? {} : { iupacName }),
      ...(molecularFormula === undefined ? {} : { molecularFormula }),
      ...(molecularWeight === undefined ? {} : { molecularWeight }),
      ...(inChIKey === undefined ? {} : { inChIKey }),
    },
    identifiers: {
      cid: [cid],
      ...(inChIKey === undefined ? {} : { inchiKey: inChIKey }),
    },
  };
}

/** An empty PubChem group. */
function emptyGroup(page: number): IngredientGroup {
  return { source: "PubChem", items: [], page, hasMore: false };
}

/**
 * Creates the PubChem adapter.
 *
 * @param client Optional client override; production uses the shared NLM
 *   client, so the same fetch policy and disable switch apply.
 */
export function createPubChemAdapter(client?: NlmDrugsClient): SourceAdapter {
  const clients = () => client ?? getClients().nlm;

  return {
    id: "nlm",
    databases: ["PubChem"],
    productSearchTypes: [],
    ingredientSearchTypes: ["name", "cid"],
    productCategories: [],

    async searchIngredients(
      type: IngredientSearchType,
      query: string,
      page: number,
      signal?: AbortSignal,
    ): Promise<IngredientGroup[]> {
      if (type !== "name" && type !== "cid") return [];
      const retrievedAt = new Date().toISOString();
      const context = "The PubChem search";

      if (type === "cid") {
        if (!isCid(query)) {
          return [
            {
              ...emptyGroup(page),
              error: `Expected a PubChem CID (a positive integer), but got "${query.slice(0, 80)}". Search ingredients by name to find the compound's CID.`,
            },
          ];
        }
        const cid = Number(query.trim());
        try {
          const compound = await compoundRecord(clients(), cid, signal);
          return [
            {
              source: "PubChem",
              items: [cidRef(cid, compound.name, retrievedAt)],
              page,
              hasMore: false,
            },
          ];
        } catch (error) {
          // An unknown CID is a normal empty result, not an error.
          if (statusOf(error) === 404) return [emptyGroup(page)];
          throw pubchemFailure(context, error);
        }
      }

      let cids: number[];
      try {
        cids = await clients().pubChem.findCompoundIds(query, { signal });
      } catch (error) {
        // An unknown name is a normal empty result, not an error.
        if (statusOf(error) === 404) return [emptyGroup(page)];
        throw pubchemFailure(context, error);
      }

      const start = (page - 1) * PAGE_SIZE;
      return [
        {
          source: "PubChem",
          items: cids
            .slice(start, start + PAGE_SIZE)
            .map((cid) =>
              cidRef(cid, query, retrievedAt, "PubChem name search"),
            ),
          page,
          hasMore: start + PAGE_SIZE < cids.length,
        },
      ];
    },

    async getIngredient(
      id: string,
      _opts: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<unknown> {
      if (!isCid(id)) {
        throw new Error(
          `Expected a PubChem CID (a positive integer), but got "${id.slice(0, 80)}". Use the cid from a PubChem search result.`,
        );
      }
      const cid = Number(id.trim());
      const retrievedAt = new Date().toISOString();
      const compound = await compoundRecord(clients(), cid, signal);
      const record: IngredientLookupRecord = {
        ingredient: cidRef(
          cid,
          compound.name,
          retrievedAt,
          undefined,
          compound.identifiers.inchiKey,
        ),
        profile: { chemistry: compound.chemistry },
      };
      return record;
    },
  };
}

/** The singleton PubChem adapter used by the search tools. */
export const pubchemAdapter = createPubChemAdapter();

/** Validated PubChem identity bridge used by the shared resolver. */
export interface PubChemBridges {
  compoundByCid(
    cid: string,
    signal?: AbortSignal,
  ): Promise<IngredientRef | null>;
}

export function createPubChemBridges(client?: NlmDrugsClient): PubChemBridges {
  return {
    async compoundByCid(value, signal) {
      if (!isCid(value)) return null;
      const cid = Number(value.trim());
      try {
        const record = await compoundRecord(
          client ?? getClients().nlm,
          cid,
          signal,
        );
        return cidRef(
          cid,
          record.name,
          new Date().toISOString(),
          undefined,
          record.identifiers.inchiKey,
        );
      } catch (error) {
        if (statusOf(error) === 404) return null;
        throw pubchemFailure("The PubChem identity lookup", error);
      }
    },
  };
}

export const pubChemBridges = createPubChemBridges();
