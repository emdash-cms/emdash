---
"emdash": patch
---

Folds byline and taxonomy hydration into the content query, so fetching an entry or collection is a single database round trip instead of three (content, then bylines, then terms). Per-page query counts drop substantially — on the demo blog the article page goes from 24 statements to 16 and the index from 11 to 7 — which cuts time-to-first-byte on remote databases where each round trip is a network hop. Works on D1/SQLite and Postgres; entries with custom byline fields or author-fallback bylines transparently fall back to the previous query path.
