---
"emdash": patch
---

Fixes Markdown conversion to Portable Text in the MCP server, the `emdash content` CLI, and the client API (`markdownToPortableText`). GFM pipe tables are now converted into canonical `tableRow`/`tableCell` blocks with column alignment and serialized back to Markdown on read, *single-asterisk* italics are recognized, wrapped multi-line paragraphs remain single blocks, and nested list items retain their indentation depths.
