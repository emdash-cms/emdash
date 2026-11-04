---
"@emdash-cms/gutenberg-to-portable-text": patch
---

Fixes classic-editor conversion slowing to seconds on HTML with tags that never close, such as a link or image tag with a long run of whitespace or repeated attributes, or many paragraph tags without end tags. Linked images now take their link from the link's own `href` attribute, not from `href` text elsewhere in the tag, and keep an apostrophe in a double-quoted link. Images keep alt text that contains `>`.
