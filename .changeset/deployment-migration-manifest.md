---
"emdash": minor
---

Adds deployment-managed core migrations. Astro builds emit a validated, secret-free `.emdash/migrations.json` manifest for running the build's exact migration set before deployment, and EmDash templates ignore the generated file.
