---
"emdash": patch
"@emdash-cms/plugin-audit-log": patch
---

Fixes content attribution for authenticated REST, visual editing, and MCP saves.

- Revisions record the acting user without changing the entry owner. MCP updates preserve the existing owner, and actorless internal writes leave revision attribution unset instead of inferring it from ownership.
- `content:beforeSave` and `content:afterSave` receive an actor snapshot with the authenticated user's `id` and `role`. The snapshot is isolated between hooks so one plugin cannot change the attribution seen by another.
- The audit-log plugin stores the actor ID as `userId` on content create and update entries.
