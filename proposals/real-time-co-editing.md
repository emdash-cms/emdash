---
title: Real-time co-editing
type: rfc
status: proposed
authors:
  - Noah Pham (@khoinguyenpham04)
champion: Noah Pham (@khoinguyenpham04)
sponsor: MA2153 (@MA2153)
discussions:
  - https://github.com/emdash-cms/emdash/discussions/4173
created: 2026-10-16
---

# Real-time co-editing

> **Draft.** Acceptance waits on the prototype results for the [acceptance gates](#acceptance-gates).

## Summary

This RFC lets several people edit one entry in the admin editor at once. Each person sees who else is editing and where, concurrent rich-text edits merge, and undo reverts only that person's edits.

- **A room per entry syncs and saves.** A server-side room holds the entry's shared Yjs document and relays edits and presence over WebSockets. It is a Durable Object on Cloudflare Workers and an in-process object on Node.js. It saves through the same steps as today's autosave, so permissions, hooks, validation and revisions work as they do today, and content stays Portable Text.
- **Every other write merges in.** REST, MCP, the CLI, the visual editor and plugins write as they do today, and the room copies their changes into the shared document unless someone in the room changed the same field.
- **On by default** wherever the host can run rooms. Elsewhere, editing works as it does today.

Co-editing applies to collections with revisions. Presence for agents and API callers, comments and suggestions are out of scope.

## Problem and user case

Only one person can edit an entry at a time. Edit locking ([Discussion #2819](https://github.com/emdash-cms/emdash/discussions/2819)) is on by default: the first person to open an entry holds its lock, and everyone else gets **Open read-only** or **Take over**. With locking off, a save based on an older `_rev` gets `409 CONFLICT`. Nothing merges, so teams take turns, or draft in another tool and paste, which loses Portable Text structure.

The Ideas Discussion ([#4173](https://github.com/emdash-cms/emdash/discussions/4173)) asked for the [goals](#goals) below. A reply asked who answers for a publish that holds several people's edits: each revision records who edited it, and the publish dialog names everyone who edited since the live version.

### Prior art

- **WordPress 7.0** relayed Yjs updates between browsers, which saved through the normal requests, and removed it before release ([sync provider post](https://make.wordpress.org/core/2026/04/01/building-a-custom-sync-provider-for-real-time-collaboration/), [Gutenberg #72373](https://github.com/WordPress/gutenberg/pull/72373), [removal post](https://make.wordpress.org/core/2026/05/08/rtc-removed-from-7-0/)). Its next design is server-aware, because a browser that fell behind could save over newer work, REST writes couldn't reach open editors, and a privileged browser could save a less privileged collaborator's content ([server-aware post](https://make.wordpress.org/core/2026/09/18/moving-to-a-server-aware-approach-for-collaboration/)).
- **JupyterLab** moved what gets saved, and **PreTeXt-Plus** moved saving itself, from the browser to the server ([JupyterLab #11599](https://github.com/jupyterlab/jupyterlab/pull/11599), [PreTeXt-Plus #414](https://github.com/PreTeXtPlus/PreTeXt-Plus/pull/414)). **Yjs servers** such as Hocuspocus and y-partyserver recover updates lost in a restart from clients.
- **The Yjs author's model** for apps whose database is the source of truth starts each session from the database and forgets it after a timeout, such as an hour, once the last client leaves. Clients from a forgotten session can't merge ([Lexical FAQ](https://lexical.dev/docs/collaboration/faq)).

This design is server-aware: the room is the only saver, outside writes reach open editors, and each save is authorized as a co-editor.

## Example

Ana (Editor role) opens the post "Spring launch", which Ben (Author role) already has open, and each sees the other's avatar and cursor. Ana edits the title while Ben rewrites a paragraph. Two seconds after the last edit, the room saves both people's edits, and both editors show "Saved".

Ben's Wi-Fi drops for twenty seconds. He keeps typing, and his edits merge and save when he reconnects. A script with Ana's API token updates the excerpt, and the new excerpt appears in both editors within a second. Ana publishes: the room saves, the post is published, and Ben's later edits are unpublished changes.

## Goals

- **Concurrent editing** of the entry form, with every replica converging.
- **Presence:** avatars, each person's field, and named cursors in rich text. Remote edits render within 500 ms at the 95th percentile.
- **Per-person undo.**
- **Short disconnects.** A client that reconnects within an hour of everyone leaving merges its offline edits. Edits that can't merge are kept as a revision.
- **"Saved" is true.** A client shows "Saved" only when a save holds all its edits.
- **Live outside writes,** shown in open editors within a second.
- **Credit.** Each version names everyone who edited it since the version before it.
- **Deliberate publishing.** Publishing is one operation, by someone with publish permission, on a save made at that moment.
- **Hosts:** Cloudflare Workers and Node.js, over WebSockets, with no third-party service and no Cloudflare code in `emdash`. On Node.js, sites start as they do today, several processes can share one database, and only one at a time stores each entry's room.
- **On by default,** with no added queries on logged-out routes.

## Non-goals

- Presence for agents and API callers. Their writes merge, but they have no cursor, presence or undo.
- Comments, suggestions, tracked changes and approval workflows.
- Offline edits that outlive the room or the tab.
- Co-editing in the visual editor, whose writes still merge into open rooms.
- Co-editing one entry across several Node.js processes. Its room runs in one of them, and joins that reach another wait.
- Merging inside fields other than rich text, `blocks` and `repeater` included.
- A per-collection setting.

## Detailed design

[How the parts fit](#how-the-parts-fit) gives the model that the later sections build on. [Appendix A](#appendix-a-interfaces) holds the protocol, interfaces, tables and configuration, [Appendix B](#appendix-b-room-mechanics) the exact rules behind documents, saves and merges, and [Appendix C](#appendix-c-limits) the timings and limits.

### Current behavior

- **Autosave** sends the whole form 2 s after typing stops, as the content `PUT` with `skipRevision: true` and `_rev`. A stale `_rev` gets `409 CONFLICT`. The route checks edit permission and the edit lock, then runs the runtime's update, with `content:beforeSave` hooks. Each draft save creates a revision, and `skipRevision` deletes the previous draft revision, even one a manual save created.
- **Edit locks**, called user locks below, belong to a user, admit all of that user's sessions, and are renewed by a heartbeat every 2 minutes.
- **Other writes.** The visual editor saves one field at a time, without `_rev`. Plugin `ctx.content.update` skips hooks, validation and the edit lock. SEO, author and publication date write the live row at once, taxonomy terms save through their own route, and bylines and reference fields ride the form save.
- **The editor schema** is built inside the admin's React editor, which has its own Portable Text converter.

### Yjs in brief

Yjs is the CRDT library co-editing uses. The rest of this RFC relies on these facts about it:

- A **`Y.Doc`** is a document that each client keeps a copy of, called a replica. Every change makes an **update**, a binary diff. Replicas that apply the same updates, in any order and any number of times, hold the same document.
- Yjs merges by **item identity**, not by content. Each inserted item records the client ID that wrote it and a counter. Two documents built separately from the same entry share no items, so merging one into the other duplicates every block.
- A **state vector** records how far a replica has got in each client's edits. Deletions are kept apart, in a **delete set**. A **snapshot** holds both, so it also notices an edit that only deletes. Snapshot A **contains** B when A's state vector is at least B's and A's delete set includes B's.
- **Sync** has two steps, as y-protocols defines them: each side sends its state vector (step 1), and the other replies with the updates it lacks (step 2). After that, updates flow as they happen.
- **Awareness** is a separate y-protocols channel for each client's short-lived state, such as its cursor. It's never stored.
- `@tiptap/y-tiptap` binds a **`Y.XmlFragment`** to the ProseMirror editor. Reading a fragment through a ProseMirror schema deletes from the shared document itself every element of a type the schema rejects, with its content, and all the text of any run that carries a mark it rejects, so a document must be read only with the schema that built it.

### How the parts fit

Each client exchanges edits only with the entry's room, over a WebSocket. The room saves through the site's content update steps, and the site notifies the room after every other write. "The editor" is the admin entry editor, and Editor, Author and Contributor are roles.

| Part                 | What it is                                                                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client               | An editor tab, which keeps a replica of the shared document                                                                                                                        |
| Room                 | The server-side object for one entry row (each locale is a row). It holds the shared document, relays updates and presence, saves the document, and merges outside writes into it. |
| Shared document      | The room's `Y.Doc`, which each client replicates                                                                                                                                   |
| Shared editor schema | The admin editor's ProseMirror schema and Portable Text converter, in a DOM-free subpath export of `@emdash-cms/admin` that the editor and rooms share                             |
| Room storage         | Where a room keeps its document and room record ([Data model](#data-model)): the Durable Object's SQLite on Workers, two site-database tables on Node.js                           |
| Stored entry         | The entry row and its revisions in the site database                                                                                                                               |

A room is **open** while it has connections or unused, unexpired tokens, and for 10 s after its last connection closes.

Two parts of the room record tie the shared document to the stored entry:

- **The last checkpoint** shows how much of the document is saved. A **checkpoint** is a snapshot recorded when every edit in it has been saved, and an update is **covered** when the last checkpoint contains it. The room records a checkpoint at initialization, at each save, including one skipped because nothing changed, and after a merge into a document with nothing uncovered.
- **The merge base** holds the stored entry's `_rev`, and each field's hash in the stored entry and in the document, as of the last checkpoint or merge. Comparing with it shows which side changed a field since.

Saves carry the document's changes into the stored entry. Merges carry into the document the fields that changed only in the stored entry, with the exceptions in [Merging outside writes](#merging-outside-writes). A **kept checkpoint** is one made for **Save** or an operation, whose revision later autosaves don't replace. While a room is open, an **operation** that a user runs through a route or MCP, such as publishing, asks it for a kept checkpoint, and holds the room's other saves and merges until it releases the room, for 30 s at most ([Operations](#operations)). Each continuous room state has a **lineage**, a random ID. A room that starts from the stored entry starts a new lineage.

The [Example](#example), step by step:

```mermaid
sequenceDiagram
    participant Ana
    participant Ben
    participant Room
    participant Site as EmDash runtime
    participant Script as API script
    Ana->>Site: POST .../room
    Site->>Room: issueToken
    Room-->>Site: token
    Site-->>Ana: url and token
    Ana->>Room: connect with the token, then sync
    Ana->>Room: update to the title
    Room->>Ben: update to the title
    Ben->>Room: update to a paragraph
    Room->>Ana: update to a paragraph
    Note over Room: stores each update within 1 s
    Note over Room: 2 s after the last update
    Room->>Site: update as Ben, with _rev
    Site-->>Room: new _rev
    Room->>Ana: checkpoint
    Room->>Ben: checkpoint
    Script->>Site: PUT the excerpt
    Site->>Room: notify, after the commit
    Room->>Site: load the entry
    Note over Room: compares hashes, then writes the excerpt into the document
    Room->>Ana: update to the excerpt
    Room->>Ben: update to the excerpt
    Ben->>Room: update to another paragraph
    Room->>Ana: update to another paragraph
    Ana->>Site: POST .../publish
    Site->>Room: ask for a kept checkpoint as Ana
    Room->>Site: update as Ana, kept
    Site-->>Room: new _rev
    Room->>Ana: checkpoint
    Room->>Ben: checkpoint
    Room-->>Site: _rev and a hold
    Note over Site: publishes with that _rev
    Site->>Room: release the hold
    Note over Room: merges the published entry
    Note over Room: the status changed, so it closes connections with rejoin
```

Three fallbacks recur through the design:

- **Single-editor mode** is today's behavior, where the client takes a user lock or opens read-only. [Joining a room](#joining-a-room) lists when the join route returns it.
- A client **resets** by discarding its replica and joining again, first saving its whole document as a recovery revision if it holds uncovered edits ([Client resets and recovery revisions](#client-resets-and-recovery-revisions)).
- A room **starts over** by saving its uncovered updates as a recovery revision, closing every connection and dropping its state. [Room lifecycle](#room-lifecycle) lists when.

A **recovery revision** is a revision marked `recovery` that holds edits the room or a client couldn't save. It is never the draft or the live one.

### Guarantees

1. **One room per entry.** An entry's edits merge and save in one place: Workers runs one Durable Object per name, and on Node.js a room writes room storage only while its process holds the entry's [claim](#claims-on-nodejs).
2. **One lineage.** A client merges only into the lineage it started from, and resets otherwise, because merging a replica of another document duplicates its content.
3. **One saver.** Only the room saves the shared document, so a browser that fell behind can't save over newer work. The room's saves send `_rev`, so none lands over a write it hasn't merged.
4. **One step at a time.** The room runs initialization, saves and merges one at a time, so each checkpoint contains the one before it.
5. **Room storage holds every saved update.** Before each save, the room stores every update that save holds. Otherwise a restart could leave the document without edits the stored entry has, and the next save would remove them.
6. **"Saved" means covered.** A client shows "Saved" when the last checkpoint contains its replica's snapshot from its own last edit, and otherwise asks before its tab closes.
7. **Hook output stays out.** The room writes stored values into the document only when it merges an outside write, never from its own save's response, so its saves never rewrite text people are typing.

### Joining a room

The client calls `POST /_emdash/api/content/{collection}/{id}/room` with its session, `X-EmDash-Request` and fingerprint. API tokens are refused. The route checks the caller and the site, then asks the room for a token, passing the entry's `_rev`, status and author as it checked them. The client opens its WebSocket on the join route's path, `/_emdash/api/content/{collection}/{id}/room?token=…`, so one routing rule covers both requests, receives `welcome`, and stays read-only until y-protocols sync completes. A client whose replica comes from another lineage than the one in `welcome` resets. The join route writes no content, so the site-write fence, which blocks writes during a site transfer import or media usage activation and records them for running exports, exempts it.

The **fingerprint** identifies an EmDash build and its editor schema. It is the admin manifest's `version`, `commit` and `hash`, which change with EmDash upgrades and with collection, plugin or taxonomy definitions. A client sends the `version` and `commit` built into its admin bundle, and the `hash` its editor was built from.

Before it answers, the room starts over if the token comes from the room's own build but its fingerprint differs from the room record's ([Room lifecycle](#room-lifecycle)). It then merges the entry if the `_rev` sent with the request differs from the merge base's, and always if the room isn't open. The route answers in one of these ways:

| When                                                                                                                                                                                                                            | Result                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Co-editing is off, the collection has no revisions, the host can't run rooms, the session is a playground, the caller already holds the entry's user lock, for example in another tab, or the client sends `singleEditor: true` | Single-editor mode. A caller who holds the user lock shares it as today.                                                                                             |
| The room can't store, or it must initialize and the entry is over 1 MB or has rich-text marks the editor can't represent                                                                                                        | Single-editor mode                                                                                                                                                   |
| The token's `version` or `commit` isn't the room's own build's, as during a gradual deployment                                                                                                                                  | Single-editor mode                                                                                                                                                   |
| The room is at a connection limit                                                                                                                                                                                               | The client opens read-only                                                                                                                                           |
| Another user holds a user lock                                                                                                                                                                                                  | `ENTRY_LOCKED`. **Take over**, which needs edit access as today, repeats the join with `takeover: true` and deletes that lock.                                       |
| Another Node.js process holds the room's [claim](#claims-on-nodejs), or this process is shutting down                                                                                                                           | `409 ROOM_BUSY`. The client joins again every 5 s, so a tab that hasn't synced stays read-only, and one that has keeps its edits.                                    |
| The fingerprint differs from the server's                                                                                                                                                                                       | `409 CLIENT_OUTDATED`. The client saves its uncovered edits as a recovery revision and reloads the admin.                                                            |
| After the merge, the entry's status or author differs from what the route checked                                                                                                                                               | The room refuses the token, and the route checks access again                                                                                                        |
| Otherwise, for a caller with `content:read_drafts`                                                                                                                                                                              | A room, as `{ url, token }`. Users whom `requireEntryEditPerm` allows join as **co-editors**, with write access, and the rest as **viewers**, with read access only. |

The token is random, single use, valid for 60 s, kept in the room's memory, and bound to the user, their name, the access level and the fingerprint. Every connection, reconnects included, needs a fresh token. A socket without a valid token, or one that reaches a Node.js process that doesn't run the room or is shutting down, is closed at once with `busy`, and the client joins again 5 s later, as after `ROOM_BUSY`.

Rooms take no edit lock. While a room is open, or another Node.js process holds its claim, today's lock route reports the room as the entry's holder and grants no user lock, and the route's `POST`, which takes and renews locks, deletes any user lock it finds. Single-editor tabs therefore open read-only, and a tab displaced by **Take over** turns read-only at its next heartbeat.

**Connection lifetime.** On every message, the room closes connections older than 15 minutes with `rejoin`. Those clients join again, which rechecks their session and access.

**No WebSockets.** If a browser session's first three sockets all fail to open, a proxy or network blocks WebSockets. The client then joins with `singleEditor: true`: the room forgets that user's unused tokens, the route logs a `[co-editing]` warning, and it returns single-editor mode, read-only while the room is open. The client keeps single-editor mode for the rest of the browser session.

### Editing in a room

The room relays each update it applies at once, and stores it within 1 s. Fields map into the shared document like this:

| Field                                                                                                                | Yjs type                                                                                                            | Concurrent edits                                                           |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `portableText`                                                                                                       | A `Y.XmlFragment` per field, bound to TipTap by `@tiptap/extension-collaboration` and `@tiptap/y-tiptap` (both MIT) | Merge. Every concurrent insertion is kept.                                 |
| The slug, and every other field in `data` except reference fields (`blocks`, `repeater` and plugin widgets included) | One value in a `Y.Map`                                                                                              | One of the concurrent changes is kept, the same on every replica           |
| Values outside the document: SEO, author, publication date, taxonomy terms, bylines and reference fields             | None                                                                                                                | Not merged. Each saves at once, without `_rev`, sending only what changed. |

[Documents](#documents) in Appendix B covers Portable Text keys and normalizing plugins.

- **Values outside the document.** In a room, bylines and reference fields leave the form save, and reference fields save with `skipRevision`, as autosaves do. A failed save keeps the value in its input, with today's error. Other clients reload a changed value once its input doesn't have focus.
- **Updates.** The room applies updates only from co-editors, up to 1 MB each. An update that is too large or doesn't decode closes its connection with `reset`. Viewers send only sync step 1 and awareness, and the room ignores anything else from them. A client sends incremental updates only after its sync step 2.
- **Presence** is Yjs awareness: each client's field and, in rich text, its cursor and selection. The room sets each connection's user from its token, and relays awareness only for the first Yjs client ID the connection announces, if no other connection holds it. Viewers appear by name only, with no cursor or field. Presence is relayed, never stored, and removed when its connection closes.
- **Undo.** Rich text and the slash menu use `Y.UndoManager`, limited to the client's own origin, instead of TipTap's `undoRedo`. Other inputs keep the browser's undo, and room merges are in no one's undo history.
- **Plugin UI.** The plugin block modal edits the block by `_key`, not position, and refuses if the block is gone. A remote change remounts a field widget when the widget doesn't have focus. Editor panels and actions with the `admin.editor-draft:read` capability send the replica's values, and those with `:read` or `:patch` send the `_rev` from the latest `checkpoint` as `baseRevision`. While the entry's room is open, the server skips the `baseRevision` check, because room saves change `_rev` every few seconds. The client applies a returned patch in one transaction, one undo step in rich text, unless a field it changes was edited after the capture.

### Saving

Each save that sends fields is one call to the content update steps, made as one user, the **actor**. The actor is the co-editor who sent the checkpoint's latest update, or the user who asked for it by sending `save` or running an operation.

The room saves:

- 2 s after the latest update from a co-editor, and at least every 10 s while such updates keep arriving
- after loading uncovered updates from room storage
- when the last co-editor leaves
- when a client sends `save`, and when an operation asks

Saves for `save` and for operations make kept checkpoints. A merge alone doesn't start a save. During an operation's hold ([Operations](#operations)) the room waits, and saves when the hold ends if co-editor updates arrived.

Each save runs in this order:

1. In one synchronous step, the room takes the document's snapshot and serializes the fields that updates touched since the last checkpoint, plus fields where a merge kept the document's value, or every field after loading from room storage. It reads rich text as ProseMirror JSON without a schema, which can't change the document, and converts it with the shared converter. y-tiptap's schema-free reader, `yXmlFragmentToProsemirrorJSON`, is deprecated, so EmDash keeps its own copy if y-tiptap removes it.
2. It stores every update the snapshot holds.
3. It sends the fields whose hash differs from the merge base, as the actor, with the merge base's `_rev`, `skipRevision: true` unless the checkpoint is kept, and `editedBy`, the users whose updates the snapshot adds since the last checkpoint.

If no field differs, the room sends nothing. It records the snapshot as the last checkpoint and broadcasts `checkpoint`. For a kept checkpoint, it first marks the draft revision, if there is one, as kept, after the same `_rev` check, without changing `_rev`.

When the room sends fields, it acts on the result:

| Result                                           | What the room does                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved                                            | Records the snapshot as the last checkpoint, updates the merge base from the save's own write ([Merge base records](#merge-base-records)), and broadcasts `checkpoint`                                                                                                  |
| `409 CONFLICT`                                   | Merges the entry as for a notification and saves again once. If that conflicts too, it waits for the next update or notification.                                                                                                                                       |
| `403`, including for a disabled or deleted actor | The actor lost edit access. The room closes that user's connections with `rejoin` and saves as the next most recent co-editor in `editedBy`. If no one in `editedBy` can save, the edits wait until someone who can sends an update, or until the room drops its state. |
| `404`                                            | The entry is in Trash or gone, and the room starts over ([Room lifecycle](#room-lifecycle))                                                                                                                                                                             |
| Any other refusal, such as a validation error    | Reaches clients as a `notice`, and the room tries again at the next update                                                                                                                                                                                              |

When an operation asked for the save, a failure also fails the operation, and the room never saves it as another user ([Operations](#operations)).

**Save steps.** The content `PUT` route's edit check and runtime update move into a function the route and rooms share. It returns the `_rev` and stored values of its own write, where today's update reads the entry again after writing. Room saves also apply the site-write fence, as plugin writes do, and a refusal counts as a failed save. Like plugin writes, they don't check edit locks. As draft saves, they purge no route cache.

**Hooks** run on every save, with the actor as the event's actor, and get `editedBy` ([Compatibility](#compatibility-and-migration)).

### Merging outside writes

An outside write is any write to the stored entry that the room didn't make. Each one to an existing entry, including SEO, byline and taxonomy-term writes and the values a publish copies into sibling locales, notifies that entry's room after it commits, without waiting for the room. The notification names the values outside the document that changed. Writes the room makes don't notify it. Notifications come from the repositories that write entries, SEO, bylines and term assignments, so every writer that goes through them notifies, including plugins and sandboxed plugins on both hosts, which skip hooks, and bulk tagging. Sandboxed plugins' Trash, which writes the row directly today, moves to the content repository, and a repository method that changes many entries, such as deleting a byline or a term, notifies each of them. [Direct row updates](#drawbacks-and-risks) don't notify. A term assignment spans the entry's translation group, so it notifies the room of every locale in it. Repositories queue notifications in the outermost `withTransaction` call and send them once it returns, which is after the commit where the database has transactions and after the last statement on D1. A write outside a transaction notifies once it completes. A room that isn't open ignores notifications, and merges the entry at the next token request.

On every notification, the room tells clients to reload the outside values it names, then loads the entry and compares each field's hashes with the merge base's:

| Stored value changed | Document value changed | Result                                                                                                                                                                                                                    |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No                   | Either                 | Nothing to write                                                                                                                                                                                                          |
| Yes                  | No                     | The stored value is written into the document. Rich text with marks the editor can't represent is never written. The document keeps its value, and the stored value stays until someone edits that field in the room.     |
| Yes                  | Yes                    | The document keeps its value, and the next save sends it. A room that isn't open, whose uncovered updates may be an hour old, starts over instead if the two values differ, then initializes again for the token request. |

- **Writing.** No update lands between the comparison and the write ([Writing merges](#writing-merges)). The room stores the merge and its room record in one transaction, then relays the merge like any update. If the document held uncovered updates before the merge, the room records no checkpoint, and the next save stores them.
- **Status, author and Trash.** A merge that finds a new status or author forgets unused tokens and closes every connection with `rejoin`, so the join route rechecks access. A merge that finds the entry in Trash starts over, as a save's `404` does.

### Operations

The operations are publishing, scheduling, unpublishing and unscheduling the entry, restoring a revision, discarding the draft, and moving the entry to Trash. The client calls today's route for the operation, without sending `_rev` or first saving the form with a `PUT`. When a user runs an operation through a route or MCP while the entry's room is open, the runtime's method for it:

1. Asks the room for a kept checkpoint, saved as that user, and gets its `_rev`. A caller that sent its own `_rev` gets `409 CONFLICT` instead, before anything is saved, if that `_rev` isn't the stored entry's or the room holds uncovered updates. If the room's save conflicts, it merges and retries once, still as that user. If the save fails, the operation fails with its error: unlike an autosave, it never falls back to another user.
2. Runs the operation, with the caller's `_rev` if it sent one and the checkpoint's otherwise, where the operation takes one: publish, unpublish, schedule, unschedule and discard.
3. Releases the room, even if the operation failed. The room merges the entry. After a restore or discard, it overwrites instead: it writes every field whose stored value differs from the kept checkpoint's, whatever the document holds.

From step 1 until the release, or 30 s at most, the room holds: it runs no other save or merge, so typing can't make the operation conflict or undo a restore. A token request that needs a merge waits for the hold to end. Operations take turns, because the next one's save waits for the release, and each release names the hold it ends. Restore and discard refuse a target whose rich text has marks the editor can't represent.

Scheduled publishing and plugin actions skip these steps. They keep their own `_rev`, their writes merge as outside writes, and scheduled publishing publishes the last saved draft, as today.

**Save** sends `save`. **Preview** opens once a checkpoint covers the client's edits. Before an operation, a client whose edits aren't covered sends `save`, and runs the operation only once that save's checkpoint arrives, showing the error if the save is refused. Operations are disabled while the client is offline.

### Room lifecycle

A room's state changes at these events:

| Event                                                                                                                                                                                                                | What the room does                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A token request finds no state                                                                                                                                                                                       | Initializes. It loads the stored entry, builds its document with the shared editor schema, and picks a lineage. It records the document's snapshot as the last checkpoint, and the entry as the merge base, with document hashes from the new document.                                                                                                                                                             |
| A message needs the room after a deploy, an eviction or a crash                                                                                                                                                      | Loads its document from room storage, writes with a new Yjs client ID, and gets missing updates from reconnecting clients' sync step 2, credited to those clients' users. An update is lost only if the room lost it and every client that held it is gone, so it was never "Saved". On Node.js, the rooms of a process that crashed, or was killed before its shutdown ended, first wait for its claims to expire. |
| An hour has passed since its last store or closed connection, and it isn't open                                                                                                                                      | Saves any uncovered updates as a recovery revision, never into the draft, and drops its state. If the save fails, the room keeps its state and tries again an hour later. A recovery revision over the size limit never saves, so the room logs a `[co-editing]` error and drops its state anyway.                                                                                                                  |
| A token request reaches a room still holding state past that hour                                                                                                                                                    | Does the same before it answers                                                                                                                                                                                                                                                                                                                                                                                     |
| Its appended updates pass 1 MB                                                                                                                                                                                       | Compacts them ([Compaction](#compaction))                                                                                                                                                                                                                                                                                                                                                                           |
| Its compacted state passes 2 MB                                                                                                                                                                                      | The document has outgrown rooms. The room saves, closes every connection with `rejoin`, and drops its state, falling back as the hourly drop does if the save fails. Joins then initialize again, in single-editor mode if the entry is over 1 MB.                                                                                                                                                                  |
| The room is stale. A token from the room's own build has a fingerprint that differs from the room record's, an entry the room loads has another `hash`, or the room loads a document that another EmDash build made. | Never reads that document with the schema. It starts over, closing connections with `rejoin`.                                                                                                                                                                                                                                                                                                                       |
| A save gets `404`, or a merge loads the entry from Trash                                                                                                                                                             | Starts over, closing connections with `deleted`. If the entry is gone, it saves no recovery revision.                                                                                                                                                                                                                                                                                                               |
| A room that isn't open finds, as it merges for a token request, a field changed on both sides to different values                                                                                                    | Starts over, then initializes again for that request                                                                                                                                                                                                                                                                                                                                                                |
| On Node.js, the room loses its claim                                                                                                                                                                                 | Closes every connection with `rejoin` and forgets its document ([Claims on Node.js](#claims-on-nodejs))                                                                                                                                                                                                                                                                                                             |

A room that drops its state first forgets unused tokens, and token requests wait until the drop ends.

### Revisions and who edited them

Room saves create revisions as other draft saves do. These rules decide which revisions stay and whom each one names:

- **Autosaves.** A prerequisite fix marks autosave revisions in `revisions.kind`, so an autosave replaces the previous draft revision only if that one was an autosave too.
- **Author and editors.** Each save's revision has the actor as its author, and stores the save's `editedBy` in `edited_by`. An autosave that a room didn't make stores its author there. An autosave that replaces a revision also adds that revision's `edited_by`, without duplicates and latest first. Each version therefore names everyone who edited it since the version before it, and a null `edited_by` means its author alone.
- **Where they show.** The revisions list returns `editedBy`, and Revisions lists everyone in it ([Readable revision history](readable-revision-history.md#co-editing)). The publish dialog names everyone in each revision's `edited_by`, or its author when that is null, on the revisions since the live one.

### Client resets and recovery revisions

A client resets after a lineage mismatch, when the room closes its connection with `reset` after refusing an update, or when a join returns single-editor mode. A client keeps its edits in the tab for copying when it has lost edit access, including when it joins again as a viewer, when it's closed with `deleted`, or when its recovery save fails.

Recovery revisions use a new route, `POST /_emdash/api/content/{collection}/{id}/revisions`, with the session, `X-EmDash-Request` and edit access. It stores the document's fields and slug as a revision marked `recovery`, without moving the draft or live pointer. It ignores edit locks and checks size and shape but not fields, so content from before a schema change still saves. A room saves its own recovery revisions the same way, without an edit check and without an author, listing everyone in `editedBy`. Recovery revisions appear in Revisions by their author, or by everyone in `editedBy` when the room saved them, and are pruned like the others. Because they skip validation and hooks, restoring one saves its fields through the runtime's update, with validation and `content:beforeSave` hooks, as the restoring user.

### Runtime hosts

The room logic lives in `emdash`, uses `yjs`, `y-protocols`, `lib0`, `@tiptap/y-tiptap` and the shared editor schema, and runs behind internal host boundaries ([Interfaces](#interfaces)). A room reaches the site through core functions that run inside `withEmDashRuntime()`, which gives code outside a request the site's runtime and, where the database has read replicas, reads from the primary.

- **Cloudflare Workers.** Each room is an `EmDashRoom` Durable Object from `@emdash-cms/cloudflare`, with hibernatable WebSockets. Each socket's user, access level, connection time and Yjs client ID live in its attachment, so they survive hibernation. The package's Worker export forwards room upgrades before Astro runs, and routes reach rooms by RPC through the `EMDASH_ROOMS` binding. A room calls back into its own Worker through an `EmDashRoomSite` entrypoint, using `exports` from `cloudflare:workers` as the plugin sandbox does for `PluginBridge`. The output gate holds each save until the store before it is durable. A room that keeps a y-protocols `Awareness` object clears its 3 s timer, which would keep the Durable Object from hibernating. Every store and closed connection sets the drop alarm an hour ahead, and an alarm that fires while the room is open sets itself again.
- **Node.js.** Each room is an object in the process's room registry. The bundled copy of `emdash` that routes use owns the registry, the room code and Yjs. Room upgrades reach the registry from the site's own HTTP server ([Upgrades and shutdown on Node.js](#upgrades-and-shutdown-on-nodejs)). Every store and closed connection updates `_emdash_rooms.updated_at`, and in processes that run rooms, the runtime's hourly system cleanup, which each process's scheduler already runs, applies the hourly drop ([Room lifecycle](#room-lifecycle)) to rooms that aren't open and haven't been updated for an hour, including rooms left by a crash. A room on Node.js therefore drops its state at the first cleanup or token request after that hour.

### Upgrades and shutdown on Node.js

Astro has no WebSocket API ([withastro/roadmap#695](https://github.com/withastro/roadmap/discussions/695)), so `emdash` finds the HTTP server that serves Astro through `node:diagnostics_channel` and takes room upgrades from it. Sites start as they do today. Rooms run on sites that use `@astrojs/node` with an HTTP/1.1 `node:http` or `node:https` server: in standalone mode, in middleware mode under a server such as Express or Fastify, and under `astro preview` and `astro dev`. The integration tells the runtime which adapter the site uses. Node.js sites on other adapters keep single-editor mode, and so do `node:cluster` workers, such as PM2's cluster mode, because the cluster's primary hands out connections without seeing their paths, so a room path can't be routed to one worker. On any other server, upgrades never reach rooms, so a process whose listener isn't attached to any server 60 s after it issued its first token gives joins single-editor mode until it is.

- **Finding the server.** When the bundled copy of `emdash` loads outside a `node:cluster` worker, it subscribes to the `http.server.response.finish` channel, whose messages carry the server that sent each response. The first message from a server for a request to an `/_emdash/` path, under any base path, attaches one `upgrade` listener to it. A room upgrade follows the join that issued its token, and that join's response has finished by then, so the listener is in place. Subscribing to `http.server.request.start` instead would miss the first socket after a restart, because Astro loads `emdash` with its middleware during a process's first request, after that request's start. The subscription, the servers it has seen and the listener live on `globalThis`, so a module that runs again in development adds none.
- **Taking upgrades.** The listener hands WebSocket upgrades on room paths, under any base path, to the room registry, which completes them with `ws`. Where Node.js has `shouldUpgradeCallback` (22.21 and 24.9 onward), `emdash` sets it so the server treats a request as an upgrade only when it's a room upgrade or the server would have treated it as one without `emdash`, keeping any callback the site set, and every other request is served as today. On releases without it (22.16 to 22.20, 23, and 24.0 to 24.8), a server with an `upgrade` listener passes it every upgrade request, so when the `emdash` listener is the server's only one, it answers other upgrades with `404`. Otherwise it leaves them to the other listeners, such as the one Vite adds for HMR.
- **Shutdown.** While a process holds claims, `emdash` listens for `SIGTERM` and `SIGINT`, ahead of any other listener. On either signal, it stops listening, the process answers joins with `ROOM_BUSY` and closes new sockets with `busy`, and its rooms stop applying updates, store and save, release their [claims](#claims-on-nodejs), and then close every connection with `rejoin`. After that, or after 5 s, `emdash` sends the signal again if nothing else listens for it, so the process stops as it would have. Otherwise another listener decides when the process stops, and if it exits first, the rooms recover as after a crash. A second signal reaches the other listeners, or stops the process at once. Room timers never keep the process running.

### Claims on Node.js

A site can run several Node.js processes on one database, each with its own room registry. A claim keeps each room in one of them: the `host` and `claimed_at` columns of the room's `_emdash_rooms` row, where `host` is a random ID that each process keeps with its registry. Workers needs no claims, because each room is one Durable Object.

- **Taking.** A process that doesn't hold a room's claim takes it before it opens the room for a token request or drops its state, and then loads the room from room storage, so it starts from what the last holder stored. The claim is one conditional write that succeeds if the row is missing, its `host` is null, or its claim hasn't been renewed for a minute. When a token request's claim fails, the join gets `ROOM_BUSY`.
- **Holding.** Every room-storage transaction starts by renewing the claim, setting `claimed_at` where `host` is this process, which also orders it against any concurrent claim. A process renews every claim it holds at least every 20 s, as stores already do while people type. A renewal that matches no row means the room lost its claim: it closes every connection with `rejoin` and forgets its document. Until a room notices, its site writes are guarded only by `_rev`, so a recovery revision can be saved twice.
- **Releasing.** A process clears `host` once the room isn't open and has finished writing, including after a token request that doesn't open it.
- **Clock.** Every timestamp comes from the database clock, as for edit locks.

## Compatibility and migration

- **On by default** on Node.js sites that use `@astrojs/node`, with no change to how they start, and on Cloudflare sites with the `EmDashRoom` binding and the entry's re-exports ([Configuration](#configuration)), which Rollout adds to the Cloudflare templates. Other sites, and `node:cluster` workers, keep today's behavior. `coEditing: false` turns co-editing off. Sites that run several Node.js processes route each entry's room path to one process, or turn co-editing off, and the release notes say so ([Drawbacks](#drawbacks-and-risks)). A reverse proxy must forward WebSocket upgrades on that path, or clients fall back to single-editor mode.
- **Node.js servers.** With co-editing on, outside `node:cluster` workers, `emdash` adds an `upgrade` listener to the site's server, and handles `SIGTERM` and `SIGINT` while it holds claims ([Upgrades and shutdown on Node.js](#upgrades-and-shutdown-on-nodejs)). Other upgrade handlers on that server must leave room paths alone, and on Node.js releases without `shouldUpgradeCallback`, upgrade requests on other paths get `404` ([Drawbacks](#drawbacks-and-risks)). With `coEditing: false`, it does neither.
- **Migrations** are additive and forward-only, with no backfill: `revisions.kind`, `revisions.edited_by`, and the room-storage tables, which every site database gets and only Node.js uses.
- **API.** The revisions list gains `editedBy`, with each person's ID and name, and the content `PUT` doesn't change. Two routes are new: joining a room, and recovery revisions. The lock route reports an open room in a new `room` field, and its `POST` then deletes user locks instead of granting one. While a room is open, editor-draft requests skip the `baseRevision` check, and the editor refuses a plugin's patch only when a field it changes was edited after the capture, not after any edit. `ContentHookEvent` gains `editedBy`. A room's save can hold other people's edits under the actor's name, so a hook that checks the actor's role before accepting content must check everyone in it. In a room, `content:beforeSave` hooks get only the fields a checkpoint changed, as they already do for visual-editor saves.
- **Locks.** The editor takes no edit lock in a room. While a room is open, writes that today get `ENTRY_LOCKED` land and merge. Writers that send `_rev` can get more `409 CONFLICT`, and so can tabs opened before co-editing was on, which keep single-editor mode until they reload. MCP publish, unpublish, schedule and discard, which require `_rev`, conflict whenever the room holds uncovered updates, except on another Node.js process ([Drawbacks](#drawbacks-and-risks)), and `content_update` with a `status` keeps its field changes when that publish or unpublish conflicts.
- **The autosave fix** applies to every site: autosaves stop deleting revisions that manual saves created, and an autosave keeps the names of the revision it replaces.
- **Turning co-editing off** takes effect when the site is rebuilt and redeployed, and clients reset to single-editor mode. Room state already stored drops as usual, saving its uncovered updates as recovery revisions: on Workers when its drop alarm fires, while the `EmDashRoom` class stays deployed, and on Node.js once co-editing is on again. Older EmDash versions ignore the new columns and tables, except that their site export, and the check after a site import, refuse the new `revisions` columns, so an older version can't export a site that has migrated, or import into one.
- **Site transfer** skips recovery revisions, which the target site couldn't tell apart from other revisions. Its column list marks `revisions.kind` and `revisions.edited_by` as excluded and the room-storage tables as non-portable runtime tables, so transferred versions name only their author.
- This RFC amends [Readable revision history](readable-revision-history.md#co-editing). **Deprecations:** none.

## Security and privacy

- **Joining** needs the admin session and `X-EmDash-Request`, so another site can't obtain a token. EmDash never logs tokens, and a token that a platform logs in a URL has already been used.
- **Saves are authorized as the actor,** with that user's current role. A room reaches the site in-process on Node.js and through its own Worker's entrypoint on Workers, and neither path is reachable from the internet.
- **One user's save holds others' edits.** Every co-editor has edit access to the entry, and EmDash has no document field that only some roles may store: HTML blocks are sanitized or isolated when rendered, whoever saved them. Hooks get `editedBy`, which the room takes from the token of each connection that sent updates, for their own checks. After a restart, it names the users who resent lost updates, not their authors. If EmDash adds a document field that only some roles may store, checkpoints must check it against everyone in `editedBy`.
- **Forged items.** The room doesn't check the client IDs on an update's items, because clients resend each other's updates after a restart. A malicious co-editor who wins a race to the room with items under another client's ID replaces that client's edits there, while that client still shows "Saved".
- **Access changes** reach a room within the 15-minute connection lifetime, and at once after a save refused with `403` or a status or author change, though a change written by another Node.js process arrives at the room's next save or join. Contributors co-edit their own drafts, and rejoin as viewers after a publish.
- **Privacy.** Anyone who can open an entry sees who else has it open. Room storage holds Yjs updates, with content, until the room drops its state. Logs carry IDs and lineages, never content or tokens.

## Performance

- **Logged-out routes** run no new queries, and checkpoints, as draft saves, purge no route cache. On Node.js, each request also publishes a `node:diagnostics_channel` message, which `emdash` ignores once it has seen that server.
- **Saving** costs one save per open entry every few seconds while someone types: today's autosave rate, made once however many people edit. The room serializes only touched fields and sends only changed ones.
- **Notifications** add one room call per entry row a write changes, after the write commits, without waiting for the room, and an entry load when the room is open. A room that isn't open answers without loading its document, and so does a room that wakes only for presence. The room's own writes send none.
- **Room storage** writes each second's updates as one row, and compaction bounds it.
- **Claims** on Node.js add a write when a room opens and when it closes, and one every 20 s while its process holds the claim with nothing to store. Asking whether a room is open reads its claim.
- **Opening an entry** adds the join request and a WebSocket. Where a room could exist, a single-editor tab's lock heartbeat asks whether the entry's room is open.
- **Memory.** Node.js keeps a room's document in memory while it has connections, and browsers load the co-editing code only when it's active.

## Failure handling

| Failure                                                          | What happens                                                                                                                                                                            |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Room storage is lost                                             | Reconnecting clients reset, and the room initializes from the stored entry                                                                                                              |
| The room can't store                                             | The room closes every connection, and clients reset. Token requests store first, so joins get single-editor mode until storing works again.                                             |
| A save fails: validation, a hook, or the site is unreachable     | Every client sees the error, the edits stay in the room, and the room tries again at the next update. When it drops its state, it saves them as a recovery revision.                    |
| WebSockets can't reach the room                                  | When a browser session's first three sockets fail to open, the client uses single-editor mode for the session, and the join route logs a warning                                        |
| A notification is lost                                           | The room merges the write when its next save gets `409 CONFLICT`, or at the next join                                                                                                   |
| A Node.js process crashes, or is killed before its shutdown ends | Joins for its rooms get `ROOM_BUSY`, and single-editor tabs open read-only, until its claims expire, up to a minute later. The rooms then load from room storage, as after any restart. |

Rooms log with the `[co-editing]` prefix. Operators turn co-editing off with the site option, and recover content from **Revisions**.

## Verification

- **Unit and property tests:** coverage, including delete-only edits; compaction; the lineage, stale-room and fingerprint rules; and the merge rule, including two outside writes to one field between saves, a write after a restore, and an unrecorded save.
- **A fixed-seed convergence harness** runs clients with the editor's real schema and plugins against a room, through random edits, delivery orders, drops and reconnects, restarts that lose unstored updates, a second Node.js process taking over a stalled room, unrecorded saves, outside writes and operations. Each run checks that replicas converge, each checkpoint contains the one before it, no covered edit is lost, and no rich text is duplicated.
- **workerd tests** for hibernation, restarts, the timers and storage failures, and **integration tests** on SQLite, libSQL and PostgreSQL for the join route, room saves, notifications from every writer, the recovery route, the autosave fix and the names it carries over, and two Node.js processes sharing one database.
- **Playwright tests:** the [Example](#example), two tabs of one user, a viewer, a Contributor after a publish, restore and discard while others type, a reset, outside writes appearing live, and a blocked WebSocket falling back to single-editor mode. A manual pass covers a screen reader, a keyboard, Arabic and phone width.

### Acceptance gates

- **Round trip.** Every node, mark and plugin block EmDash ships, and every template's seed content, survives Portable Text → shared document → Portable Text unchanged on the server, and the admin editor saves the same Portable Text from the same document. Serializing a document twice gives identical Portable Text, and neither opening an entry nor receiving a merge makes the editor write.
- **Schema safety.** 10,000 fixed-seed runs of 200 concurrent edits each make `@tiptap/y-tiptap` delete no non-empty content. If this fails, rich text switches to a central-authority engine.
- **Server conversion** runs in workerd and Node.js with no DOM.
- **Hosts.** Rooms take upgrades on `@astrojs/node` in standalone and middleware mode and under `astro preview`, over HTTP and HTTPS, on the oldest and newest release of every Node.js major version EmDash supports, and other upgrade requests are served as today where Node.js has `shouldUpgradeCallback`. `astro dev` over HTTP serves rooms beside Vite's HMR socket: from the in-process registry with `@astrojs/node`, and from the Durable Object with `@astrojs/cloudflare`. After a restart that released its claims, a single process opens the first socket on its first try, and a process stopped with `SIGTERM` or `SIGINT`, with no other handler for it, releases its claims before it exits. A process on another server gives joins single-editor mode 60 s after its first token, and `node:cluster` workers keep single-editor mode. Every Yjs call runs inside the room registry, so routes never load a second copy of `yjs`. Upgrades reach the Durable Object, and its saves reach the Worker, deployed and in development.
- **Cost.** CPU time per save, merge and notification is measured and published with the release.

Co-editing ships, on by default, when these gates pass, 100,000 harness runs pass, the harness runs nightly in CI, the 500 ms goal holds, and someone editing alone sees no warning for drops under 5 s.

## Rollout and implementation

1. **Prerequisites:**
   - the autosave fix;
   - the shared editor schema: the schema parts of the admin editor's extensions and its converter move into a DOM-free subpath export of `@emdash-cms/admin`, as `emdash` already imports `@emdash-cms/admin/portable-text-table`. The editor adds node views and commands, and the converters `emdash` exports don't change;
   - TipTap packages aligned with `@tiptap/extension-collaboration`, whose peers require `@tiptap/core` and `@tiptap/pm` at its exact version, against the editor's 3.20.0;
   - the admin bundle records its `version` and `commit` at build, as `emdash` does;
   - the content `PUT` route's steps move into a shared function.
2. **Rooms** on both hosts, the join route, saving, notifications and the recovery route. `emdash` gains `yjs`, `y-protocols`, `lib0`, `@tiptap/y-tiptap` and `ws` as dependencies.
3. **The editor:** bindings, presence, undo, operations and reset.
4. **Hardening:** [Verification](#verification), docs and templates.

## Alternatives

- **Clients save through autosave, and the room only relays and stores.** Saving would need a connected client, outside writes would be refused or merged late, and save turns and client-side merges would make up most of the protocol. WordPress 7.0 built a similar design, whose server only relayed updates, and removed it before release ([Prior art](#prior-art)).
- **A central-authority engine** such as prosemirror-collab, where the server orders every step and applies it through the schema. A schema mismatch then rejects a step instead of deleting content, but EmDash would build cursors, presence and per-person undo itself. It's the fallback if the [schema-safety gate](#acceptance-gates) fails.
- **The Durable Object runs its own runtime** instead of calling its Worker. Each room would start its own runtime, plugins and database connections, where the Worker's are already warm.
- **HTTP instead of WebSockets:** `POST` to send, a streamed response to receive. Every batch costs a request with a session lookup, and Yjs servers and providers mostly use WebSockets.
- **Hocuspocus or y-partyserver as the room.** y-partyserver runs only on Durable Objects, and Hocuspocus 4 runs on both hosts but documents no Durable Object or hibernation support. Either way, EmDash would still add saving and merging.
- **An `emdash start` command** that runs the `@astrojs/node` standalone server itself, through its undocumented `startServer()`, and takes its upgrades. Every Node.js site would change how it starts, and sites in middleware mode couldn't co-edit.
- **A WebSocket-enabled Node.js adapter,** such as `astro-node-websocket`, which replaces `@astrojs/node` and takes upgrades only in standalone mode.
- **Waiting for WebSocket support in Astro** ([withastro/roadmap#695](https://github.com/withastro/roadmap/discussions/695)). It's the better home for upgrades, and EmDash will bring its use case to that proposal, but co-editing doesn't wait for it. Rooms on Node.js can move to it later without changing clients or the protocol.
- **The Yjs document as stored content.** Rendering, REST, MCP, search and site transfer read Portable Text.

## Drawbacks and risks

- **Merge limits.** Fields other than rich text keep one change. While the room is open, a stored change to a field someone in the room changed since the last checkpoint or merge loses to the room's value. So does stored rich text with marks the editor can't represent, once someone edits that field in the room. The lost change stays in Revisions when its write created a kept revision, as plugin writes, CLI and MCP updates, and REST updates without `skipRevision` do.
- **Block replacements.** "Turn into", dragging or deleting a block replace it, so concurrent typing inside it is lost, and the prototype checks which table edits do the same. Text typed offline into content someone else deleted also disappears, as in other Yjs editors.
- **Restores.** Edits typed during a restore or discard into the fields it changes are overwritten, and no revision holds them. A hold lost to a restart, or released after it expired, lets a restore merge like any outside write. Restore and discard refuse a target whose rich text has marks the editor can't represent, so the admin can't run them while it co-edits that entry. REST, MCP and the CLI can once no one has it open, though the merge limit for such rich text applies until the room drops its state, an hour later.
- **Lock race.** A tab holding a user lock taken in the instant a room opens, or displaced by **Take over**, keeps saving beside the room until its next heartbeat, up to 2 minutes later. While a lock taken in the race lasts, joins get `ENTRY_LOCKED`.
- **Unrecorded saves.** If a room restarts between a save committing and the room recording it, its next save conflicts. The merge keeps that save's fields, except a field someone set back to its earlier value, where the stored value wins.
- **Direct row updates,** such as the WordPress import's URL rewrite, neither notify nor change `_rev`, so the next save of that field overwrites them, as today's autosave does.
- **One schema for two places.** The editor and rooms share one schema module, so every editor change lands there ([Yjs in brief](#yjs-in-brief)).
- **Fingerprint changes reset rooms.** An EmDash upgrade, or a change to any collection, plugin or taxonomy definition, resets every open room within 15 minutes. Clients reload, and unsynced edits become recovery revisions. During a gradual deployment, clients on another version than the room's get single-editor mode.
- **Several Node.js processes** run each entry's room in the process that claimed it, and people co-edit only once both their join and its upgrade, which share a path, reach that process. Routing that path by entry makes it immediate. Otherwise, people pinned to another process wait read-only, with no **Take over**, while the room is open there, and with round-robin routing even someone editing alone can need several tries, because a missed upgrade leaves an unused token that holds the claim for up to 60 s. While a drop holds a claim, other processes' lock routes report the room as open.
- **Writes on another Node.js process** reach the room as a lost notification does, at its next save or join. Co-editors then aren't told to reload values outside the document, such as SEO, so one saved from a stale form can overwrite another co-editor's change. An operation run there gets no kept checkpoint or hold: it publishes, schedules or discards the last saved draft, MCP's `_rev` check doesn't see the room's uncovered updates, and a restore merges like any outside write.
- **Experimental channels.** Node.js marks the HTTP channels of `node:diagnostics_channel` experimental, so a release can change them. CI runs the [Hosts](#acceptance-gates) gate on the oldest and newest release of every supported Node.js major version. If a release stops the channel reporting servers, joins get single-editor mode, as on other servers, and if it stops upgrades reaching rooms, clients fall back as when WebSockets are blocked.
- **Other upgrades on Node.js.** On Node.js releases without `shouldUpgradeCallback`, once `emdash` attaches its listener, a server with no other `upgrade` listener answers upgrade requests on other paths, such as `Upgrade: h2c`, with `404`, where it used to serve them as plain requests. On every version, another upgrade handler on the same server must leave room paths alone. Handlers that answer every upgrade, such as a `ws` server created with `{ server }`, `express-ws` or `@fastify/websocket`, don't, so a site that uses one switches it to `noServer` or turns co-editing off.
- **Shutdown on Node.js.** While a process holds claims, `emdash` handles `SIGTERM` and `SIGINT`, and a stopping process exits up to 5 s later than it would today. A process manager that kills it sooner, such as PM2 after 1.6 s by default, or another signal handler that exits first, cuts the wait short, and the rooms recover as after a crash.

## Open questions

- Are the timings and [limits](#appendix-c-limits) right?
- Should `blocks` and `repeater` merge per item?
- Should a single-editor tab that turns read-only because a room opened join the room on its own?

## Appendix A: Interfaces

### Protocol

Messages are binary. Yjs sync and awareness use y-protocols' message types 0 and 1, as y-websocket does. EmDash messages use type 100: a lib0 `varString` of JSON, then an optional `varUint8Array` holding a Yjs snapshot.

| Message      | From      | Carries                                                                                                         |
| ------------ | --------- | --------------------------------------------------------------------------------------------------------------- |
| `welcome`    | Room      | The lineage, the client's access level, and the last checkpoint's snapshot                                      |
| `save`       | Co-editor | A request for a kept checkpoint now, for the **Save** button or before an operation                             |
| `checkpoint` | Room      | The new last checkpoint's snapshot, `editedBy`, and the merge base's `_rev`                                     |
| `notice`     | Room      | What changed and who changed it: an operation, an outside write, values outside the document, or a refused save |

Close codes are 4400 `rejoin`, 4401 `reset`, 4402 `deleted` and 4403 `busy`. The client never reconnects on its own: it joins again for a fresh token. The room relays awareness to every connection, the sender included.

### Interfaces

The host boundaries are internal and can change until co-editing is stable:

```ts
// Called by routes and the write path: Durable Object RPC on Workers, the registry on `globalThis` on Node.js.
interface RoomHost {
	// Stores first. Resolves to null when the room can't store, runs another build than the
	// token's, or won't run for the entry; to "full" when a connection limit is reached; to
	// "stale" when the entry's status or author changed since the route checked access; and to
	// "busy" when another Node.js process holds the room's claim or this process is shutting down.
	issueToken(
		roomId: string,
		claims: TokenClaims,
	): Promise<{ token: string } | "full" | "stale" | "busy" | null>;
	// Whether the room is open, for today's lock route. On Node.js, also while another process
	// holds its claim.
	isOpen(roomId: string): Promise<boolean>;
	// Waits for any other hold, saves a kept checkpoint as `actorId`, and holds other saves and
	// merges until `release`. With `rev`, resolves to "conflict" and does neither if `rev` isn't
	// the stored entry's or the room holds uncovered updates. Resolves to null when the room
	// isn't open or runs in another Node.js process, and rejects with the save's error when the
	// save fails.
	save(
		roomId: string,
		actorId: string,
		rev?: string,
	): Promise<{ rev: string; hold: string } | "conflict" | null>;
	// Ends the hold. With `overwrite`, the room writes every field whose stored value differs
	// from the kept checkpoint's, whatever the document holds.
	release(roomId: string, hold: string, options?: { overwrite?: boolean }): Promise<void>;
	// Queues a merge of the stored entry and returns at once. `outside` names the values outside
	// the document that the write changed, for clients to reload.
	notify(roomId: string, outside: OutsideValue[]): Promise<void>;
	// Forgets the user's unused tokens, for a client that falls back to single-editor mode.
	forgetTokens(roomId: string, userId: string): Promise<void>;
}

interface TokenClaims {
	userId: string;
	name: string;
	access: "edit" | "view";
	fingerprint: { version: string; commit: string; hash: string };
	// The entry's `_rev`, status and author when the join route checked access.
	rev: string;
	status: string;
	authorId: string | null;
}

type OutsideValue = "seo" | "author" | "publishedAt" | "terms" | "bylines" | "references";

// Called by a room: in-process on Node.js, through the `EmDashRoomSite` entrypoint on Workers.
interface RoomSite {
	// Loads entries in Trash too, marked as trashed, with the manifest `hash` and the inputs the
	// shared editor schema takes, such as plugin block types. Resolves to null when the entry is
	// gone.
	load(entry: EntryRef): Promise<LoadedEntry | null>;
	// Resolves to the `_rev` and stored values of this save's own write.
	save(entry: EntryRef, checkpoint: CheckpointInput): Promise<SaveResult>;
	// Also saves for entries in Trash.
	saveRecovery(entry: EntryRef, recovery: RecoveryInput): Promise<void>;
}

// Called by a room: the Durable Object's SQLite on Workers, the site database through Kysely on Node.js.
interface RoomStore {
	load(): Promise<{ record: RoomRecord | null; updates: Uint8Array[] }>;
	append(updates: Uint8Array[]): Promise<void>;
	writeRecord(record: RoomRecord, update?: Uint8Array): Promise<void>;
	compact(state: Uint8Array): Promise<void>;
	drop(): Promise<void>;
	// Node.js claims; on Workers, `claim` and `renew` resolve to true. `claim` takes the room if no
	// live claim holds it, and the room loads after it. Every other method except `release` first
	// renews this process's claim in its transaction: `renew` resolves to false, and the others
	// reject, when the claim isn't this process's. `release` clears the claim only if it is this
	// process's.
	claim(): Promise<boolean>;
	renew(): Promise<boolean>;
	release(): Promise<void>;
}
```

Sockets and timers come from the host.

### Data model

| Change                                                                                                                                                     | Purpose                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `revisions.kind`, a nullable text: `autosave`, `recovery`, or null for a kept revision                                                                     | Autosaves replace only autosaves, and restoring a recovery revision runs validation and hooks |
| `revisions.edited_by`, a nullable JSON list of user IDs                                                                                                    | Who edited a revision since the one before it. Null means its author alone.                   |
| `_emdash_room_updates`: `room_id`, `seq`, `part` and `data` (a blob on SQLite, `bytea` on PostgreSQL), with primary key (`room_id`, `seq`, `part`)         | Room storage: updates and compacted state                                                     |
| `_emdash_rooms`: `room_id`, `part`, a nullable `record` (JSON), a nullable `host` and `claimed_at`, and `updated_at`, with primary key (`room_id`, `part`) | Room storage: the room record, and on Node.js the room's claim                                |

The room record holds the lineage and fingerprint; the last checkpoint's snapshot; the merge base; the users with updates the last checkpoint doesn't contain, latest first; and the entry's status and author when the room last loaded it. On Workers, each Durable Object keeps the two room-storage tables in its own SQLite, where `room_id` is constant. On Node.js, `room_id` is `{collection}:{entry ID}`, and the row with `part` 0 holds the claim, with a null `record` until the room initializes.

### Configuration

Co-editing is on by default, and `coEditing: false` in the `emdash()` options turns it off. Node.js sites need nothing else. On Cloudflare, the Worker entry spreads the default export of `@emdash-cms/cloudflare/worker`, as templates already do, so its `fetch` forwards room upgrades, or calls its `handleRoomUpgrade` first in a custom `fetch`. The entry also re-exports `EmDashRoom` and `EmDashRoomSite`, and the Wrangler config adds the binding and declares the class in its `exports` field:

```jsonc
"durable_objects": { "bindings": [{ "name": "EMDASH_ROOMS", "class_name": "EmDashRoom" }] },
"exports": { "EmDashRoom": { "type": "durable-object", "storage": "sqlite" } }
```

A Worker that still uses the legacy `migrations` array, which can't be combined with `exports`, adds `{ "tag": "emdash-rooms", "new_sqlite_classes": ["EmDashRoom"] }` to it instead.

`@emdash-cms/cloudflare` registers its room host when the binding is present. On Node.js, the bundled copy of `emdash` registers the in-process host when the integration reports `@astrojs/node`, except in `node:cluster` workers.

## Appendix B: Room mechanics

This appendix holds the exact rules behind documents, saves and merges.

### Documents

- **Keys.** The client that creates a Portable Text block assigns its `_key` in the same transaction, including on split and paste. The shared converter derives any other missing or duplicate key, of a block, span or mark definition, from the node's position, so a document always serializes to the same Portable Text.
- **Normalizing plugins,** such as the trailing paragraph, ordered-list joining and table keys, act only on what the client's own transaction changed. The room writes initial documents, merges and overwrites in the form those plugins produce, so opening an entry or receiving a merge makes no client write.

### Hashes

**Hashes** are SHA-256 of RFC 8785 canonical JSON, for each field and for the slug. The stored slug is the draft revision's staged `_slug`, or else the live slug. After a save, the room records the slug it sent, if any, and otherwise keeps the previous hash.

### Merge base records

- **After a save,** the room records the `_rev` the write produced, the hash of every value it stored, and the hash of every value it sent. It takes them from the save's own write, never from a later read, which can include another write.
- **After a merge,** it records the loaded `_rev`, the hash of every loaded value, and the hash of each written field as serialized after the write. Where both values changed, it clears the document hash, so the next save sends the document's value.

### Writing merges

The room writes rich text with `updateYFragment`, which keeps the unchanged blocks at both ends, and other values with `Y.Map.set`. It compares, writes and serializes each written field in one synchronous step, with a synchronous hash.

### Compaction

Past 1 MB of appended updates, the room replaces them, in one transaction, with one state from `Y.encodeStateAsUpdate`. The document keeps Yjs garbage collection on. Values over 1 MB are stored in parts.

## Appendix C: Limits

These are starting values, for the prototype to measure.

| Limit                                                 | Value                                             |
| ----------------------------------------------------- | ------------------------------------------------- |
| Largest update                                        | 1 MB encoded                                      |
| Largest entry for a room                              | 1 MB of stored data                               |
| Largest compacted document                            | 2 MB encoded                                      |
| Largest recovery revision                             | 4 MB of stored data                               |
| Connections per room                                  | 25                                                |
| Connections per user in a room                        | 5                                                 |
| Token                                                 | 60 s, single use                                  |
| Connection lifetime                                   | 15 minutes                                        |
| Store delay                                           | 1 s                                               |
| Compaction threshold, and part size                   | 1 MB                                              |
| Save delay                                            | 2 s after the latest co-editor update             |
| Longest wait between saves while updates arrive       | 10 s                                              |
| Operation hold                                        | 30 s                                              |
| A room stays open after its last connection closes    | 10 s                                              |
| Room state after the last store or closed connection  | 1 hour                                            |
| Claim renewal and claim expiry (Node.js)              | 20 s, 1 minute                                    |
| Longest shutdown wait for rooms (Node.js)             | 5 s                                               |
| Wait for a server before single-editor mode (Node.js) | 60 s after the first token                        |
| Sockets that fail to open before single-editor mode   | 3, before any socket in the browser session opens |
| Join retry after `ROOM_BUSY` or a `busy` close        | 5 s                                               |
