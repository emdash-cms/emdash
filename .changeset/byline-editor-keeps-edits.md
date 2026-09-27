---
"@emdash-cms/admin": patch
---

Fixes the byline editor discarding changes typed right after it opened. On slower sites the full byline record could finish loading after you started typing and replace your edits, so Save stored the original values. Reopening a byline straight after saving it now also shows the saved values.
