---
"emdash": patch
---

Fixes the MCP `content_duplicate` tool letting contributors and authors copy content owned by other users. The tool now requires permission to edit the source item, matching the REST duplicate endpoint: authors can duplicate their own content, editors and above can duplicate anyone's, and contributors can no longer duplicate content through MCP. The copy is now attributed to the user who made it instead of the source item's author.
