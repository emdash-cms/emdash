---
"emdash": patch
---

Fixes taxonomy term counts being recomputed on every page render even when nothing displays them. Counting term usage aggregates the whole content–term assignment table for each taxonomy, and the layout prefetch ran it for every taxonomy on every HTML response — on Cloudflare D1 this could read millions of rows per page view. Counts are now computed only when a consumer asks for them: the prefetch never does, and the Tags and Categories widgets only when their `showCount` prop is on. `getTaxonomyTerms()` takes a new `includeCounts` option (default `true`) to opt out explicitly, and terms are cached separately from their counts so both callers share one term lookup.
