---
"emdash": patch
---

Fixes silent `null` entries on wide-schema collections under Cloudflare D1. The content loader's single-query `LEFT JOIN _emdash_seo` added 5 alias columns to every result set, which pushed collections with ~95+ flat user fields past D1's per-query column limit (~100). The query failed with `D1_ERROR: too many columns in result set`, the error was wrapped as a generic `Failed to load entry`, and the call site surfaced `null`. SEO is now folded into a single aggregated JSON column (mirroring how byline and taxonomy hydration already work), keeping the result-set width bounded regardless of how wide the collection schema gets while preserving the single round trip.
