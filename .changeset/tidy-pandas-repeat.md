---
"emdash": patch
---

Fixes the content editor recomputing taxonomy term usage counts every time it opens. The editor's taxonomy picker never shows counts, but it shares the terms endpoint with the Taxonomies settings page, which does — so opening an entry aggregated the whole content–term assignment table once per applicable taxonomy. `GET /_emdash/api/taxonomies/:name/terms` now takes an `includeCounts` query param (default `true`, so existing callers are unaffected); pass `includeCounts=false` to skip the aggregate, and `count` is then omitted from each term in the response.
