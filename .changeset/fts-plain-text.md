---
"emdash": patch
---

Fixes full-text search matching Portable Text's internal JSON instead of just prose. Searches for structural tokens like "normal", "span", or "block" no longer match documents whose visible text doesn't contain them, and search snippets show prose instead of JSON fragments. Existing search indexes are rebuilt automatically by a migration on upgrade — no manual reindex needed.
