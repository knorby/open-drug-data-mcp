import { describe, expect, it } from "vitest";
import {
  dailyMedLabelUrl,
  parseSplIngredients,
  parseSplLabel,
} from "../src/sources/identity/spl.js";

/**
 * DailyMed SPL XML parsing is pure: these tests pin the two extraction paths
 * the product tool consumes — ingredient rows carrying UNIIs and roles, and
 * the label summary fields used to build a DailyMed product ref.
 */

const UNII_SYSTEM = "2.16.840.1.113883.4.9";
const NDC_SYSTEM = "2.16.840.1.113883.6.69";
const SETID = "a1e07d5c-2056-46f3-8737-f03ed0b4bae8";

/** Minimal namespaced SPL document wrapping the given body markup. */
function spl(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<document xmlns="urn:hl7-org:v3">
  <component>
    <structuredBody>
      <component>
        <section>
          <code code="47585-6" displayName="INGREDIENTS AND APPEARANCE"/>
          <subject>
            <manufacturedMaterial>${body}</manufacturedMaterial>
          </subject>
        </section>
      </component>
    </structuredBody>
  </component>
</document>`;
}

describe("parseSplIngredients", () => {
  it("maps ingredient classCode ACTI/ACTIB to active and IACT to inactive", () => {
    const xml = spl(`
      <ingredient classCode="ACTIB">
        <ingredientSubstance>
          <code code="3M4G523W1G" codeSystem="${UNII_SYSTEM}" displayName="SILVER"/>
        </ingredientSubstance>
      </ingredient>
      <ingredient classCode="IACT">
        <ingredientSubstance>
          <code code="059QF0KO0R" codeSystem="${UNII_SYSTEM}" displayName="WATER"/>
        </ingredientSubstance>
      </ingredient>`);

    expect(parseSplIngredients(xml)).toEqual([
      { name: "Silver", unii: "3M4G523W1G", role: "active" },
      { name: "Water", unii: "059QF0KO0R", role: "inactive" },
    ]);
  });

  it("extracts inactiveIngredient entries as inactive", () => {
    const xml = spl(`
      <inactiveIngredient>
        <inactiveIngredientSubstance>
          <code code="C9Q1J1T1FJ" codeSystem="${UNII_SYSTEM}" displayName="CROSPOVIDONE"/>
        </inactiveIngredientSubstance>
      </inactiveIngredient>`);

    expect(parseSplIngredients(xml)).toEqual([
      { name: "Crospovidone", unii: "C9Q1J1T1FJ", role: "inactive" },
    ]);
  });

  it("falls back to the substance name child", () => {
    const xml = spl(`
      <ingredient classCode="IACT">
        <ingredientSubstance>
          <name>ANHYDROUS CITRIC ACID</name>
        </ingredientSubstance>
      </ingredient>`);

    expect(parseSplIngredients(xml)).toEqual([
      { name: "Anhydrous Citric Acid", role: "inactive" },
    ]);
  });

  it("falls back to the UNII when the substance has no name", () => {
    const xml = spl(`
      <ingredient classCode="ACTI">
        <ingredientSubstance>
          <code code="ABCDEFGHIJ" codeSystem="${UNII_SYSTEM}"/>
          <formCode displayName="POWDER"/>
        </ingredientSubstance>
      </ingredient>`);

    expect(parseSplIngredients(xml)).toEqual([
      {
        name: "ABCDEFGHIJ",
        unii: "ABCDEFGHIJ",
        role: "active",
        form: "POWDER",
      },
    ]);

    const withoutForm = spl(`
      <ingredient classCode="ACTI">
        <ingredientSubstance>
          <code code="ABCDEFGHIJ" codeSystem="${UNII_SYSTEM}"/>
        </ingredientSubstance>
      </ingredient>`);
    expect(parseSplIngredients(withoutForm)).toEqual([
      { name: "ABCDEFGHIJ", unii: "ABCDEFGHIJ", role: "active" },
    ]);
  });

  it("keeps a missing UNII off an otherwise usable ingredient", () => {
    const xml = spl(`
      <ingredient classCode="ACTI">
        <ingredientSubstance>
          <code code="NOT-A-UNII" displayName="MYSTERY SUBSTANCE"/>
          <name>MYSTERY SUBSTANCE</name>
        </ingredientSubstance>
      </ingredient>`);

    expect(parseSplIngredients(xml)).toEqual([
      { name: "Mystery Substance", role: "active" },
    ]);
  });

  it("reports an unrecognized ingredient classCode as unknown", () => {
    const xml = spl(`
      <ingredient classCode="ADJV">
        <ingredientSubstance>
          <code code="ABCDEFGHIJ" codeSystem="${UNII_SYSTEM}" displayName="ADJUVANT"/>
        </ingredientSubstance>
      </ingredient>`);

    expect(parseSplIngredients(xml)).toEqual([
      { name: "Adjuvant", unii: "ABCDEFGHIJ", role: "unknown" },
    ]);
  });

  it("reads strength, form, and the UNII code system at the ingredient level", () => {
    const xml = spl(`
      <ingredient classCode="ACTIB">
        <quantity>
          <numerator unit="mg" value="10"/>
          <denominator unit="mL" value="5"/>
        </quantity>
        <ingredientSubstance>
          <code code="ABCDEFGHIJ" codeSystem="${UNII_SYSTEM}" displayName="ACTIVE THING"/>
          <formCode code="C123" displayName="POWDER"/>
        </ingredientSubstance>
      </ingredient>`);

    expect(parseSplIngredients(xml)).toEqual([
      {
        name: "Active Thing",
        unii: "ABCDEFGHIJ",
        role: "active",
        strength: "10 mg/5 mL",
        form: "POWDER",
      },
    ]);
  });

  it("renders a unitless denominator as a simple strength", () => {
    const xml = spl(`
      <ingredient classCode="ACTI">
        <quantity>
          <numerator unit="mg" value="10"/>
          <denominator value="1"/>
        </quantity>
        <ingredientSubstance>
          <name>ACTIVE THING</name>
        </ingredientSubstance>
      </ingredient>`);

    expect(parseSplIngredients(xml)[0]?.strength).toBe("10 mg");
  });

  it("keeps a numerator without a denominator or unit", () => {
    const xml = spl(`
      <ingredient classCode="ACTI">
        <quantity><numerator value="30"/></quantity>
        <ingredientSubstance><name>ACTIVE THING</name></ingredientSubstance>
      </ingredient>`);

    expect(parseSplIngredients(xml)[0]?.strength).toBe("30");
  });

  it("omits a quantity with no numerator value", () => {
    const xml = spl(`
      <ingredient classCode="ACTI">
        <quantity><numerator unit="mg"/></quantity>
        <ingredientSubstance><name>ACTIVE THING</name></ingredientSubstance>
      </ingredient>`);

    expect(parseSplIngredients(xml)[0]?.strength).toBeUndefined();
  });

  it("smart-cases ALL-CAPS names and preserves technical casing", () => {
    const xml = spl(`
      <inactiveIngredient>
        <inactiveIngredientSubstance>
          <code code="ABCDEFGHIJ" codeSystem="${UNII_SYSTEM}" displayName="MICROCRYSTALLINE CELLULOSE AND CoQ10"/>
        </inactiveIngredientSubstance>
      </inactiveIngredient>`);

    expect(parseSplIngredients(xml)).toEqual([
      {
        name: "Microcrystalline Cellulose And CoQ10",
        unii: "ABCDEFGHIJ",
        role: "inactive",
      },
    ]);
  });

  it("dedupes case-insensitively, first wins", () => {
    const block = (code: string, displayName: string) => `
      <subject>
        <manufacturedMaterial>
          <ingredient classCode="IACT">
            <ingredientSubstance>
              <code code="${code}" codeSystem="${UNII_SYSTEM}" displayName="${displayName}"/>
            </ingredientSubstance>
          </ingredient>
        </manufacturedMaterial>
      </subject>`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<document xmlns="urn:hl7-org:v3">
  <component>
    <structuredBody>
      <component><section>${block("059QF0KO0R", "WATER")}</section></component>
      <component><section>${block("ZZZZZZZZZZ", "water")}</section></component>
    </structuredBody>
  </component>
</document>`;

    expect(parseSplIngredients(xml)).toEqual([
      { name: "Water", unii: "059QF0KO0R", role: "inactive" },
    ]);
  });

  it("keeps short tokens and acronyms while title-casing the rest", () => {
    const xml = spl(`
      <inactiveIngredient>
        <inactiveIngredientSubstance>
          <code code="ABCDEFGHIJ" codeSystem="${UNII_SYSTEM}" displayName="IV IV-FLUID (SLS) ALPHA-HYDROXY ACID"/>
        </inactiveIngredientSubstance>
      </inactiveIngredient>`);

    expect(parseSplIngredients(xml)[0]?.name).toBe(
      "IV IV-Fluid (SLS) Alpha-Hydroxy Acid",
    );
  });

  it("ignores a quantity without a numerator or denominator value", () => {
    const noNumerator = spl(`
      <ingredient classCode="ACTI">
        <quantity><denominator value="5" unit="mL"/></quantity>
        <ingredientSubstance><name>ACTIVE THING</name></ingredientSubstance>
      </ingredient>`);
    expect(parseSplIngredients(noNumerator)[0]?.strength).toBeUndefined();

    const noDenominatorValue = spl(`
      <ingredient classCode="ACTI">
        <quantity>
          <numerator value="10" unit="mg"/>
          <denominator unit="mL"/>
        </quantity>
        <ingredientSubstance><name>ACTIVE THING</name></ingredientSubstance>
      </ingredient>`);
    expect(parseSplIngredients(noDenominatorValue)[0]?.strength).toBe("10 mg");

    const unitlessDenominator = spl(`
      <ingredient classCode="ACTI">
        <quantity>
          <numerator value="10" unit="mg"/>
          <denominator value="5"/>
        </quantity>
        <ingredientSubstance><name>ACTIVE THING</name></ingredientSubstance>
      </ingredient>`);
    expect(parseSplIngredients(unitlessDenominator)[0]?.strength).toBe(
      "10 mg/5",
    );
  });

  it("caps ingredient rows at one hundred", () => {
    const rows = Array.from(
      { length: 105 },
      (_, index) => `
      <ingredient classCode="ACTI">
        <ingredientSubstance><name>ITEM ${index}</name></ingredientSubstance>
      </ingredient>`,
    ).join("");
    const xml = spl(rows);

    expect(parseSplIngredients(xml)).toHaveLength(100);
  });

  it("returns an empty list for blank or malformed XML", () => {
    expect(parseSplIngredients("")).toEqual([]);
    expect(parseSplIngredients("   ")).toEqual([]);
    expect(parseSplIngredients("<document><not-closed")).toEqual([]);
  });

  it("ignores ingredient-like elements with no identity", () => {
    const xml = spl(`
      <ingredient classCode="ACTI">
        <ingredientSubstance><code code="ABCDEFGHIJ"/></ingredientSubstance>
      </ingredient>
      <ingredient classCode="IACT"></ingredient>`);

    expect(parseSplIngredients(xml)).toEqual([]);
  });
});

describe("parseSplLabel", () => {
  it("extracts the set id, version, effective time, product identity, form, labeler, and NDCs", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<document xmlns="urn:hl7-org:v3">
  <effectiveTime value="20261013"/>
  <setId root="${SETID}"/>
  <versionNumber value="2"/>
  <author>
    <assignedEntity>
      <representedOrganization><name>Example Labeler</name></representedOrganization>
    </assignedEntity>
  </author>
  <component>
    <structuredBody>
      <component>
        <section>
          <code code="48780-1"/>
          <subject>
            <manufacturedProduct>
              <manufacturedProduct>
                <code code="52166-022" codeSystem="${NDC_SYSTEM}"/>
                <name>SOVEREIGN SILVER HOMEOPATHIC WOUND WASH</name>
                <formCode code="C42953" displayName="LIQUID"/>
                <ingredient classCode="ACTIB">
                  <ingredientSubstance>
                    <code code="3M4G523W1G" codeSystem="${UNII_SYSTEM}" displayName="SILVER"/>
                  </ingredientSubstance>
                </ingredient>
                <asContent>
                  <containerPackagedProduct>
                    <code code="52166-022-01" codeSystem="${NDC_SYSTEM}"/>
                  </containerPackagedProduct>
                </asContent>
              </manufacturedProduct>
            </manufacturedProduct>
          </subject>
        </section>
      </component>
    </structuredBody>
  </component>
</document>`;

    const label = parseSplLabel(xml);
    expect(label.setid).toBe(SETID);
    expect(label.version).toBe("2");
    expect(label.effectiveTime).toBe("20261013");
    expect(label.productName).toBe("SOVEREIGN SILVER HOMEOPATHIC WOUND WASH");
    expect(label.dosageForm).toBe("LIQUID");
    expect(label.labeler).toBe("Example Labeler");
    expect(label.ndcs).toEqual(["52166-022", "52166-022-01"]);
    expect(label.ingredients).toEqual([
      { name: "Silver", unii: "3M4G523W1G", role: "active" },
    ]);
  });

  it("returns empty defaults when the document has no usable metadata", () => {
    expect(parseSplLabel("")).toEqual({ ndcs: [], ingredients: [] });
    expect(parseSplLabel("<document/>")).toEqual({
      ndcs: [],
      ingredients: [],
    });
  });

  it("omits a blank product name, form, and labeler name", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<document xmlns="urn:hl7-org:v3">
  <author>
    <assignedEntity>
      <representedOrganization></representedOrganization>
    </assignedEntity>
  </author>
  <component>
    <structuredBody>
      <component>
        <section>
          <subject>
            <manufacturedProduct>
              <name>   </name>
            </manufacturedProduct>
          </subject>
        </section>
      </component>
    </structuredBody>
  </component>
</document>`;

    const label = parseSplLabel(xml);
    expect(label.productName).toBeUndefined();
    expect(label.dosageForm).toBeUndefined();
    expect(label.labeler).toBeUndefined();
  });
});

describe("dailyMedLabelUrl", () => {
  it("builds the public label page and escapes the set id", () => {
    expect(dailyMedLabelUrl(SETID)).toBe(
      `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${SETID}`,
    );
    expect(dailyMedLabelUrl("a b")).toContain("a%20b");
  });
});
