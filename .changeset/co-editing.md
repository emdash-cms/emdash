---
"emdash": minor
"@emdash-cms/admin": minor
"@emdash-cms/cloudflare": minor
---

Adds real-time co-editing to the admin editor, off by default for now. With `coEditing: true`, in collections with revisions, several people can edit an entry at the same time: each person sees the others' avatars, the field each one is in and their cursors in rich text, concurrent rich-text edits merge, and undo reverts only your own edits. A room for each entry saves everyone's edits together, with the same permissions, validation, hooks and revisions as other saves, and changes from the REST API, MCP, the CLI, the visual editor and plugins appear in open editors.

Without co-editing, opening an entry takes an edit lock, and everyone else can only **Open read-only** or **Take over**. With it on, edit locks apply only in single-editor mode, which the editor uses, for example, in collections without revisions, on hosts that can't run rooms, and in browsers that can't open WebSocket connections. Admin tabs opened before co-editing is turned on keep single-editor mode until they reload. [Edit with other people](https://docs.emdashcms.com/guides/working-with-content/#edit-with-other-people) describes what editors see.

- **Saved** appears once a save holds all of your own edits. After 5 seconds without a connection, the button shows **Offline**: typing continues and merges on reconnect, and **Preview**, publishing and the other operations are disabled until then.
- Publishing, scheduling, unpublishing, discarding changes, restoring a version and moving to Trash first save everyone's edits, then run.
- Fields other than rich text keep one of two simultaneous changes, except bylines, reference fields and taxonomy terms, which keep what each person adds and removes. **Turn into**, dragging, deleting, wrapping, joining or indenting a block loses text someone else types inside it at the same moment.
- Edits that can't merge are saved as a recovery revision.

Public pages run no new queries, with co-editing on or off. Where rooms run, opening an entry adds a join request and a WebSocket connection. A room saves 2 seconds after the latest change, and at least every 10 seconds while people keep typing, however many people edit. Measured on Node.js with an in-memory SQLite database, saving a 2,000-word entry took 2.27 ms of CPU time at the median (3.83 ms at the 95th percentile), about two thirds of it the site's own draft save. Merging a write from outside the editor took 0.80 to 1.19 ms, and a notification with nothing to merge 0.67 ms ([CPU time](https://docs.emdashcms.com/deployment/nodejs/#cpu-time)).

#### What should I do?

Nothing, unless you want co-editing. To turn it on, set the option and rebuild and deploy the site:

```js
emdash({
	coEditing: true,
});
```

On Node.js with `@astrojs/node`, in standalone or middleware mode, co-editing runs in the site's own process and the site starts as before. Check these cases first, which [Co-editing on Node.js](https://docs.emdashcms.com/deployment/nodejs/#co-editing) covers in detail:

- A reverse proxy must forward WebSocket upgrades on `/_emdash/api/content/{collection}/{id}/room`. Otherwise each browser session falls back to single-editor mode after three failed connections, and the server logs a `[co-editing]` warning.
- Several processes on one database: route each room path to one process, for example by hashing the path, or leave co-editing off.
- `node:cluster` workers, including PM2's cluster mode, keep single-editor mode.
- Another WebSocket handler on the same server must leave room paths alone. Replace a `ws` server created with `{ server }`, `express-ws` or `@fastify/websocket` with a `ws` server created with `noServer: true` that handles only your paths, or leave co-editing off.
- On Node.js 22.16 to 22.20, 23, and 24.0 to 24.8, a server whose only `upgrade` listener is EmDash's answers upgrade requests on other paths, such as `Upgrade: h2c`, with `404`. Node.js 22.21 and later, and 24.9 and later, serve them as before.
- While rooms are open, EmDash handles `SIGTERM` and `SIGINT` and stops the process up to 5 seconds later. Give process managers a kill timeout over 5 seconds, such as PM2's `kill_timeout`, which defaults to 1.6 seconds.

On Cloudflare, sites created from this release's templates already have the binding and the room exports, so they need only `coEditing: true`. For an existing site, also add the binding and the `exports` entry to `wrangler.jsonc`, as [Co-editing on Cloudflare](https://docs.emdashcms.com/deployment/cloudflare/#co-editing) shows:

```jsonc
"durable_objects": { "bindings": [{ "name": "EMDASH_ROOMS", "class_name": "EmDashRoom" }] },
"exports": { "EmDashRoom": { "type": "durable-object", "storage": "sqlite" } }
```

A Worker that uses the `migrations` array, which can't be combined with `exports`, adds `{ "tag": "emdash-rooms", "new_sqlite_classes": ["EmDashRoom"] }` to it instead. Then re-export the room classes from the Worker entry point:

```ts
import handler, {
	createScheduledHandler,
	EmDashRoom,
	EmDashRoomSite,
	PluginBridge,
} from "@emdash-cms/cloudflare/worker";

export { EmDashRoom, EmDashRoomSite, PluginBridge };

export default {
	...handler,
	scheduled: createScheduledHandler(),
} satisfies ExportedHandler;
```

A Worker with its own `fetch` calls `handleRoomUpgrade(request, env)` first and returns its response when it isn't `null`. A site without the binding keeps single-editor mode.

#### Changes for API clients and plugins

These apply only on sites with co-editing on.

- While people co-edit an entry, it has no edit lock: writes that got `409 ENTRY_LOCKED` land and merge into the editor. Writers that send `_rev` can get `409 CONFLICT` more often, because the room saves every few seconds, and MCP publish, unpublish, schedule and discard conflict while the room holds unsaved edits.
- The lock route's `POST` deletes user locks while a room holds the entry, instead of granting one.
- A room saves as one user, the actor, but a save can hold several people's edits. A hook that checks the actor's role before accepting content should check everyone in `editedBy`. In a room, `content:beforeSave` hooks get only the fields a save changed, as they do for visual-editor saves.
- While a room is open, editor-draft requests skip the `baseRevision` check, and the editor refuses a plugin's patch only when a field it changes was edited after the capture.

These apply on every site, with co-editing on or off:

- `PUT /_emdash/api/content/{collection}/{id}` takes an optional `expected` object with the `bylines` and reference selections (`references`, every page of a field) that a change was based on, as a read returned them. `POST /_emdash/api/content/{collection}/{id}/terms/{taxonomy}` takes an optional `expected` list of term ids. When a stored list differs, nothing is written and the request fails with `409 LIST_CONFLICT`: read the entry again, apply the change to the list it holds now, and retry. Requests without `expected` work as before.
- `POST /_emdash/api/content/{collection}/{id}/room` joins an entry's room. It needs a signed-in session rather than an API token, and answers `{ "mode": "single-editor" }` unless the site runs co-editing.
- A migration adds the `_emdash_rooms` and `_emdash_room_updates` tables, which hold co-editing rooms. Site transfer never copies them.
- `GET` and `POST /_emdash/api/content/{collection}/{id}/lock` responses include a `room` field, which is `true` only while a co-editing room holds the entry.
