---
"emdash": minor
"@emdash-cms/plugin-types": minor
---

Adds the `byline:afterSave` and `byline:afterDelete` plugin hooks, so plugins can keep external copies of author data, such as a search index, current when byline profiles change.

Both hooks require the `bylines:read` capability and receive the same public byline profile that `ctx.bylines.get()` returns. `byline:afterSave` runs after a byline or one of its translations is created or updated, with `isNew` set on creation. `byline:afterDelete` receives the byline as it was before deletion. They run after changes made through the admin API or MCP tools, not seeds or imports, and hook errors are logged without undoing the change.

Credit changes on an entry are still reported through `content:afterSave`. Relinking a byline to another user can change the credits inferred for that user's entries without a per-entry event.
