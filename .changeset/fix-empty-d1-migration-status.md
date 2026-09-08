---
"@emdash-cms/cloudflare": patch
---

Fixes deployment-managed D1 migrations failing on a completely empty database before Kysely can create its migration tables. Migration status now reports empty history without writing, and apply can initialize and run the pending migrations.
