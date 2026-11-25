---
"emdash": patch
---

Fixes creating a translation through the content API or the MCP `content_create` tool when `translationOf` is a slug. The new entry now joins the translation group of the entry that `translationOf` resolved to and whose edit permission was checked. Previously, if that value was also another entry's ID, the translation could be added to that other entry instead.
