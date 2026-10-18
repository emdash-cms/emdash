---
"emdash": patch
---

Reduces database round trips for the `search()`, `searchCollection()`, and `getSuggestions()` helpers, including searches with no matches, to improve response times on Cloudflare D1. Empty or whitespace-only queries no longer query the database. Autocomplete also skips collections whose search indexes are missing.
