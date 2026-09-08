---
"@emdash-cms/admin": patch
"emdash": patch
---

Fixes the admin rich-text editor replacing payload-less custom blocks with an `[Unknown block type: …]` paragraph during autosave. Custom blocks, existing block and span keys, supported marks, and link definitions survive editor round trips, and the editor does not save a synthetic trailing paragraph.

Applications using the exported converters can pass `{ preserveIdentity: true }` to `portableTextToProsemirror()` and add `portableTextIdentityExtensions` to their TipTap schema for the same lossless behavior. The default conversion remains compatible with standard ProseMirror schemas.
