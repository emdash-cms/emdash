---
"@emdash-cms/admin": patch
---

Fixes SEO sidebar text fields firing a PUT on every keystroke by debouncing saves; guards against stale server responses overwriting newer local edits.
