---
"repo-template-typescript-mcp": patch
---

Refresh dependencies and tooling versions: tsup 8 → 9, Vitest 5.0.5, MCP
Inspector 2.11, commitlint 21.2.4, and Zod 4.6.7. Pin the pre-commit TruffleHog
rev to v3.99.2, sync the Biome and Changesets config schema versions, fix the
stale release-workflow reference in `.changeset/README.md`, group production and
GitHub Actions Dependabot updates, and ignore agent planning scratch directories
(`.superpowers/`, `docs/superpowers/`).
