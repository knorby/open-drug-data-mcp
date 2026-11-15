---
name: drug-ingredient-information
description: Use when researching a drug, supplement, or cosmetic ingredient, including its function, classification, chemistry, forms, dosing context, interactions, adverse effects, or toxicity.
---

# Ingredient information

Use `open-drug-data` for search → resolve → get mechanics, source limitations,
confidence rules, and cost flags.

## Research

1. Establish identity with `drugdata_search_ingredients` and, when needed,
   `drugdata_resolve_identifiers`. Follow `nextSteps`. Direct and derived links
   have different confidence evidence; candidates are possible matches, not
   confirmed identities. Disambiguate or ask rather than silently choosing.
2. Fetch only relevant source+id records with `drugdata_get_ingredient`:
   RxNorm/RxTerms for concepts and presentations, openFDA for substance
   identity, PubChem for chemistry, CosIng for cosmetic functions and
   regulatory entries, and INKEEDecoder for editorial cosmetic information.
   Use DrugCentral `include_clinical` only when clinical or safety content is
   needed. Its condition assertions are not a complete interaction database or
   treatment recommendations.
3. Search MedlinePlus or PubMed selectively and fetch only needed linked
   pages. Use actual product labels for labeled dosing directions; do not infer
   a universal ingredient dose. Keep product, strength, form, and units with
   any label-specific claim.

## Report

Include relevant, supported sections: preferred names, synonyms and identifiers;
function, classification and chemistry; uses and indications; known forms,
products and strengths; labeled dosing context; contraindications; interactions;
adverse effects and toxicity; regulatory notices; limitations; and sources.
FAERS counts are report contingencies, not incidence rates or proof of
causation.

Cite the upstream database or publisher and its deep link for each material
claim or section. Separate source statements from synthesis and identify
conflicts, unavailable sources, truncation, and unresolved identity. For
requested safety information not established, say
“not found in the consulted sources”; missing evidence does not establish safety.

Informational and research use only — not medical advice. Do not recommend
starting, stopping, or changing a product or dose; consult a qualified
professional for personal decisions.
