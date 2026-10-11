---
"@emdash-cms/admin": patch
---

Fixes opening an entry in the admin saving a draft when nothing was edited. It happened when the content ended in something other than a paragraph and was stored in a shape the editor writes differently, such as with empty `markDefs` and `marks` arrays (what `markdownToPortableText` and the MCP content tools write), a block without a `style`, or a code block with extra fields. Such entries showed "Pending changes" that nobody made, and opening them could drop fields the editor doesn't map.
