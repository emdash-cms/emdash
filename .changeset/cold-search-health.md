---
"emdash": patch
---

Reduces D1 rows read by search and autocomplete on cold Workers isolates by skipping full row-count verification of existing search indexes. Missing indexes and indexes left empty by an interrupted rebuild are still repaired automatically. Partially populated indexes are no longer detected automatically; to repair one, send a `POST /_emdash/api/search/rebuild` request as an Admin (`search:manage` permission), with `X-EmDash-Request: 1` and a JSON body such as `{"collection":"articles"}`. Bearer tokens also require the `admin` scope. See [search index recovery](https://docs.emdashcms.com/reference/rest-api/#search-index-recovery) for the complete request and verification steps.
