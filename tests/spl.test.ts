import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  dailyMedLabelUrl,
  extractSplUsageSections,
  parseSplIngredients,
  parseSplLabel,
  SPL_USAGE_LOINC_CODES,
} from "../src/sources/identity/spl-ingredients.js";

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

  it("preserves word boundaries across inline markup in names and labelers", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<document xmlns="urn:hl7-org:v3">
  <setId root="${SETID}"/>
  <author>
    <assignedEntity>
      <representedOrganization>
        <name>Example <content>Labeler</content></name>
      </representedOrganization>
    </assignedEntity>
  </author>
  <component>
    <structuredBody>
      <component>
        <section>
          <subject>
            <manufacturedProduct>
              <manufacturedProduct>
                <name>ACETAMINOPHEN <content>500</content> MG</name>
                <ingredient classCode="ACTI">
                  <ingredientSubstance>
                    <name>ACTIVE <content>THING</content></name>
                  </ingredientSubstance>
                </ingredient>
              </manufacturedProduct>
            </manufacturedProduct>
          </subject>
        </section>
      </component>
    </structuredBody>
  </component>
</document>`;

    const label = parseSplLabel(xml);
    expect(label.productName).toBe("ACETAMINOPHEN 500 MG");
    expect(label.labeler).toBe("Example Labeler");
    expect(label.ingredients).toEqual([
      { name: "Active Thing", role: "active" },
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

/** A namespaced SPL document wrapping one or more section components. */
function usageSpl(sections: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<document xmlns="urn:hl7-org:v3">
  <effectiveTime value="20261013"/>
  <versionNumber value="2"/>
  <component>
    <structuredBody>${sections}</structuredBody>
  </component>
</document>`;
}

/** One section with a LOINC code, optional title, and text markup. */
function section(
  code: string,
  body: string,
  title?: string,
  nested = "",
): string {
  return `<component><section>
    <code code="${code}" codeSystem="2.16.840.1.113883.6.1"/>
    ${title === undefined ? "" : `<title>${title}</title>`}
    <text>${body}</text>
    ${nested}
  </section></component>`;
}

describe("extractSplUsageSections", () => {
  it("extracts a usage section with its heading, paragraph text, and label version", () => {
    const xml = usageSpl(
      section(
        "34068-7",
        "<paragraph>Clean the area and spray 1 to 3 times a day.</paragraph>",
        "Directions",
      ),
    );

    expect(extractSplUsageSections(xml)).toEqual({
      sections: [
        {
          heading: "Directions",
          text: "Clean the area and spray 1 to 3 times a day.",
        },
      ],
      truncated: false,
      version: "2",
      effectiveTime: "20261013",
    });
    expect(SPL_USAGE_LOINC_CODES).toContain("34068-7");
  });

  it("preserves the exact Directions text and <br/> boundary from a real SPL", () => {
    const xml = readFileSync(
      new URL("./fixtures/nlm/dailymed-spl-a1e07d5c.xml", import.meta.url),
      "utf8",
    );

    expect(extractSplUsageSections(xml).sections).toEqual([
      {
        heading: "Directions",
        text: "Clean affected area by thoroughly spraying it 1 to 3 times a day, oras needed to relieve symptoms, Cover with a bandage if needed.\nSafe on sensitive skin. May be used in conjunction with Sovereign Silver Homeopathic First Aid Gel.",
      },
    ]);
  });

  it("ignores sections outside the usage LOINC set", () => {
    const xml = usageSpl(
      section(
        "55105-1",
        "<paragraph>Topical antiseptic.</paragraph>",
        "Purpose",
      ),
    );

    expect(extractSplUsageSections(xml)).toEqual({
      sections: [],
      truncated: false,
      version: "2",
      effectiveTime: "20261013",
    });
  });

  it("falls back to the LOINC code when a matching section has no title", () => {
    const xml = usageSpl(
      section("59845-8", "<paragraph>Use as directed.</paragraph>"),
    );

    expect(extractSplUsageSections(xml).sections).toEqual([
      { heading: "59845-8", text: "Use as directed." },
    ]);
  });

  it("keeps paragraph and item text while skipping table content", () => {
    const xml = usageSpl(
      section(
        "42231-1",
        `<paragraph>Take with food.</paragraph>
         <table><tr><td>Hidden table cell</td></tr></table>
         <list><item>Do not crush.</item></list>`,
        "Medication Guide",
      ),
    );

    const extraction = extractSplUsageSections(xml);
    expect(extraction.sections).toEqual([
      {
        heading: "Medication Guide",
        text: "Take with food.\n\nDo not crush.\n\n[Table content omitted; open the hosted label for the table.]",
      },
    ]);
    expect(extraction.truncated).toBe(true);
  });

  it("flags a table-only section and does not flatten the table", () => {
    const xml = usageSpl(
      section(
        "34068-7",
        "<table><tr><td>Hidden table cell</td></tr></table>",
        "Directions",
      ),
    );

    const extraction = extractSplUsageSections(xml);
    expect(extraction.sections).toEqual([
      {
        heading: "Directions",
        text: "[Table content omitted; open the hosted label for the table.]",
      },
    ]);
    expect(extraction.truncated).toBe(true);
  });

  it("keeps direct text when a usage section has no paragraphs or items", () => {
    const xml = usageSpl(
      section("34068-7", "Apply sparingly to the affected area.", "Directions"),
    );

    expect(extractSplUsageSections(xml).sections).toEqual([
      { heading: "Directions", text: "Apply sparingly to the affected area." },
    ]);
  });

  it("falls back to direct markup when a section has no text wrapper", () => {
    const xml = usageSpl(
      `<component><section>
        <code code="34068-7" codeSystem="2.16.840.1.113883.6.1"/>
        <title>Directions</title>
        <content>Direct outside text.</content>
      </section></component>`,
    );

    expect(extractSplUsageSections(xml).sections).toEqual([
      { heading: "Directions", text: "Direct outside text." },
    ]);
  });

  it("extracts nested usage sections separately and skips them in the parent text", () => {
    const xml = usageSpl(
      section(
        "42230-3",
        "<paragraph>Outer guidance.</paragraph>",
        "Patient Package Insert",
        section(
          "34068-7",
          "<paragraph>Inner directions.</paragraph>",
          "Directions",
        ),
      ),
    );

    expect(extractSplUsageSections(xml).sections).toEqual([
      { heading: "Patient Package Insert", text: "Outer guidance." },
      { heading: "Directions", text: "Inner directions." },
    ]);
  });

  it("skips empty paragraphs and nested sections and ignores uncoded sections", () => {
    const xml = usageSpl(
      `<component><section><text><paragraph>No code here.</paragraph></text></section></component>` +
        section(
          "34068-7",
          `<paragraph>Before <content><table><tr><td>Hidden</td></tr></table></content> after</paragraph>
           <paragraph><section><code code="55105-1"/><text><paragraph>Ignored</paragraph></text></section></paragraph>
           <paragraph>   </paragraph>
           <paragraph>Use as directed.</paragraph>`,
          "Directions",
        ) +
        section("59845-8", "<paragraph>Use.</paragraph>", "   "),
    );

    const extraction = extractSplUsageSections(xml);
    expect(extraction.sections).toEqual([
      {
        heading: "Directions",
        text: "Before after\n\nUse as directed.\n\n[Table content omitted; open the hosted label for the table.]",
      },
      { heading: "59845-8", text: "Use." },
    ]);
    expect(extraction.truncated).toBe(true);
  });

  it("omits version fields when the document has none", () => {
    const xml = `<document><component><structuredBody>${section(
      "34068-7",
      "<paragraph>Use.</paragraph>",
      "Directions",
    )}</structuredBody></component></document>`;

    expect(extractSplUsageSections(xml)).toEqual({
      sections: [{ heading: "Directions", text: "Use." }],
      truncated: false,
    });
  });

  it("truncates an oversized section text and reports it", () => {
    const xml = usageSpl(
      section(
        "34068-7",
        `<paragraph>${"x".repeat(9_000)}</paragraph>`,
        "Directions",
      ),
    );

    const extraction = extractSplUsageSections(xml);
    expect(extraction.truncated).toBe(true);
    expect(extraction.sections).toHaveLength(1);
    expect(extraction.sections[0]?.text.endsWith("…[truncated]")).toBe(true);
    expect(extraction.sections[0]?.text.length).toBe(
      8_000 + "…[truncated]".length,
    );
  });

  it("caps the number of sections and reports truncation", () => {
    const sections = Array.from({ length: 25 }, (_, index) =>
      section(
        "34068-7",
        `<paragraph>Directions ${index}.</paragraph>`,
        `Directions ${index}`,
      ),
    ).join("");
    const extraction = extractSplUsageSections(usageSpl(sections));

    expect(extraction.sections).toHaveLength(20);
    expect(extraction.truncated).toBe(true);
  });

  it("returns empty defaults for blank or malformed XML", () => {
    expect(extractSplUsageSections("")).toEqual({
      sections: [],
      truncated: false,
    });
    expect(extractSplUsageSections("<document><not-closed")).toEqual({
      sections: [],
      truncated: false,
    });
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
