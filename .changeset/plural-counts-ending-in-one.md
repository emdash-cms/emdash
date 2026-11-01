---
"@emdash-cms/admin": patch
---

Fixes Croatian (`hr`), Russian (`ru`) and Serbian Latin (`sr-Latn`) admin messages that described counts such as 21 or 101 as a single item. In Croatian, for example, screen readers now announce "Izbrisan 21 redak" after 21 table rows are deleted, instead of "Redak izbrisan" (row deleted).
