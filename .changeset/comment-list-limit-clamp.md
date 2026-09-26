---
"emdash": patch
---

Fixes comment listings so a negative `limit` no longer returns every comment and a fractional `limit` no longer fails with a 500. The page size is rounded down and clamped to 1–100 on the public comments endpoint, the moderation inbox, and plugin comment reads; a missing or non-numeric `limit` uses the default of 50.
