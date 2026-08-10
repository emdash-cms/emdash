---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds a `hidden` flag to collections that omits their auto-generated entry from the admin sidebar. Hidden collections keep working everywhere else — REST API, MCP, plugin hooks, and their editor at `/_emdash/admin/content/<slug>` — so a plugin that owns a collection end to end can point editors at its own admin UI instead of a raw CRUD list. Set it in a seed file (`"hidden": true`) or via the schema API.
