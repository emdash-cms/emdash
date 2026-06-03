---
"@emdash-cms/admin": patch
---

Add search to the byline picker on content entities and remove the effective 100-byline cap. The picker now performs a debounced server-side search via the bylines API instead of rendering a fixed dropdown of the first 100 results, so bylines beyond the first page can be found and credited. Credited bylines from the saved entry are also resolved from the entry itself, so a credit that falls outside the initial list still renders its name instead of disappearing.
