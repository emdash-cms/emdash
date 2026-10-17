---
"emdash": patch
---

Reduces database round trips for full-text searches, including searches with no matches, to improve response times on Cloudflare D1. Empty or whitespace-only searches no longer query the database.
