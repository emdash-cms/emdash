---
"@emdash-cms/admin": minor
"emdash": minor
---

Adds readable revision history to the content editor. Selecting a version in the **Revisions** panel shows it in place, read-only, with added text highlighted and removed text struck through in the color of the person who saved it. The selected version lists its changes in plain words, such as "Changed the title", and selecting one scrolls to it. **Restore** moves to a bar at the bottom of the editor, and a version that matches an earlier one is marked "Restored from" with that version's date. **Save** and **Publish** pause while a version is open. The panel no longer shows raw JSON.

The revisions list API (`GET /_emdash/api/content/{collection}/{id}/revisions`) and the MCP `revision_list` tool include each revision's `author` as `{ id, name }`, or `null` when no author was recorded or the account no longer exists, so editors without access to user management can see who saved each version.

`ContentEditor`'s `onRevisionRestored` callback can now return a promise. The restore stays pending until it settles, and the restore dialog shows the error if it rejects. When a host passes this callback, the restored version stays on screen until `item` carries the restored draft, and the writer can't go back to editing before then. The editor still refreshes the entry's `content` and `revisions` queries, so a host that reads `item` from the entry's `content` query needs no change. Other hosts must reload `item` from the callback.
