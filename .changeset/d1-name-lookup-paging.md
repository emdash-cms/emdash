---
"@emdash-cms/cloudflare": patch
---

Fixes `emdash migrate --d1 <name>` failing for every database name with "Cloudflare D1 database list total_pages is invalid". The D1 list endpoint does not return `total_pages`, so the page count is now derived from `total_count` and `per_page` when it is absent. A preview database whose name only contains the requested name (the `name` filter matches substrings) no longer fails the lookup either.
