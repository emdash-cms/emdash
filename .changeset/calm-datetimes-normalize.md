---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes datetime sorting and range queries by storing every content datetime as a UTC ISO string with fixed milliseconds. The admin converts date-and-time fields through the site's configured timezone, while API, MCP, and CLI writes now require `Z` or an explicit UTC offset.

The core migration reports noncanonical values before changing them, then normalizes content columns and revision snapshots in bounded batches. Legacy values without an offset use the site timezone. If a value falls in a repeated or skipped daylight-saving hour, the migration stops before writing and reports the content row or revision that needs an explicit offset.
