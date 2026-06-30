---
"emdash": patch
---

Fixes the sitemap `<lastmod>` value so it is always a valid W3C Datetime. Timestamps stored via the database default (`datetime('now')` / `CURRENT_TIMESTAMP`) or carried in from imports were emitted as a space-separated `YYYY-MM-DD HH:MM:SS` string, which Google Search Console rejects as "Invalid date". They are now normalized to ISO 8601.
