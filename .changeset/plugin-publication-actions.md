---
"emdash": minor
"@emdash-cms/plugin-types": minor
"@emdash-cms/plugin-cli": minor
"@emdash-cms/plugin-test": minor
"@emdash-cms/registry-lexicons": minor
"@emdash-cms/admin": minor
"@emdash-cms/cloudflare": minor
"@emdash-cms/sandbox-workerd": minor
---

Adds separately consented publication and restore actions to native and sandboxed plugin contexts.

Plugins with `content:publish` can read an entry with an opaque revision and publish, unpublish, schedule, or unschedule it through the same runtime behavior as REST and MCP. Each mutation requires the revision returned by the read or preceding action, and a plugin cannot recursively run the same action for the same entry. The capability implies `content:read` but not `content:write`.

Plugins with `content:restore` can read and restore trashed entries without receiving ordinary content-read or write authority. Restore is revision-fenced and returns the next revision. Existing plugin installations receive neither capability unless a new version declares it and the administrator approves the expanded access.
