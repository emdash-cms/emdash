---
"emdash": patch
---

Fixes `emdash export-seed --with-content=all` so it exports content from every collection, matching the documented behaviour. Previously the literal string `"all"` was treated as a collection name and matched none, producing an empty `content` block. The bare flag and `--with-content=true` were the only sentinels honoured.
