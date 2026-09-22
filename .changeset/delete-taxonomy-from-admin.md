---
"@emdash-cms/admin": patch
---

Fixes the taxonomy screen offering no way to remove a taxonomy. **Delete taxonomy**, in the screen's actions menu, deletes the taxonomy together with its terms in every language and removes those terms from the content filed under them; the content entries themselves are kept. Removing a taxonomy previously meant a direct `DELETE /_emdash/api/taxonomies/{name}` call or the `taxonomy_delete` MCP tool, so a taxonomy created by mistake stayed in the admin sidebar.

The action requires the `taxonomies:manage` permission that the route already enforced, so editors and administrators can perform it.
