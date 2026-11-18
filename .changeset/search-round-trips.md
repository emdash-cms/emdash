---
"emdash": patch
---

Speeds up search on sites with more than one searchable collection, most noticeably on D1. `search()` and `GET /_emdash/api/search` now query every collection in one database round trip, where each collection used to take its own. The search index health check that runs on the first search API request per Workers isolate now uses two queries in total, where it used to run about six for each collection.
