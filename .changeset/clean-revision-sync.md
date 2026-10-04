---
"@emdash-cms/admin": patch
---

Fixes a stale `_rev` token being sent when saving SEO fields after the editor loaded a cached entry and then refetched a newer, clean server snapshot. The write revision is now synchronized with the adopted entry snapshot only while the editor is clean, and it ratchets forward by version so a delayed old read cannot overwrite a newer successful-write token.
