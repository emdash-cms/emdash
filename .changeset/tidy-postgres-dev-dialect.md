---
"emdash": patch
---

Fixes PostgreSQL detection during `astro dev` with Cloudflare Hyperdrive, so plugin storage queries and index creation no longer fail with `function json_extract(text, unknown) does not exist` when Vite loads separate copies of Kysely.
