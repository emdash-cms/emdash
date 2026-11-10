---
"emdash": patch
---

Fixes backup downloads and preview snapshots failing on Cloudflare D1 for sites with a lot of content or revision history. From November 4, 2026, D1 rejects query results larger than 50 MB. Backups and snapshots now stay under that limit and contain the same data as before.
