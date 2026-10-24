---
"emdash": patch
---

Fixes Markdown written to rich text fields through the CLI, the MCP content tools or `EmDashClient` turning each wrapped line into its own paragraph and leaving `*italic*` as plain asterisks.

Wrapped lines now join into one paragraph and `*italic*` becomes italics, while underscores inside words, as in `my_var_name`, stay as typed. Reading rich text as Markdown now escapes characters such as `*` and `_` and ends each line inside a paragraph with a backslash, so a paragraph written back keeps its text and line breaks, except spaces and tabs at the start of its second and later lines, which Markdown drops. Bold italic text, italics inside a word right next to bold text, and inline code holding a backtick still come back with stray `*`, `_` or backtick characters in their text. A line holding only `#`, `-` or `1.` and spaces stays a paragraph instead of becoming an empty heading or list item. Markdown with Windows line endings converts the same as Markdown with Unix ones, and a long run of spaces or tabs after a heading or list marker no longer slows its conversion down. A line starting with `~~~` now opens a code block, and a backslash before a punctuation character is read as an escape, so write `\\` to keep a literal backslash.

#### What should I do?

If you separate paragraphs with a single newline, put a blank line between them. To keep a line break inside a paragraph, end the line with two spaces or a backslash.

If you process the Markdown that `portableTextToMarkdown` from `emdash/client`, `EmDashClient`, the CLI or the MCP content tools return, expect backslash escapes and a backslash at the end of each line inside a paragraph. To get Portable Text instead, pass `--raw` to `emdash content get`, `raw: true` to `EmDashClient.get`, or leave `markdown` unset on the MCP read tools.
