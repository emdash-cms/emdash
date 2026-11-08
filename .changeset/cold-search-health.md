---
"emdash": patch
---

Reduces D1 rows read by search and autocomplete on cold Workers isolates by skipping full row-count verification of existing search indexes. Missing indexes and indexes left empty by an interrupted rebuild are still repaired automatically. Partially populated indexes are no longer detected automatically; to repair one, send an authenticated `POST /_emdash/api/search/rebuild` request with `X-EmDash-Request: 1` and a JSON body such as `{"collection":"articles"}`.
