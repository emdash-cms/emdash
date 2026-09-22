---
"emdash": patch
---

The MCP `taxonomy_update_term` and `taxonomy_delete_term` tools accept an optional `locale`, so a term whose translations share a slug can be edited or deleted in one language without touching the others. Without `locale`, the tools still act on the lowest matching locale, as before.
