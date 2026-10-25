# DSLD fixtures

These fixtures are **hand-authored** on 2026-10-22 from the documented v9
response types in `@knorby/nih-dsld-client` v0.1.1, not captured from the live
API: the NIH DSLD API requires a data.gov key in practice and none was
available in this environment. Each JSON file repeats that provenance in its
top-level `_note` field (the client ignores unknown keys).

They pin this server's mapping only; they are not evidence of upstream shape
drift.
