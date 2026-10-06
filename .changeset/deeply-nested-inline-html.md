---
"@emdash-cms/gutenberg-to-portable-text": patch
---

Fixes WordPress imports failing with "Maximum call stack size exceeded" when a post contains thousands of nested inline tags, such as unclosed `<b>` or `<span>` tags. Preformatted, verse, pullquote, and button blocks, and image and gallery captions, no longer fail on this markup either.

Formatting that is nested inside the same formatting, such as `<strong><b>bold</b></strong>`, now gives the span a single `strong` mark instead of repeating it. Text inside a link nested in another link, which HTML only allows inside elements such as `<svg>` or `<object>`, now carries only the innermost link.
