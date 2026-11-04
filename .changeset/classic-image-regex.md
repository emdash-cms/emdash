---
"@emdash-cms/gutenberg-to-portable-text": patch
---

Fixes classic-editor conversion slowing to seconds on a link or image tag that never closes and holds a long run of whitespace or repeated attributes. Linked images now take their link from the link's own `href` attribute, not from `href` text elsewhere in the tag, and keep an apostrophe in a double-quoted link. Images keep alt text that contains `>`.
