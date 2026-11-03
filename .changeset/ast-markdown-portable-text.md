---
"emdash": patch
---

Fix Markdown and Portable Text bidirectional conversion across the MCP server, `emdash content` CLI, and client API (`markdownToPortableText`, `portableTextToMarkdown`, `convertDataForRead`, `convertDataForWrite`):

- **AST Lexer**: Replace regex-based markdown parsing with `marked`'s lexer, adding support for single-asterisk italics, multi-line paragraph wrapping, and nested list structures.
- **Canonical Tables**: Convert GFM pipe tables into canonical `tableRow`/`tableCell` blocks with column alignments (`hasHeaderRow`, `isHeader`) and inline cell marks.
- **Table Serialization & Fallback**: Serialize canonical tables back to standard GFM Markdown on read. Tables containing features GFM cannot represent losslessly (custom column widths, conflicting per-cell alignments, body header cells, or multi-line cell content) fall back to lossless Tier-3 opaque HTML comment fences (`<!--ec:block ... -->`).
- **Shared Table Annotations**: Resolve both cell-local and table-level shared link definitions (`block.markDefs`) with local precedence when serializing table cells.
- **Context-Aware List Nesting**: Track ancestor marker column widths (`1. ` vs `- `) during serialization, ensuring mixed ordered and unordered lists round-trip accurately with CommonMark.
- **Content Preservation**: Preserve whitespace separation in loose list items, split multi-image paragraphs into distinct image and text blocks, retain blockquote child elements, preserve literal inline/block HTML, and preserve task-list checkbox states (`- [ ]`, `- [x]`).
