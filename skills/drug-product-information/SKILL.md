---
name: drug-product-information
description: Use when researching a drug, supplement, or cosmetic product, its label, directions, ingredients, interactions, adverse effects, overdose, or toxicity.
---

# Product information

Turn product records into a clear explanation of what the product is, what it
contains, and what the user wants to know about it. Lead with the answer, not
the search history.

## Compose the answer

Use these categories as a familiar default outline, not a required checklist.
Match depth to the question: merge, omit, rename, or add categories as useful.
Use headings for a broad overview and a few grouped bullets for a narrow
question; leave out empty or irrelevant sections.

- **Overview** — identify the brand, product variant, category, and purpose in
  plain language. Separate marketed claims from established uses or evidence.
- **What’s in it** — explain the active ingredients and their roles, with
  quantities and units per serving or application. Mention inactive ingredients
  when they help explain the formulation, delivery, or a user concern.
- **Forms and variants** — compare supported strengths, dosage forms, and
  release types; explain differences that matter to this question. Keep each
  variant's facts together rather than combining several labels.
- **How it’s used** — summarize relevant labeled directions, route, timing, and
  dose/range with the intended population and source context. For cosmetics,
  explain application and product function instead of imposing a dosing section.
- **Safety and interactions** — prioritize relevant cautions, contraindications,
  interactions, adverse effects, and overdose or toxicity information. Explain
  what a warning concerns; distinguish ingredient-level evidence from warnings
  actually on this product's label.
- **What’s unclear** — briefly flag uncertainty that affects the answer:
  unresolved variant, missing requested evidence, or conflicting information.
  If requested safety information is “not found in the consulted sources,”
  state that gap without implying safety.
- **Sources** — use a compact linked list when it helps the reader revisit
  labels or references; inline citations can make a separate list unnecessary.

For **“tell me about Natrol Melatonin”**, start with the product's purpose,
then contents, strength/form, labeled use, and relevant cautions under the
categories above. If the query identifies a product family rather than one
variant, give a family-level overview and describe verified variants; ask for
the strength or package only when needed for a specific claim. If the exact
product remains unconfirmed, still explain supported **general melatonin**
context under a clearly labeled heading. Offer genuinely plausible candidate
products or request a label/photo to resolve identity. A different brand's
1 mg product is not evidence about Natrol's ingredients or directions.

Write naturally using inline Markdown links or host-native citations beside
the relevant fact or paragraph. Name the upstream publisher in link text or a
Sources entry and use the record's deep link, not the MCP server as authority.
Repeated “according to [database]” phrasing adds little when the citation already
supplies attribution. Keep attributed label quotations short and verbatim.

## Find supporting evidence

Use `open-drug-data` for search → resolve → get mechanics, confidence rules,
source limitations, and cost flags. Select evidence to fill the answer:

- **Identity and variants:** `drugdata_search_products` with `type: "name"`;
  if the full name misses, retry only the brand or ingredient with that type.
  Follow `nextSteps` and compare brand, variant, strength, units, and dosage form
  before using a candidate's label.
- **Contents and directions:** `drugdata_get_product` for relevant source+id
  records. Explain ingredient rows rather than dumping them. DailyMed
  `include_label_sections` supplies usage text, not every safety section; read
  the linked official label for needed warnings and interactions.
- **Ingredient context and evidence gaps:** use `drugdata_search_ingredients`
  and `drugdata_get_ingredient` for relevant ingredient roles, and
  `drugdata_search_references` for MedlinePlus or PubMed links. Read the needed
  pages; supplement with current official labels or primary sources when the
  MCP lacks the requested detail. Keep general evidence distinct from this
  product's claims.

Explain source failures or truncation only when they limit the answer.
Labeled directions describe the label, not a personalized recommendation:
this is informational research, not medical advice. Personal decisions about
starting, stopping, or changing a dose belong with a qualified professional.
