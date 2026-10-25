---
"@knorby/open-drug-data-mcp": minor
---

Full NLM coverage and sourcing cleanups: new `drugdata_search_references`
tool for PubMed, ClinicalTrials.gov, MeSH, MedlinePlus (topics, Genetics,
Connect), UMLS, RxClass, and the RxNorm prescribable name list with
link-first results and cursor pagination; PubChem joins ingredient searches
(name, CID) and ingredient profiles (chemistry block); RxTerms presentation
now carries its own source attribution; client-library name filtering
removed in favor of errors authored at the source; legacy incidecoder.com
host handling removed. UMLS requires `UMLS_API_KEY`; PubMed accepts optional
`NLM_PUBMED_API_KEY`, `NLM_PUBMED_EMAIL`, and `NLM_PUBMED_TOOL`.
