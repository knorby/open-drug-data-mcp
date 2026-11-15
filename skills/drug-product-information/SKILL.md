---
name: drug-product-information
description: Use when researching a drug, supplement, or cosmetic product, its label, directions, ingredients, interactions, adverse effects, overdose, or toxicity.
---

# Product information

Use `open-drug-data` for the general search → resolve → get mechanics,
confidence rules, source limitations, and cost flags.

## Research

1. Identify the exact marketed product and category. Search with
   `drugdata_search_products` using `type: "name"`. If a full name misses, retry
   with only the brand or only the ingredient, still using `type: "name"`;
   `type: "brand"` reaches fewer sources. Compare brand, variant, strength,
   units, and dosage form. Present plausible variants and ask rather than guess.
2. Follow `nextSteps` and fetch only relevant source+id records with
   `drugdata_get_product`. Use ingredient rows for contents; resolve individual
   ingredients only when needed. For DailyMed directions, request
   `include_label_sections`; its usage extraction does not cover every safety
   section. Read linked official labels for needed warnings and interactions.
3. Use MedlinePlus or selective supplementary searches for gaps, preferring
   current official labeling and primary sources. Do not bulk-crawl.

## Report

Include relevant, supported sections: identity and source; purpose; active and
inactive ingredients and quantities; forms and strengths; labeled directions
or dose/range; warnings and contraindications; interactions; adverse effects,
overdose or toxicity; limitations; and sources. Keep each product's variant,
strength, dosage form, and units attached to its claims. Distinguish
ingredient-level evidence from this product's labeling. Attribute label
directions to the label: they are not a personalized dosing recommendation.

Cite the upstream database or publisher and deep link for each material claim
or section. Separate source statements from synthesis and identify conflicts,
unavailable sources, truncation, and unresolved identity. For requested safety
information not established, say “not found in the consulted sources”; missing
evidence does not establish safety.

Informational and research use only — not medical advice. Do not recommend
starting, stopping, or changing a product or dose; consult a qualified
professional for personal decisions.
