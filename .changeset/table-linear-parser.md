---
"@emdash-cms/gutenberg-to-portable-text": patch
---

Fixes WordPress imports stalling on `core/table` blocks that contain many unclosed tags, such as thousands of `<tr>` or `<td>` tags without a closing tag. Conversion time for this markup grew with the square of its length and now grows linearly. Converted tables are unchanged.
