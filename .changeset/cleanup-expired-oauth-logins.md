---
"emdash": patch
---

Fixes expired OAuth tokens and unused login codes from `emdash login` and MCP clients staying in the database forever. Scheduled cleanup now deletes them after they expire.
