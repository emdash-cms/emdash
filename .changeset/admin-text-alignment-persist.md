---
"@emdash-cms/admin": patch
---

Preserves block `textAlign` through the admin editor's ProseMirror ↔ Portable Text round-trip so alignment applied in the toolbar survives save and reload. Mirrors the core converter fix — the admin inlines its own converter pair that previously dropped the attribute.
