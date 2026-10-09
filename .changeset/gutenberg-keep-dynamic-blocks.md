---
"@emdash-cms/gutenberg-to-portable-text": patch
---

Fixes WordPress dynamic blocks disappearing on import. Blocks that WordPress renders on the server, such as custom plugin blocks, reusable block references or Latest Posts, store no markup in the post, so the converter dropped them without a trace. They now become an HTML block containing the original block comment, for example `<!-- wp:acme/testimonial {"author":"Jane"} /-->`. The block shows no content on the site. In the admin editor, its HTML tab shows the comment, so editors can see which block was there and rebuild it. Dynamic blocks nested in a container the converter does not know, such as a Query Loop, become one placeholder per inner block, and the container's own settings are not kept.
