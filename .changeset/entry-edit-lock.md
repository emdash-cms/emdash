---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds an edit lock per content entry, so two people no longer discover a collision only after both have done the work.

Opening an entry in the admin takes a lock on it. A second editor is told who has it and chooses between opening the entry read-only, where nothing they type can be lost to a refused save, and taking it over. After a take-over, the previous holder is told within two minutes that the entry moved on, their next save is refused, and a banner names who holds it now.

The lock lasts seven minutes. The admin renews it every two minutes while the entry is open, so a pause in typing does not lose it, and every save on the entry extends it too. Leaving the editor or closing the tab releases it; a tab that loses power or network lets it lapse.

#### Who is newly refused

Scripts, API tokens and the CLI that update, delete, publish, unpublish, schedule or discard an entry while an editor has it open in the admin now receive `409 ENTRY_LOCKED` where the write used to succeed. This applies to every collection once the migration has run. The response's `error.message` names the holder and `error.details` carries their `userId`, `userName`, `acquiredAt` and `expiresAt`. Pass `"overrideLock": true` in the request body to write anyway, or `?overrideLock=true` on `DELETE`, which has no body. The CLI takes `--override-lock` on `content update`, `content delete`, `content publish`, `content unpublish` and `content schedule`. The MCP content tools do not honour the lock yet.

Locks are per entry and per locale, so two translations of the same entry can be edited at once.

Take or read a lock directly through `GET`, `POST` and `DELETE` on `/_emdash/api/content/{collection}/{id}/lock`.

#### Turning it off

Locking is on for every collection. Switch it off under **Content Types** → your collection → **Edit locking**, with `editLocking: false` in a seed file, or through `schema_update_collection`:

```json
{ "slug": "posts", "editLocking": false }
```

#### Upgrading

Includes database migration `075_entry_edit_locks`. Projects on the default `auto` runtime migration mode need no action. Projects that migrate as a deployment step: run `emdash migrate` before deploying this version.
