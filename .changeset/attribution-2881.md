---
"emdash": patch
---

Fixes content change attribution so revisions, entry ownership, and hook payloads no longer conflate the acting user.

- The REST content routes and MCP `content_update` now pass the authenticated actor separately from the entry owner. `revisions.author_id` is set from the actor when the client does not supply one, so admin saves stop recording `NULL` authors.
- `authorId` on `content_update` changes only `ec_{collection}.author_id`; the MCP no longer silently reassigns entry ownership on every edit.
- `content:beforeSave` and `content:afterSave` hooks now receive `event.actor` with the acting user's `id` and `role`.
