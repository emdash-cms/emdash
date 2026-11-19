---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes media usage tracking missing files linked by their `/_emdash/api/media/file/` URL. **Used in** now includes Portable Text links, HTML block `href` and `src` attributes, and whole string or URL field values, including fields inside blocks and repeaters.

Run a media usage repair after upgrading to index links in existing entries, or save those entries again. Until then, coverage can still show as complete while omitting these links. Only root-relative media URLs are counted, not absolute URLs (even on the same site), external URLs, or URLs embedded in plain text. Deleting media still requires reviewing its references first; usage tracking does not prevent deletion.
