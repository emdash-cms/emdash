---
"emdash": patch
---

Fixes recreating a deleted collection failing with `Collection "…" already exists` (`COLLECTION_EXISTS`) on sites with media usage tracking turned on, which new sites turn on automatically. Creating a collection through the admin, the API, MCP or a seed now finishes the deleted collection's media usage cleanup first, so sites already stuck in this state can recreate the collection after upgrading.

Each create attempt does a bounded amount of that cleanup. If it can't finish, for example because the deleted collection referenced media from many entries, the error says the collection is being deleted, and the next attempt continues where the last one stopped. If the cleanup has failed, the error says so and includes the deleted collection's ID in `details.deletedCollectionId`. Both errors keep the `COLLECTION_EXISTS` code. Send that ID as `{ "collectionId": "…" }` to `POST /_emdash/api/admin/media-usage/collection-deletions/retry`, which requires the `schema:manage` permission and, for API tokens, the `admin` scope, then create the collection again.
