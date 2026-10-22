import { XMLParser } from "fast-xml-parser";

/**
 * DailyMed SPL XML → label identity and ingredients.
 *
 * Structured Product Labeling documents are namespace-heavy HL7 XML. This
 * module is a pure, bounded extractor for the two things the product tools
 * need: the label's own identity (set id, version, product name, form, NDC
 * codes) and its ingredient rows with their UNIIs, roles, and strengths.
 *
 * The parser keeps document order (`preserveOrder`) so the first spelling of a
 * repeated ingredient wins, and strips namespace prefixes so the same walker
 * works for every SPL version. Two SPL ingredient shapes are handled:
 *
 * - `ingredient[classCode="ACTI"|"ACTIB"|…] > ingredientSubstance > code`
 * - `inactiveIngredient > inactiveIngredientSubstance > code`
 *
 * The substance `code` element carries the UNII
 * (`codeSystem="2.16.840.1.113883.4.9"`); its `displayName` is the registered
 * substance name and is preferred over the `<name>` child. ALL-CAPS names are
 * smart-cased for display, matching the openFDA adapter.
 *
 * Everything here is best-effort: malformed XML, missing metadata, and
 * unrecognized ingredient shapes produce empty fields or lists, never a throw.
 */

/** UNII code system OID (FDA Substance Registration System). */
const UNII_CODE_SYSTEM = "2.16.840.1.113883.4.9";

/** NDC code system OID used by SPL product and package codes. */
const NDC_CODE_SYSTEM = "2.16.840.1.113883.6.69";

/** Ingredient rows kept per label; a bound, not a claim of completeness. */
const MAX_INGREDIENTS = 100;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
});

/** Ordered-parser node: `{ tag: Node[], ":@": attrs }` or `{ "#text": s }`. */
type Node = Record<string, unknown>;

/** How an ingredient participates in the labeled product. */
export type SplIngredientRole = "active" | "inactive" | "unknown";

/** One label ingredient with the identifiers and amounts SPL states. */
export interface SplIngredient {
  name: string;
  unii?: string;
  role: SplIngredientRole;
  strength?: string;
  form?: string;
}

/** The label metadata and ingredient rows extracted from one SPL document. */
export interface SplLabel {
  setid?: string;
  version?: string;
  effectiveTime?: string;
  productName?: string;
  dosageForm?: string;
  labeler?: string;
  ndcs: string[];
  ingredients: SplIngredient[];
}

/** Returns the element name of a parsed node, ignoring attributes/text. */
function tagName(node: Node): string | null {
  for (const key of Object.keys(node)) {
    if (key !== ":@" && key !== "#text") return key;
  }
  return null;
}

/** Returns a node's child element list. */
function childrenOf(node: Node): Node[] {
  const tag = tagName(node);
  if (tag === null) return [];
  // preserveOrder gives every element an array of children (empty when it has
  // none), so no shape check is needed.
  return node[tag] as Node[];
}

/** Returns a node's attributes, with their `@_` prefix intact. */
function attrsOf(node: Node): Record<string, unknown> {
  const raw = node[":@"];
  return raw !== null && typeof raw === "object"
    ? (raw as Record<string, unknown>)
    : {};
}

/** Reads one string attribute, or `undefined` when absent or blank. */
function attrValue(node: Node, attr: string): string | undefined {
  const value = attrsOf(node)[`@_${attr}`];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/** Concatenated text content of a subtree. */
function textOf(node: Node): string {
  if (typeof node["#text"] === "string") return node["#text"];
  return childrenOf(node).map(textOf).join("");
}

/** The first descendant node with the given tag, depth-first. */
function findDescendant(nodes: Node[], tag: string): Node | null {
  for (const node of nodes) {
    if (tagName(node) === tag) return node;
    const found = findDescendant(childrenOf(node), tag);
    if (found !== null) return found;
  }
  return null;
}

/** Every descendant node with the given tag, in document order. */
function findDescendants(nodes: Node[], tag: string): Node[] {
  const found: Node[] = [];
  for (const node of nodes) {
    if (tagName(node) === tag) found.push(node);
    found.push(...findDescendants(childrenOf(node), tag));
  }
  return found;
}

/**
 * Finds the product `manufacturedProduct` element: the first one whose direct
 * children include the product `<name>`. SPL nests one manufacturedProduct per
 * packaging level, so the direct-child check picks the product-bearing node
 * rather than an outer wrapper or the author organization.
 */
function findProductNode(nodes: Node[]): Node | null {
  for (const node of nodes) {
    const children = childrenOf(node);
    if (
      tagName(node) === "manufacturedProduct" &&
      children.some((child) => tagName(child) === "name")
    ) {
      return node;
    }
    const found = findProductNode(children);
    if (found !== null) return found;
  }
  return null;
}

/** Smart-cases ALL-CAPS display text; technical casing passes through. */
function smartCase(value: string): string {
  return value
    .split(/(\s+)/)
    .map((chunk) => (/^\s+$/.test(chunk) ? chunk : fixToken(chunk)))
    .join("");
}

/** Domain acronyms that must not be title-cased. */
const ACRONYMS = new Set([
  "FDA",
  "OTC",
  "NDC",
  "USP",
  "USAN",
  "INN",
  "INCI",
  "UNII",
  "GRAS",
  "CAS",
  "GMP",
  "NSF",
  "SPF",
  "UV",
  "UVA",
  "UVB",
  "BHA",
  "AHA",
  "PHA",
  "PABA",
  "SLS",
  "SLES",
  "EDTA",
  "PEG",
  "PPG",
  "DEA",
  "TEA",
  "MEA",
  "BHT",
  "NMF",
  "PCA",
  "DMAE",
  "EGF",
  "NAD",
  "NADH",
  "NAC",
  "ATP",
  "MSM",
  "DHA",
  "EPA",
  "ALA",
  "CLA",
  "GLA",
  "GABA",
  "HMB",
  "PQQ",
  "BCAA",
  "EAA",
  "IU",
  "RDA",
  "DV",
  "API",
  "NSAID",
  "SSRI",
  "HRT",
]);

/** Applies the casing rules to one whitespace-delimited token. */
function fixToken(token: string): string {
  if (!/[A-Z]/.test(token)) return token;
  if (/[a-z0-9+]/.test(token)) return token;
  if (token.replace(/[^A-Za-z]/g, "").length <= 2) return token;
  return token
    .split(/([-/()])/)
    .map((part) => {
      if (part === "" || /[-/()]/.test(part)) return part;
      if (part.length <= 2) return part;
      if (ACRONYMS.has(part)) return part;
      return part.charAt(0) + part.slice(1).toLowerCase();
    })
    .join("");
}

/** One quantity element as display text (`10 mg/5 mL`, `30 [hp_X]/g`). */
function amountText(node: Node): string | undefined {
  const value = attrValue(node, "value");
  if (value === undefined) return undefined;
  const unit = attrValue(node, "unit");
  return unit === undefined ? value : `${value} ${unit}`;
}

/**
 * The ingredient's strength from its own `<quantity>` child.
 *
 * A denominator of `1` with no unit is the SPL spelling of a plain strength
 * (`10 mg/1`), so it is dropped. Other denominators keep their value and unit.
 */
function strengthOf(ingredient: Node): string | undefined {
  const quantity = childrenOf(ingredient).find(
    (child) => tagName(child) === "quantity",
  );
  if (quantity === undefined) return undefined;

  const children = childrenOf(quantity);
  const numerator = children.find((child) => tagName(child) === "numerator");
  if (numerator === undefined) return undefined;
  const numeratorText = amountText(numerator);
  if (numeratorText === undefined) return undefined;

  const denominator = children.find(
    (child) => tagName(child) === "denominator",
  );
  if (denominator === undefined) return numeratorText;
  const denominatorValue = attrValue(denominator, "value");
  const denominatorUnit = attrValue(denominator, "unit");
  if (denominatorValue === undefined) return numeratorText;
  // "per 1 g" is written as "/g"; "per 1" with no unit is a plain strength.
  if (denominatorValue === "1") {
    return denominatorUnit === undefined
      ? numeratorText
      : `${numeratorText}/${denominatorUnit}`;
  }
  const denominatorText =
    denominatorUnit === undefined
      ? denominatorValue
      : `${denominatorValue} ${denominatorUnit}`;
  return `${numeratorText}/${denominatorText}`;
}

/** Name, UNII, and form from a substance node's `code`/`name`/`formCode`. */
function substanceIdentity(substance: Node): {
  name: string;
  unii?: string;
  form?: string;
} | null {
  const children = childrenOf(substance);
  const codeNode = children.find((child) => tagName(child) === "code");
  const nameNode = children.find((child) => tagName(child) === "name");
  const formNode = children.find((child) => tagName(child) === "formCode");

  const displayName =
    codeNode === undefined ? undefined : attrValue(codeNode, "displayName");
  const nameText = nameNode === undefined ? undefined : textOf(nameNode).trim();
  const unii =
    codeNode !== undefined &&
    attrValue(codeNode, "codeSystem") === UNII_CODE_SYSTEM
      ? attrValue(codeNode, "code")
      : undefined;
  const form =
    formNode === undefined ? undefined : attrValue(formNode, "displayName");

  const name =
    displayName ??
    (nameText !== undefined && nameText.length > 0 ? nameText : undefined);
  if (name === undefined) {
    // A coded substance without a name is still identifiable by its UNII,
    // which must not be smart-cased like prose.
    if (unii === undefined) return null;
    return {
      name: unii,
      unii,
      ...(form !== undefined ? { form } : {}),
    };
  }
  return {
    name: smartCase(name),
    ...(unii !== undefined ? { unii } : {}),
    ...(form !== undefined ? { form } : {}),
  };
}

/** Classifies one ingredient element by tag and SPL class code. */
function roleOf(tag: string, classCode: string | undefined): SplIngredientRole {
  if (tag === "inactiveIngredient") return "inactive";
  if (classCode?.startsWith("ACT") === true) return "active";
  if (classCode?.startsWith("IACT") === true) return "inactive";
  return "unknown";
}

/** Walks the tree collecting ingredient rows with an identity. */
function collect(nodes: Node[], out: SplIngredient[], limit: number): void {
  for (const node of nodes) {
    if (out.length >= limit) return;
    const tag = tagName(node);
    const children = childrenOf(node);
    if (tag === "ingredient" || tag === "inactiveIngredient") {
      const substanceTag =
        tag === "inactiveIngredient"
          ? "inactiveIngredientSubstance"
          : "ingredientSubstance";
      const substance = findDescendant(children, substanceTag);
      const identity = substance === null ? null : substanceIdentity(substance);
      if (identity !== null) {
        const strength = strengthOf(node);
        out.push({
          ...identity,
          role: roleOf(tag, attrValue(node, "classCode")),
          ...(strength !== undefined ? { strength } : {}),
        });
      }
    }
    collect(children, out, limit);
  }
}

/** Deduplicates ingredient rows case-insensitively, first wins. */
function uniqueIngredients(entries: readonly SplIngredient[]): SplIngredient[] {
  const seen = new Set<string>();
  const out: SplIngredient[] = [];
  for (const entry of entries) {
    const key = entry.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
    if (out.length >= MAX_INGREDIENTS) break;
  }
  return out;
}

/** Parses a document, treating malformed XML as an empty label. */
function parseNodes(xml: string): Node[] {
  if (xml.trim().length === 0) return [];
  try {
    return parser.parse(xml, true) as Node[];
  } catch {
    return [];
  }
}

/** The document element of a parsed SPL payload, if one exists. */
function documentNode(nodes: Node[]): Node | null {
  return nodes.find((node) => tagName(node) === "document") ?? null;
}

/** Reads one direct-child attribute. */
function childAttr(
  children: readonly Node[],
  tag: string,
  attr: string,
): string | undefined {
  const node = children.find((child) => tagName(child) === tag);
  return node === undefined ? undefined : attrValue(node, attr);
}

/** Reads one direct-child text value. */
function childText(children: readonly Node[], tag: string): string | undefined {
  const node = children.find((child) => tagName(child) === tag);
  if (node === undefined) return undefined;
  const text = textOf(node).trim();
  return text.length > 0 ? text : undefined;
}

/** Extracts label metadata and ingredient rows from one SPL document. */
export function parseSplLabel(xml: string): SplLabel {
  const nodes = parseNodes(xml);
  const document = documentNode(nodes);
  if (document === null) return { ndcs: [], ingredients: [] };

  const children = childrenOf(document);
  const product = findProductNode(children);
  const productChildren = product === null ? [] : childrenOf(product);
  const labeler = findDescendant(children, "representedOrganization");
  const collected: SplIngredient[] = [];
  collect(children, collected, MAX_INGREDIENTS);
  const ndcs = [
    ...new Set(
      findDescendants(children, "code")
        .filter((node) => attrValue(node, "codeSystem") === NDC_CODE_SYSTEM)
        .map((node) => attrValue(node, "code"))
        .filter((code): code is string => code !== undefined),
    ),
  ];
  const setid = childAttr(children, "setId", "root");
  const version = childAttr(children, "versionNumber", "value");
  const effectiveTime = childAttr(children, "effectiveTime", "value");
  const productName = childText(productChildren, "name");
  const dosageForm = childAttr(productChildren, "formCode", "displayName");
  const labelerName =
    labeler === null ? undefined : childText(childrenOf(labeler), "name");

  return {
    ...(setid !== undefined ? { setid } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(effectiveTime !== undefined ? { effectiveTime } : {}),
    ...(productName !== undefined ? { productName } : {}),
    ...(dosageForm !== undefined ? { dosageForm } : {}),
    ...(labelerName !== undefined ? { labeler: labelerName } : {}),
    ndcs,
    ingredients: uniqueIngredients(collected),
  };
}

/** Extracts active and inactive ingredients with UNIIs from an SPL document. */
export function parseSplIngredients(xml: string): SplIngredient[] {
  return parseSplLabel(xml).ingredients;
}

/** LOINC section codes that carry dosage, directions, or patient guidance. */
export const SPL_USAGE_LOINC_CODES: readonly string[] = [
  "34068-7", // Dosage & Administration (OTC title: Directions)
  "59845-8", // Instructions for Use
  "42231-1", // SPL Medication Guide
  "42230-3", // SPL patient package insert (IFU may nest here)
  "68498-5", // Patient medication information
  "34076-0", // Information for patients / patient counseling
  "88436-1", // Patient counseling information
];

const USAGE_CODE_SET = new Set(SPL_USAGE_LOINC_CODES);

/** Usage sections kept per label; a bound, not a claim of completeness. */
const MAX_USAGE_SECTIONS = 20;

/** Characters kept per usage section before marking the extraction truncated. */
const MAX_USAGE_SECTION_CHARS = 8_000;

/** Visible note when a section's content was a table and cannot be flattened. */
const TABLE_NOTE =
  "[Table content omitted; open the hosted label for the table.]";

/** One usage section as the product tool exposes it. */
export interface SplUsageSection {
  heading: string;
  text: string;
}

/** Usage sections plus whether any section was omitted or shortened. */
export interface SplUsageExtraction {
  sections: SplUsageSection[];
  truncated: boolean;
  version?: string;
  effectiveTime?: string;
}

/** Concatenated text of a subtree, skipping table content; flags tables. */
function textSkippingTables(nodes: Node[]): {
  text: string;
  hasTable: boolean;
} {
  let text = "";
  let hasTable = false;
  for (const node of nodes) {
    if (typeof node["#text"] === "string") {
      text += node["#text"];
      continue;
    }
    const tag = tagName(node);
    if (tag === "table") {
      hasTable = true;
      continue;
    }
    if (tag === "section") continue; // nested sections are their own entries
    const inner = textSkippingTables(childrenOf(node));
    text += inner.text;
    if (inner.hasTable) hasTable = true;
  }
  return { text, hasTable };
}

/** Paragraph-level text of a matched section (paragraph/item only). */
function sectionBody(nodes: Node[]): { text: string; hasTables: boolean } {
  const paragraphs: string[] = [];
  let hasTables = false;
  const visit = (current: Node[]): void => {
    for (const node of current) {
      const tag = tagName(node);
      if (tag === "table") {
        hasTables = true;
        continue;
      }
      if (tag === "section") continue;
      if (tag === "paragraph" || tag === "item") {
        const inner = textSkippingTables(childrenOf(node));
        const trimmed = inner.text.trim();
        if (trimmed.length > 0) paragraphs.push(trimmed);
        if (inner.hasTable) hasTables = true;
        continue;
      }
      visit(childrenOf(node));
    }
  };
  visit(nodes);
  return { text: paragraphs.join("\n\n"), hasTables };
}

/** Walks sections in document order, collecting the usage LOINC codes. */
function walkUsageSections(
  nodes: Node[],
  out: SplUsageSection[],
  state: { truncated: boolean },
): void {
  for (const node of nodes) {
    const tag = tagName(node);
    const children = childrenOf(node);
    if (tag === "section") {
      const codeNode = children.find((child) => tagName(child) === "code");
      const code =
        codeNode === undefined ? undefined : attrValue(codeNode, "code");
      if (code !== undefined && USAGE_CODE_SET.has(code)) {
        if (out.length >= MAX_USAGE_SECTIONS) {
          state.truncated = true;
          return;
        }
        const titleNode = children.find((child) => tagName(child) === "title");
        const heading =
          titleNode === undefined ? code : textOf(titleNode).trim() || code;
        const body = sectionBody(children);
        let text = body.text;
        if (body.hasTables && text.length === 0) text = TABLE_NOTE;
        if (text.length > MAX_USAGE_SECTION_CHARS) {
          text = `${text.slice(0, MAX_USAGE_SECTION_CHARS)}…[truncated]`;
          state.truncated = true;
        }
        out.push({ heading, text });
      }
      walkUsageSections(children, out, state);
    } else {
      walkUsageSections(children, out, state);
    }
  }
}

/**
 * Extracts usage-oriented SPL sections (dosage, directions, patient guidance).
 *
 * Section text is paragraph-level and deliberately excludes table content,
 * which cannot be flattened faithfully; a table-only section carries a visible
 * note instead. The extraction is bounded and reports `truncated` when a
 * section was omitted or its text shortened. Pure; malformed XML is empty.
 */
export function extractSplUsageSections(xml: string): SplUsageExtraction {
  const nodes = parseNodes(xml);
  const document = documentNode(nodes);
  if (document === null) return { sections: [], truncated: false };

  const children = childrenOf(document);
  const sections: SplUsageSection[] = [];
  const state = { truncated: false };
  walkUsageSections(children, sections, state);
  const version = childAttr(children, "versionNumber", "value");
  const effectiveTime = childAttr(children, "effectiveTime", "value");

  return {
    sections,
    truncated: state.truncated,
    ...(version !== undefined ? { version } : {}),
    ...(effectiveTime !== undefined ? { effectiveTime } : {}),
  };
}

/** The public DailyMed label page for a set id. */
export function dailyMedLabelUrl(setid: string): string {
  return `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${encodeURIComponent(
    setid,
  )}`;
}
