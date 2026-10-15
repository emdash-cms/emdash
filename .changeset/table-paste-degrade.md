---
"@emdash-cms/admin": patch
---

Fixes rich-text pastes from Google Docs being rejected entirely when a table contains centred or right-aligned cell paragraphs or a merged cell with a `<colgroup>`.

The table-paste safety checks now degrade gracefully instead of blocking the whole paste, so headings, links, and other formatted content outside the table are preserved and the table itself is inserted with alignment or column-width information stripped.
