---
"emdash": patch
---

Fixes 500 error on `GET /_emdash/api/dashboard` when running on Cloudflare D1 with many title-bearing collections. `fetchRecentItems` now issues one query per collection in parallel and merges results in JS instead of building a single chained `UNION ALL`, which trips D1's `SQLITE_LIMIT_COMPOUND_SELECT` cap once enough collections are present (#895).
