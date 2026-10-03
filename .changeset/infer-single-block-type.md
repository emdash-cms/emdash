---
"emdash": patch
---

Fixes content writes to single-type blocks fields rejecting blocks that omit `_type`, including nested Markdown conversion over MCP and the TypeScript client. EmDash infers the only allowed type on ordinary writes; multiple allowed types, restores, and stored blocks of a different type still require an explicit `_type`. Explicit invalid types remain errors.
