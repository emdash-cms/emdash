---
"emdash": minor
"@emdash-cms/admin": minor
---

Fixes autosave deleting versions saved with **Save**, and names everyone who edited each version in revision history.

- An autosave replaces the previous version only when that version is also an autosave. A version saved with **Save**, or one EmDash creates itself, such as the draft copy an unpublish leaves, stays in **Revisions**.
- Each version names everyone who edited it since the version before it, such as "Ana, Ben, and 1 other person", and marks its changes in a neutral color when several people edited it. The publish confirmation names everyone who edited the entry since the published version.
- `GET /_emdash/api/content/{collection}/{id}/revisions` and the MCP `revision_list` tool return `editedBy` on each version: the people who edited it, latest first, as `{ id, name }`, with `null` for an account that no longer exists. `null` means the version names only its `author`.
- `GET /_emdash/api/content/{collection}/{id}/revisions/editors?since={revisionId}` returns everyone who edited the entry in the versions newer than `since`, newest first and once each, in the same shape. Without `since`, it returns everyone who edited the entry. It requires `content:read_drafts`.
- `content:beforeSave` and `content:afterSave` events include `editedBy`, the IDs of the users whose edits the save holds, latest first. A save with an `actor` lists only that user. A hook that checks the actor's role before accepting content should check everyone in `editedBy`.

A migration adds two nullable columns, `kind` and `edited_by`, to the `revisions` table. Existing versions are not backfilled: they name only their author, and autosave never replaces them. Site transfer leaves both columns out, so transferred versions also name only their author. Once a site has run the migration, earlier EmDash versions can't export it or import into it with site transfer.
