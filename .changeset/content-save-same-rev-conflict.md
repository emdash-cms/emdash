---
"emdash": patch
---

Fixes lost edits on D1, Durable Objects and PostgreSQL when two saves of the same entry, both based on the same version, arrive at once, for example from two MCP clients or from scripts using `emdash content update --rev`: both reported success, and the first was silently overwritten. The second save now returns `409 CONFLICT`, the same response a save based on an outdated version already gets.
