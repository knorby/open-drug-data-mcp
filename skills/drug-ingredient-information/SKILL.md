---
name: drug-ingredient-information
description: Use when researching a drug, supplement, or cosmetic ingredient, including its function, classification, chemistry, forms, dosing context, interactions, adverse effects, or toxicity.
---

# Ingredient information

Explain the ingredient in the context the user asked about: its practical
role, where it is used, and what the evidence supports. An ingredient can
serve different purposes in medicines, supplements, and cosmetics.

## Compose the answer

Use these categories as a familiar default outline, not a required checklist.
Match depth to the question: merge, omit, rename, or add categories as useful.
Use headings for an overview or grouped bullets for a narrow question.
Leave out empty headings and topics unrelated to the user's context.

- **What it is** — give the preferred name and a plain-language description
  of its function or class. Include synonyms, identifiers, and chemistry when
  they help explain the answer or distinguish a related substance.
- **How and where it’s used** — explain practical functions and applications.
  Translate classifications into what they mean in use: what the ingredient
  changes in a formulation or does biologically. Separate formulation roles,
  marketed benefits, and demonstrated effects.
- **Products, forms, and amounts** — give a few relevant product examples,
  forms, strengths, or formulation concentrations with units and context.
  Distinguish typical use levels from quantities confirmed in a named product.
  Add **Labeled dosing context** when dosing is relevant: use product labels
  with population, route, strength, and form, not a universal ingredient dose.
- **Safety and regulatory context** — cover relevant contraindications,
  interactions, adverse effects, toxicity, or cosmetic restrictions. Keep the
  route and exposure context attached; oral findings do not automatically
  describe topical use. A CosIng listing is not proof of approval or safety.
- **Evidence and limitations** — state uncertainties that affect the answer,
  such as sparse evidence, differing forms, or missing concentrations. When
  requested safety detail is “not found in the consulted sources,” state the
  gap without implying safety.
- **Sources** — provide a compact linked list when useful; inline citations
  can make a separate list unnecessary.

For **“how is xanthan used in skincare products?”**, lead with its formulation
role, not a drug profile. A useful answer explains how it thickens a runny
formula, helps stabilize emulsions, and affects texture. CosIng supplies
functions; INKEEDecoder adds practical explanation, including possible
stickiness and use with other thickeners. Its typical 0.1–0.5% range is
formulation context, not a measured amount in any particular serum.
[INKEEDecoder ingredient page](https://inkeedecoder.com/ingredients/xanthan-gum)

Then illustrate with selected real product examples, verifying ingredient lists:
the [Crop Niacinamide And Squalane Serum](https://inkeedecoder.com/products/crop-niacinamide-and-squalane-serum)
lists xanthan gum alongside other texture-modifying ingredients. That
demonstrates presence, not the manufacturer's intended role, concentration,
or proof that xanthan causes the serum's marketed benefits. Check current
records rather than assuming example formulations never change. For this
cosmetic-use question, RxNorm, DrugCentral, FAERS, and dosing are not defaults.

Write naturally using inline Markdown links or host-native citations beside
the relevant fact or paragraph. Name the upstream publisher in link text or
Sources and use the record's deep link, not the MCP server as authority.
Repeated “according to [database]” phrasing is unnecessary when the citation
already supplies attribution. Keep regulatory quotations short, attributed,
and verbatim; distinguish them from your explanation.

## Find supporting evidence

Use `open-drug-data` for search → resolve → get mechanics, source limitations,
confidence rules, and cost flags. Choose evidence for the answer's context:

- **Identity:** `drugdata_search_ingredients`, then relevant source+id records
  via `drugdata_get_ingredient`. Follow `nextSteps`; use
  `drugdata_resolve_identifiers` if identity needs clarification. Candidates
  remain possible matches; compare evidence before joining their facts.
- **Cosmetic functions and examples:** CosIng functions and regulatory entries;
  INKEEDecoder ingredient explanations and product lists. Use
  `drugdata_search_products` with `type: "ingredient"` and category `cosmetic`,
  then `drugdata_get_product` for a few relevant ingredient lists.
- **Drug forms, chemistry, or clinical questions:** RxNorm/RxTerms for concepts
  and presentations, PubChem for chemistry, and selective
  `drugdata_search_references` queries for MedlinePlus or PubMed links. Use
  DrugCentral `include_clinical` when clinical content is needed; its condition
  assertions are not a complete interaction database or treatment advice.
  FAERS counts are reporting counts, not incidence rates or proof of causation.
- **Gaps:** read needed linked pages and official product labels; supplement
  with primary sources for requested effects, interactions, or safety evidence
  that the MCP does not supply. Explain outages or truncation only when they
  limit the answer.

This is informational research, not medical advice. Present relevant labeled
directions as context; personal decisions about starting, stopping, or changing
a dose belong with a qualified professional.
