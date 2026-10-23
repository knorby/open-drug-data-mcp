import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import {
  type DatabaseId,
  databaseIdSchema,
  type IngredientRef,
  ingredientRefSchema,
  nextStepSchema,
  type ProductRef,
  paginatedFields,
  paginatedFieldsSchema,
  productRefSchema,
  sourceRefSchema,
} from "../src/lib/schemas.js";

const openFdaSource = {
  database: "openFDA",
  id: "00093-1046",
  url: "https://api.fda.gov/drug/ndc.json?search=product_ndc:%2200093-1046%22",
  retrievedAt: "2026-10-21T12:00:00.000Z",
};

describe("databaseIdSchema", () => {
  it("names each upstream database without naming a client library", () => {
    expect(databaseIdSchema.options).toEqual([
      "openFDA",
      "CosIng",
      "RxNorm",
      "RxTerms",
      "RxClass",
      "DailyMed",
      "DrugCentral",
      "DSLD",
      "INKEEDecoder",
      "MeSH",
      "PubMed",
      "MedlinePlus",
      "UMLS",
      "ClinicalTrials.gov",
      "PubChem",
    ]);
    const database: DatabaseId = databaseIdSchema.parse("openFDA");
    expect(database).toBe("openFDA");
  });

  it("rejects an unknown database", () => {
    expect(databaseIdSchema.safeParse("ExampleClient").success).toBe(false);
  });
});

describe("sourceRefSchema", () => {
  it("parses a full source reference", () => {
    expect(sourceRefSchema.parse(openFdaSource)).toEqual(openFdaSource);
  });

  it("requires an ISO timestamp and a known database", () => {
    expect(
      sourceRefSchema.safeParse({ ...openFdaSource, retrievedAt: "2026-10-21" })
        .success,
    ).toBe(false);
    expect(
      sourceRefSchema.safeParse({ ...openFdaSource, database: "example" })
        .success,
    ).toBe(false);
  });

  it("strips unknown keys", () => {
    const parsed = sourceRefSchema.parse({
      ...openFdaSource,
      client: "@knorby/openfda-client",
    });

    expect(parsed).toEqual(openFdaSource);
    expect(parsed).not.toHaveProperty("client");
  });
});

describe("productRefSchema", () => {
  const product = {
    name: "Amlodipine Besylate 5 mg tablet",
    brand: "Norvasc",
    category: "medication",
    identifiers: {
      ndc: ["00093-1046-01"],
      upc: ["0030093104601"],
      rxcui: ["197361"],
      splSetId: "0f2c7a1e-0000-4000-8000-000000000000",
      dsldId: 12345,
      applicationNumber: "NDA019787",
      slug: "norvasc-5-mg",
    },
    source: openFdaSource,
    matchBasis: "name match",
    summary: "Calcium channel blocker.",
  };

  it("parses a fully populated product reference", () => {
    const parsed: ProductRef = productRefSchema.parse(product);

    expect(parsed).toEqual(product);
    expect(parsed.category).toBe("medication");
  });

  it("strips unknown keys at every level", () => {
    const parsed = productRefSchema.parse({
      ...product,
      unexpected: true,
      identifiers: { ...product.identifiers, drugbank: "DB00381" },
      source: { ...openFdaSource, raw: "<payload>" },
    });

    expect(parsed).toEqual(product);
    expect(parsed.identifiers).not.toHaveProperty("drugbank");
    expect(parsed.source).not.toHaveProperty("raw");
  });

  it("requires identifiers and a source", () => {
    const minimal = { name: product.name, source: product.source };

    expect(productRefSchema.safeParse(minimal).success).toBe(false);
    expect(
      productRefSchema.safeParse({
        ...minimal,
        identifiers: product.identifiers,
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown category", () => {
    expect(
      productRefSchema.safeParse({ ...product, category: "food" }).success,
    ).toBe(false);
  });
});

describe("ingredientRefSchema", () => {
  const ingredient = {
    name: "Squalane",
    inciName: "Squalane",
    role: "inactive",
    quantity: "5%",
    identifiers: {
      unii: "GW89575KF9",
      cas: ["111-01-3"],
      ec: ["203-825-6"],
      rxcui: ["1791609"],
      structId: 123456,
      cid: [8082],
      inchiKey: "PRQVTJKVKGNXFR-UHFFFAOYSA-N",
      slug: "squalane",
    },
    source: {
      database: "INKEEDecoder",
      id: "squalane",
      url: "https://inkeedecoder.com/ingredients/squalane",
      retrievedAt: "2026-10-21T12:00:00.000Z",
    },
    matchBasis: "INCI name match",
    summary: "Preservative; see Annex V.",
  };

  it("parses a fully populated ingredient reference", () => {
    const parsed: IngredientRef = ingredientRefSchema.parse(ingredient);

    expect(parsed).toEqual(ingredient);
    expect(parsed.role).toBe("inactive");
  });

  it("strips unknown keys at every level", () => {
    const parsed = ingredientRefSchema.parse({
      ...ingredient,
      unexpected: true,
      identifiers: { ...ingredient.identifiers, smiles: "CC(C)..." },
    });

    expect(parsed).toEqual(ingredient);
    expect(parsed.identifiers).not.toHaveProperty("smiles");
  });

  it("rejects an unknown role", () => {
    expect(
      ingredientRefSchema.safeParse({ ...ingredient, role: "excipient" })
        .success,
    ).toBe(false);
  });
});

describe("nextStepSchema", () => {
  it("parses a follow-up call with an arbitrary input record", () => {
    const step = {
      tool: "drugdata_resolve_identifiers",
      input: { unii: "GW89575KF9", resolve_ingredients: false },
      why: "Resolve the ingredient against every source.",
    };

    expect(nextStepSchema.parse(step)).toEqual(step);
  });

  it("requires tool, input, and why", () => {
    expect(nextStepSchema.safeParse({ tool: "x", input: {} }).success).toBe(
      false,
    );
  });
});

describe("paginatedFields", () => {
  it("is a reusable zod shape with a 1-based page and hasMore", () => {
    const page = z.object(paginatedFields);

    expect(page.parse({ page: 1, hasMore: false })).toEqual({
      page: 1,
      hasMore: false,
    });
    expect(page.safeParse({ page: 0, hasMore: false }).success).toBe(false);
  });

  it("is also available as a standalone schema", () => {
    expect(paginatedFieldsSchema.parse({ page: 2, hasMore: true })).toEqual({
      page: 2,
      hasMore: true,
    });
  });
});
