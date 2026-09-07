---
"@emdash-cms/admin": patch
"emdash": patch
---

Fixes Portable Text editors replacing payload-less custom blocks with an `[Unknown block type: …]` paragraph during autosave. Custom blocks, existing block and span keys, supported marks, and link definitions now survive editor round trips, and an editor-generated trailing paragraph is not saved.
