---
"@emdash-cms/admin": patch
---

Normalizes manually-typed slug inputs (content items, taxonomy terms, sections, collections, custom fields, byline quick-create/edit) to their expected format on blur, matching the existing auto-generate-from-label behavior. Previously a manually-typed slug was stored raw (spaces, capitals, punctuation) until the underlying handler silently transformed it, showing a visibly invalid value in a field labeled "URL-friendly identifier."
