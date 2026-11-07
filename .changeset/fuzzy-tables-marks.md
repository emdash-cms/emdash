---
"emdash": patch
---

Fixes Markdown imports through the client API, CLI, and MCP to preserve nested inline formatting, links, and list depth. GFM pipe tables now import as native table blocks and export as Markdown tables, including cell formatting and alignment. Tables with merged cells or other layouts that GFM cannot represent remain preserved in opaque block comments. Headings containing hard line breaks are also exported as opaque blocks to preserve their text and formatting.

Markdown imports now treat a single newline as a soft wrap within one paragraph; separate paragraphs with a blank line. Reads escape literal inline punctuation (for example, `snake_case` becomes `snake\_case`), use `*text*` for italics instead of `_text_`, and write hard line breaks as a trailing backslash (`\`).

Unlinked images in ordinary paragraphs become native image blocks, splitting surrounding text into separate paragraphs. Images inside list items, blockquotes, or links remain inline Markdown text so their containing list, quote, or link is preserved.
