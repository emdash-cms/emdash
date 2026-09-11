---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds a `group` setting to collections. Collections that share a group render as one collapsible folder in the admin sidebar, positioned where the first of them appears; a taxonomy joins the folder when every collection it is assigned to is shown in that folder. A folder you have not touched opens while one of its members is active; once you open or close it yourself, the sidebar remembers that choice in the browser. Set the group in the content type editor under Navigation, in seed files, or through the schema API and the MCP collection tools; leaving it empty keeps today's flat list.
