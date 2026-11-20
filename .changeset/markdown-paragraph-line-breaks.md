---
"emdash": patch
---

Fixes literal heading and list markers, such as `# Title` and `1. item`, turning into Markdown blocks when rich text is read and written back through the CLI, MCP content tools, `EmDashClient` or `portableTextToMarkdown` from `emdash/client`. Markdown output now escapes these markers at the start of paragraph lines, including lines after a hard break, and escapes setext underlines such as `---` and `===` and table delimiter rows such as `| --- | --- |`.
