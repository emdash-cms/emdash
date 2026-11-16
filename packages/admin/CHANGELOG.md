# @emdash-cms/admin

<!-- emdash-changelog-archive: ./changelog/0.42.0-to-1.3.0.md -->

## 1.5.0

### Minor Changes

- [#4628](https://github.com/emdash-cms/emdash/pull/4628) [`1eedf99`](https://github.com/emdash-cms/emdash/commit/1eedf999dfc4bc119fc82f56b4d39165a46bd728) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Adds **Settings > Sidebars**, where each admin user hides and reorders entries in the admin navigation and sections in the content editor's settings sidebar. Every role can open it from the user menu. The layout is saved to the user's account, so it follows them to every browser, and it changes nobody else's sidebars.
  
  - Navigation entries move within their group or folder. Dashboard always stays first and visible. `admin.hiddenNavItems` still hides entries for everyone, and those entries don't appear on the page.
  - The editor sidebar order applies to every collection and to new entries. Publish can move but can't be hidden.
  - Reset restores a list's default and offers Undo.
  
  The editor settings sidebar no longer shows a drag handle on each section. A **Customize sidebar** link after the last section opens the new page, and a pencil at the bottom of the navigation does too. Section orders that the drag handles saved in a browser are not carried over, so every user starts from the default order.
  
  `GET /_emdash/api/auth/me` returns the stored layout as `adminLayout`, or `null`. `POST /_emdash/api/auth/me` accepts `{ "action": "setAdminLayout", "adminLayout": { ... } }` to replace it, or `"adminLayout": null` to remove it. A layout is limited to 200 IDs per list and 16 KB.
  
  Browser tests that used the editor sections' "Drag to reorder …" buttons need to change, because those buttons no longer exist. Byline reorder handles are unchanged.

- [#4731](https://github.com/emdash-cms/emdash/pull/4731) [`84e173f`](https://github.com/emdash-cms/emdash/commit/84e173f1fb7aa4ec19ccd59ca327d9145822dc77) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Adds optional `isVisible(ctx)` checks to native content editor panels. Plugin authors can return a boolean or `Promise<boolean>` using the same collection, saved entry, and locale context as the panel component, for example `isVisible: async ({ collection }) => isEnabledCollection(collection)`.
  
  The entire section stays hidden until its first check returns `true`, avoiding empty plugin headings when visibility depends on asynchronously loaded settings. Failed checks hide the panel and log its plugin and panel IDs without unmounting the editor. Panels without `isVisible` retain their existing behavior, and `collections` and `minRole` still filter panels before visibility checks run.
  
  The first check for a collection, entry ID, and locale keeps the section hidden until it returns `true`. Checks rerun when the saved entry changes, including after autosaves, saves, and publication. During these rechecks, the section keeps its last visibility decision so visible panels stay mounted and retain local state. A result other than `true`, a throw, or a rejection hides the section when the check settles. Superseded results and errors are ignored.

- [#4573](https://github.com/emdash-cms/emdash/pull/4573) [`8d0250c`](https://github.com/emdash-cms/emdash/commit/8d0250c9cac044fc2fc897bd90115fea7ed42e78) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Updates `blocks` fields in the content editor so editors can scan a page of blocks, add, move or delete one without scrolling through every form, and edit an open block in the order the page shows it. Lists inside blocks take a shape that fits what they hold, and the admin checks block fields before saving. Every site with a blocks field gets the new editor; stored content, the API, block type schemas and how sites render blocks are unchanged.
  
  #### The block list
  
  - Blocks sit on one sheet and start closed when the edit screen opens. In a read-only entry, every block and list item shows open, since its controls can't be used there. A closed block shows its type's icon, its name, a one-line summary of its text or of its first list's items, and a thumbnail when it has a photo. "Collapse all" and "Expand all" sit next to the field's label, and an open block's header stays pinned while you scroll through its fields. Opening, closing, adding, duplicating, deleting and moving blocks and list items animate briefly, while Expand all, Collapse all and keyboard moves take effect at once. Reduced motion turns every animation off.
  - Each block's `⋯` menu has Add block above, Add block below, Duplicate, Move up, Move down, Move to top, Move to bottom and Delete. Its footer names the block type and version, such as "Hero · version 2", which replaces the "Version N" badge on every block. "Inactive version", "Retired" and "Unsupported" stay on the block as tags.
  - On screens at least 40rem wide with a mouse or trackpad, hovering a block shows `+`, which adds a block below (Alt-click adds one above), and a handle that drags the block or opens its menu. Both are for the pointer and stay out of the Tab order, so the handle no longer reorders blocks from the keyboard; the `⋯` menu has the same actions. On touch and phone-width screens, `⋯` is always visible. On touch screens, menu buttons, menu items, Expand all, Add item, photo actions and Undo have larger targets, and tapping Add block or a list item opens it without raising the on-screen keyboard.
  - Alt+Shift+Up and Alt+Shift+Down move a block or list item one place from its head or its `⋯` button, keeping focus on it, and a screen reader hears the new position.
  - The block picker opens next to where the block will go, keeps its search, categories and descriptions, shows each block type's icon, and works with the arrow keys and Enter. A block you add opens with its first field focused. A duplicate goes below the original, open or closed like the original, and takes focus.
  - Deleting a block shows a toast with Undo, which puts the block back in its place. While the toast shows, Cmd+Z (Ctrl+Z outside Apple platforms) does the same, unless focus is in a text field, which keeps its own undo. The toast stays for 6 seconds after a deletion made with the mouse, and for 15 seconds after one made with the keyboard, by touch or by assistive technology. Blocks of a retired type, an older version or an unavailable definition ask for confirmation instead and can't be undone, because the server doesn't accept them as new blocks once the deletion is saved.
  - At the field's `maxItems`, every add action and Duplicate are disabled, and the add buttons explain the limit. Duplicate is also disabled for blocks on an older version of their type, because the server only accepts new blocks on the active version.
  
  #### Fields inside a block
  
  - An open block shows its content first: one-line text, text areas, rich text, photos and lists, each under a small label. The block's headline is drawn larger, two or three one-line text fields in a row share a line, a photo's `{image}_caption` field sits under it, and text areas start one line tall and grow as you type.
  - Settings follow as rows under a divider, with the label beside the value: switches, choices, numbers, dates, files and links. A button's text and its link share one row, such as `cta_label` and `cta_url`. The section ID (`anchor_id`) waits in a closed Advanced row that shows its value. When the field is narrower than 440 px, each row puts its label above its value.
  - Fields have no box until you hover or focus them, and labels show as written. While a field with a length limit has focus, its character count shows on its label's line, or at the end of its own line in a settings row that sits beside its label. A value that doesn't match the field's `pattern` reads "Invalid link" in a link field and "Check the format" elsewhere.
  - Enter in a one-line field moves to the next text field in the block or list item instead of saving the entry.
  
  #### Lists inside a block
  
  - A list (`repeater` field) inside a block takes its shape from its sub-fields. A list with one `string` or `url` sub-field is a bulleted type-in list: Enter adds a line after the current one, Backspace on an empty line removes it, the arrow keys move between lines, and pasting several lines adds one item per line. Blank lines you add are never saved, and leaving the list removes them. A list with up to three `string`, `url`, `number`, `integer`, `select` or `image` sub-fields, at most one of them an image, is a table with a column per sub-field, and its image cells open the media picker. Every other list shows expandable items: a closed item shows its title, up to two more of its values and a thumbnail, and an open item edits its title in its row, with its other sub-fields laid out like a block's.
  - In a table, Enter moves down a column and adds a row after the last one, and the Up and Down arrow keys move within a column. A blank row added with Enter goes when focus leaves it.
  - A list with items shows its count next to its label. Hovering an item shows a drag handle and a `⋯` menu with Move up, Move down, Move to top, Move to bottom and Delete; an expandable item's menu also has Add item above, Add item below and Duplicate, in the same order as a block's menu. A duplicated item stays open or closed like the original. On touch and phone-width screens, `⋯` is always visible. Deleting an item, or removing a photo from a block, also shows a toast with Undo. The page has one Undo across its blocks fields, so only the latest deletion can be put back. "Add item" sits at the end of the list and is hidden at the list's `maxItems`, and Delete is disabled at its `minItems`.
  - A new list item leaves its sub-fields unset, so an empty link, choice or date sub-field no longer stops the entry from saving, and clearing a link writes `null`.
  
  The layout of fields and lists follows field types and slugs, never labels. The naming conventions, and how a list's sub-fields pick its shape and its items' titles, are listed in [Build pages with blocks](https://docs.emdashcms.com/guides/blocks/#name-fields-for-the-editor-layout); a field that matches none of them gets a row of its own. Top-level `repeater` fields keep their current editor.
  
  #### Checks and autosave
  
  - The admin checks block fields with the server's rules: required fields, patterns, lengths, number ranges, whole numbers, choices, safe links, list sizes and required list sub-fields. An empty required field reads "Required". A problem shows in red once you save or publish; before that, a format, length or range problem shows when focus leaves the field, and "Required" turns red when you empty a required field and leave it. Tabbing through empty fields flags nothing. A problem shows on the field's label line, or at the end of a settings row's value, moving to its own line under the value when it doesn't fit. A closed block, list item or Advanced row with a problem shows a red dot.
  - Save and Publish show every block's problems, open the block, Advanced row and list item that hold the first problem on screen, focus it, and announce how many fields need attention. Until they're fixed, a "N to fix" button next to Expand all goes to the next problem with each press.
  - While a block field has a problem, autosave waits, as it does for an invalid URL, and once focus leaves that block, an "Autosave paused" notice names the block and field. Its Show button opens the block and focuses the field. Autosave resumes with your next change once every problem is fixed. A new block's switches start off, so a required switch is never missing.
  
  #### Block type icons
  
  Block types show their `icon` setting, a Phosphor icon name such as `"sparkle"` or `"chart-bar"`, in the block list and the picker. A block type without an icon, or with a name that doesn't match a Phosphor icon, shows a generic block icon. The marketing and portfolio templates now give their block types icons. Sites created from those templates before this release keep their stored block types, which have no icons, so their blocks show the generic icon until each block type gets an `icon`, for example through `PUT /_emdash/api/schema/block-types/{slug}` or the `schema_update_block_type` MCP tool.
  
  #### The editor's scrollbar
  
  The content editor's scrollbar shows over the page while you scroll, and under the pointer at the page's edge, instead of taking a strip beside it. Where scrollbars take up room, as on Windows and Linux, the page now keeps its width and stays centered whether or not it scrolls, and no longer shifts sideways when it grows long enough to scroll. This applies to every entry, not only ones with a blocks field.

- [#4695](https://github.com/emdash-cms/emdash/pull/4695) [`22b87ed`](https://github.com/emdash-cms/emdash/commit/22b87edc3f68ef173683a698af49275c5201d5fe) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Adds real-time co-editing to the admin editor, off by default for now. With `coEditing: true`, in collections with revisions, several people can edit an entry at the same time: each person sees the others' avatars, the field each one is in and their cursors in rich text, concurrent rich-text edits merge, and undo reverts only your own edits. A room for each entry saves everyone's edits together, with the same permissions, validation, hooks and revisions as other saves, and changes from the REST API, MCP, the CLI, the visual editor and plugins appear in open editors.
  
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

- [#4730](https://github.com/emdash-cms/emdash/pull/4730) [`a17a4b3`](https://github.com/emdash-cms/emdash/commit/a17a4b34bd59f6a5074dd061642760113dadb3aa) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Adds support for `publishedAt`, `createdAt`, and `updatedAt` as a collection's `dateField`, so editors can see and sort by publication dates without duplicating system timestamps in a custom field. Choose **Date column source** in the existing content type's settings, or set `dateField` through the collection update API or a seed file.
  
  Collections without a configured `dateField` still show and sort by last-updated. Entries with a missing or invalid configured date display their last-updated date, while sorting uses the configured source.

- [#4791](https://github.com/emdash-cms/emdash/pull/4791) [`cdfd98d`](https://github.com/emdash-cms/emdash/commit/cdfd98d8ef532ece23312a1c254aa505858c4adb) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Adds generated avatars for users without a profile picture. The header, the **Users** list, the user detail panel and the **Authorize device** page show a colorful avatar with the user's initials, chosen from their user ID so each user looks the same everywhere. Users without a name show the avatar without letters instead of their email's first letter. On phones, the header's user menu button is now named after the user for screen readers.

- [#4729](https://github.com/emdash-cms/emdash/pull/4729) [`006cfc0`](https://github.com/emdash-cms/emdash/commit/006cfc0e024ed0b0dd9cd29e7726ac9706d19524) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Adds the `no-scheduling` collection support flag to disable creating or changing schedules in the content editor, calendar, and scheduling API. Scheduling remains enabled by default, and existing schedules continue to run and can be removed.
  
  To disable scheduling, add `no-scheduling` to the collection's `supports` in a seed file, or update an existing collection through `PUT /_emdash/api/schema/collections/{slug}` or the `schema_update_collection` MCP tool. For example, a collection with drafts and revisions can use:
  
  ```json
  { "supports": ["drafts", "revisions", "no-scheduling"] }
  ```
  
  Preserve the collection's other support values when updating its list. There is no Content Type editor checkbox for this flag, but saving in that editor preserves it.
  
  If you previously omitted `scheduling` expecting scheduling to be disabled, add `no-scheduling` instead. The legacy `scheduling` value is deprecated and has no effect; it remains accepted for compatibility and can be removed from seed files. If both values are present, `no-scheduling` takes precedence. Sites that want to keep scheduling enabled do not need to change anything.
  
  WordPress imports into a collection with `no-scheduling` keep future-dated posts as drafts and report a scheduling error for each such post.

- [#4637](https://github.com/emdash-cms/emdash/pull/4637) [`c9696af`](https://github.com/emdash-cms/emdash/commit/c9696af9d29514666c37c358ae700b2122cc06e9) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes autosave deleting versions saved with **Save**, and names everyone who edited each version in revision history.
  
  - An autosave replaces the previous version only when that version is also an autosave. A version saved with **Save**, or one EmDash creates itself, such as the draft copy an unpublish leaves, stays in **Revisions**.
  - Each version names everyone who edited it since the version before it, such as "Ana, Ben, and 1 other person", and marks its changes in a neutral color when several people edited it. The publish confirmation names everyone who edited the entry since the published version.
  - `GET /_emdash/api/content/{collection}/{id}/revisions` and the MCP `revision_list` tool return `editedBy` on each version: the people who edited it, latest first, as `{ id, name }`, with `null` for an account that no longer exists. `null` means the version names only its `author`.
  - `GET /_emdash/api/content/{collection}/{id}/revisions/editors?since={revisionId}` returns everyone who edited the entry in the versions newer than `since`, newest first and once each, in the same shape. Without `since`, it returns everyone who edited the entry. It requires `content:read_drafts`.
  - `content:beforeSave` and `content:afterSave` events include `editedBy`, the IDs of the users whose edits the save holds, latest first. A save with an `actor` lists only that user. A hook that checks the actor's role before accepting content should check everyone in `editedBy`.
  
  A migration adds two nullable columns, `kind` and `edited_by`, to the `revisions` table. Existing versions are not backfilled: they name only their author, and autosave never replaces them. Site transfer leaves both columns out, so transferred versions also name only their author. Once a site has run the migration, earlier EmDash versions can't export it or import into it with site transfer.

- [#3716](https://github.com/emdash-cms/emdash/pull/3716) [`284fa80`](https://github.com/emdash-cms/emdash/commit/284fa8049a29113c5f400e2780b002169994ba56) Thanks [@swissky](https://github.com/swissky)! - Adds a staging mode that keeps a site out of search engines until it goes live. Sites created through setup, whether in the setup wizard or by a script that calls the setup API, start in staging:
  
  - Pages that render `<EmDashHead>` get a `noindex, nofollow` robots tag, which overrides SEO panel and plugin robots values. Templates without `<EmDashHead>` don't get the tag.
  - `/robots.txt` keeps its usual content so crawlers can read the tag, and isn't cached while the site is in staging.
  - The admin header shows a **Staging** badge.
  
  To go live, an administrator selects **Go live** in **Settings > General > Site Status**, sends `{ "staging": false }` to the settings API, or uses the MCP `settings_update` tool. **Switch back to staging** hides the site again. Staging is visibility only: visitors can still open every page.
  
  Existing sites are not affected: a site without the setting is live. Site transfer and `emdash export-seed` don't copy the staging status.

- [#2156](https://github.com/emdash-cms/emdash/pull/2156) [`25574da`](https://github.com/emdash-cms/emdash/commit/25574da51e580b95799a0ec3d43f680730d33f5f) Thanks [@swissky](https://github.com/swissky)! - Adds a built-in SMTP email provider. It delivers through any standard SMTP server, such as Brevo, Office 365, Fastmail, Amazon SES or a self-hosted Postfix, on Node and on Cloudflare Workers with the `nodejs_compat` flag.
  
  #### Configure
  
  Choose **SMTP** under Settings → Email, or set environment variables:
  
  - Required: `EMAIL_SMTP_HOST`, `EMAIL_SMTP_USER` and `EMAIL_SMTP_PASS`.
  - Optional: `EMAIL_SMTP_PORT` (587 when empty), `EMAIL_SMTP_SECURE`, `EMAIL_SMTP_FROM`, `EMAIL_SMTP_FROM_NAME`, `EMAIL_SMTP_FROM_EMAIL` and `EMAIL_SMTP_REPLY_TO`.
  
  Without a sender address, the username is used as the sender, so the admin requires a sender email when the username is not an email address (for example an Amazon SES or SendGrid key). Settings saved in the admin take precedence over environment variables and apply without a restart. Saving them requires `EMDASH_ENCRYPTION_KEY`, which encrypts the password in the database. Changing the host or username requires entering the password again.
  
  Port 465 uses implicit TLS and port 587 uses STARTTLS. The provider verifies the server certificate, never signs in before TLS is established, and signs in with `AUTH PLAIN` or `AUTH LOGIN`, whichever the server offers. Port 25 is refused. Invalid environment variables are ignored with a warning in the server log.
  
  #### Provider selection
  
  Settings → Email now has a provider dropdown that lists SMTP and any installed email plugins. When its environment variables are set, SMTP delivers email unless an email plugin is active or another provider is selected. Without them, SMTP is used only after you select it. A site with a single email plugin still selects that plugin automatically. In `astro dev`, the console provider is used only when no other email provider is active, and that choice is no longer saved to the database.
  
  **Send test email** now shows the SMTP server's error, for example a rejected login, instead of a generic failure.
  
  #### API
  
  `GET /_emdash/api/settings/email` also reports the SMTP settings, without the password. The new `PUT /_emdash/api/settings/email` saves SMTP settings together with the selected provider, or selects a plugin provider. `PUT` with `{ "provider": "smtp" }` and no settings selects SMTP from its saved settings or environment variables. Sending a test email with `POST /_emdash/api/settings/email` returns SMTP delivery errors with status 502.

### Patch Changes

- [#3066](https://github.com/emdash-cms/emdash/pull/3066) [`c108e7b`](https://github.com/emdash-cms/emdash/commit/c108e7b03756005db7df404b0c6c916dc8463fd1) Thanks [@zaochih](https://github.com/zaochih)! - Accepts BMP images in the Media Library. Uploads through the admin, the media API, and the MCP `media_upload` tool no longer fail with `File type not allowed`. BMP files show as thumbnails in the upload dialog, are included in the "Images" preset of the allowed file types editor, and are displayed in the browser instead of downloaded. Fields with their own `allowedMimeTypes` can list them as `.bmp`.

- [#4520](https://github.com/emdash-cms/emdash/pull/4520) [`7bce592`](https://github.com/emdash-cms/emdash/commit/7bce59234985ed110beb063ce1d55a99d5d9a853) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Updates the Comments inbox table in the admin to match the content list's look, and fits it on phones.
  
  - The Author and Comment columns are now one Comment column, with each author's name and email above their comment. Clicking the author's name or the comment opens the comment's details. Approve stays on each row that can be approved, and Mark as spam, Trash, and, for admins, Delete permanently move into the row's "…" menu.
  - On right-to-left pages, each author's name and comment keeps its own text direction, so an English comment's closing punctuation stays at its end.
  - When the table is narrower than 42rem (672px), such as on phones and portrait tablets, the Content and Date columns fold away and show under the comment instead. When the table is narrower than 28rem (448px), such as on phones, the author's email is hidden too.
  - The bar that appears when comments are selected matches the content list's: it wraps on narrow screens instead of running off the edge, has a Clear button, and disables its buttons while a moderation request is running. Its Delete button now asks for confirmation before permanently deleting the selected comments. When a bulk action fails, the selection is kept for a retry, and a failed permanent delete, from the bar or a comment's menu, keeps its confirmation open with the error.
  
  Browser tests that clicked a row's "Mark as spam", "Trash", or "Delete permanently" button need to open the "Actions for comment by {author}" menu first, where those are menu items with the same names. The row's Approve button keeps its name. The select-all checkbox is now named "Select all on this page", and the author's name is a button named after the author alone instead of one that also held their email. The "Author" column header is gone, so tests that locate a `columnheader` named "Author" need to change. The "Actions" column header is now visually hidden and keeps its accessible name.

- [#4174](https://github.com/emdash-cms/emdash/pull/4174) [`3d4faaf`](https://github.com/emdash-cms/emdash/commit/3d4faaff6c06005c5e9e5e046720b2fe502f5020) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes the admin continuing to show or hide actions based on a user's old role after an administrator changes that role. The admin now reloads the signed-in user's role when the server refuses a request and when the user returns to the admin tab, instead of keeping the old role for up to five minutes.

- [#4495](https://github.com/emdash-cms/emdash/pull/4495) [`76f0f53`](https://github.com/emdash-cms/emdash/commit/76f0f53221c380cc77b73da5e455408dca720902) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes how admin dialogs handle mistakes, slow requests and stray clicks, so each dialog says what is wrong and typed input is not lost by accident.
  
  In form dialogs, such as the field, relation, byline, menu, section, taxonomy, redirect, folder, domain and invite dialogs, the main action stays available instead of being disabled without a reason. Pressing it with missing or invalid input marks each field that needs attention with a message and moves focus to the first one, and each message clears as its field is corrected. The checks match what the server accepts, so most mistakes are caught before anything is sent, and a name or slug that is already taken is reported on its field in the admin's language. A new select field also needs at least one option, and a new blocks field at least one block type when the site has any, because editors could not fill in either field without them. The field dialog's length and item limits must be whole numbers: before, a limit of 2.5 was saved as 2, and text that isn't a number, such as `1e`, saved the field with no limit. Enter submits these dialogs, a double click sends one request, and a dialog with typed input no longer closes when you click outside it or swipe it down on a phone. Cancel and Escape still close it.
  
  Confirmations that send a request, such as deleting a content type, field, comment or entry, discarding draft changes, replacing an image with its crop, or taking over an entry someone else is editing, now stay open while the request runs, show its progress, and show a failure inside the dialog instead of closing first. A failure shown in a dialog is no longer also reported in a toast, apart from a failed save of the entry's unsaved edits before scheduling or changing its publication date.
  
  A few dialogs also behave more predictably:
  
  - Adding a term whose name is already used under another parent suggests a free slug, such as `accessories-1`, instead of saving it under a different slug than the one shown.
  - A file type typed into a media field's allowed types but not added is saved with the field.
  - A plugin install that asks for more permissions lists them without reporting a failure.
  - Deleting a redirect that was already deleted closes the confirmation instead of showing an error.
  
  #### Browser tests
  
  Tests that expected a dialog's action to stay disabled until its form was valid should press it and check the field's error instead. Tests that waited for failure toasts such as "Failed to delete" or "Failed to schedule" should look for the error inside the dialog. New toasts such as "Term created" and "Invitation sent to …" use the `dialog` role, so locate dialogs by name.

- [#4495](https://github.com/emdash-cms/emdash/pull/4495) [`76f0f53`](https://github.com/emdash-cms/emdash/commit/76f0f53221c380cc77b73da5e455408dca720902) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Updates the admin's confirmation, form and notice dialogs to Kumo's `LayerDialog` design. Each dialog keeps its title in a fixed header, scrolls its content in a card, and puts Cancel and the main action in a tray along the bottom. On phones, dialogs open as bottom sheets, and most can be swiped down to dismiss. Block Kit button confirmations on plugin admin pages use the same design.
  
  Inside dialogs, groups of fields share one section heading style, selects fill the width of their column, and paired fields stack on phones. Explanations that used to sit under fields, such as "Slugs cannot be changed after the field is created.", are behind an info button beside the label, which opens on hover, keyboard focus or a tap. Errors, warnings about what an action will do, and format rules the dialog does not check stay visible. Screen readers read an info button's note as the button's description, without opening it.
  
  Dialogs with Cancel and an action no longer show a separate close (×) button; Cancel and Escape behave as before. In the byline and media folder dialogs, Delete moves from the bottom bar to a row at the end of the dialog that says what deleting does, and the byline avatar shows as a small circle with its actions beside it. Creating a relationship from the field dialog opens it in a second dialog on top, whose Back button returns to the field, and the relation form no longer says it cannot generate a slug before both side names are filled in. A confirmation's message sits under its title and is the dialog's description for screen readers. Form dialogs, such as the field, menu item and schedule dialogs, now also say what they are for under the title, and screen readers read that sentence instead of the whole form. The media picker, media details, media upload, bulk tagging, content picker and section picker dialogs keep their previous layout.
  
  Browser tests that clicked a dialog's "Close" button should click "Cancel" or press Escape instead. A dialog now takes focus itself when it opens, unless one of its fields takes focus, so press Tab to reach its first control. The plugin permissions and uninstall dialogs are now named by their titles, such as "Plugin Permissions" and "Uninstall Gallery?", instead of "Capability consent" and "Uninstall confirmation". A label locator such as `getByLabel("Slug")` can also match the new "More information about Slug" button, so pass `{ exact: true }` or locate the field by its role. An info button's note is also in the page as the button's hidden description, so locate the open note with `getByRole("tooltip")` rather than by its text.

- [#4527](https://github.com/emdash-cms/emdash/pull/4527) [`5a8c620`](https://github.com/emdash-cms/emdash/commit/5a8c6200a78a83bbde4c941a9b0c7f4b63e542a6) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Updates the Media Library's list view to match the content list's look, and fits it on phones.
  
  - Each file's name is a button, so keyboard users can reach it with Tab and press Enter to open the file's details. Clicking anywhere else on the row still opens the details, and rows can still be dragged onto folders. The open file's row takes the table's selection color instead of a brand tint.
  - When the table is narrower than 42rem (672px), such as on phones and portrait tablets, the Type, Size, and Alt text columns fold away and show under each file's name instead. Long filenames, file types, and folder names wrap or truncate instead of widening the table, and each folder row keeps its name and Edit button in view.
  
  In list view, browser tests can find a file's name as a button named after the file, such as `getByRole("button", { name: "photo.jpg" })`. Rows keep their `data-media-draggable`, `data-media-folder-drop-target`, and `data-drop-active` attributes, and the folder controls keep their "Open folder {name}" and "Edit folder {name}" names. A file's type, size, and alt text status are now in the row twice, under its name and in their own columns, with one copy hidden at any width, so tests that look up that text need to scope it to a cell, such as `getByRole("cell", { name: "image/png" })`.

- [#4462](https://github.com/emdash-cms/emdash/pull/4462) [`968a23e`](https://github.com/emdash-cms/emdash/commit/968a23e2a52e2033d33e57d657b031d88012dda1) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Updates the Users and Bylines tables in the admin to match the content list's look.
  
  On the Users page, clicking a user's name opens their details. The name is a button, so it can be reached with the keyboard now, and clicking elsewhere in the row no longer opens the details.
  
  On the Bylines page, clicking a byline's name opens the edit dialog, and the Edit button moves into the row's "…" menu next to Delete byline.
  
  Browser tests that open "More actions for {name}" on the Bylines page should open "Actions for {name}" instead. The byline's name now has the "Edit {name}" accessible name that the Edit button had, so tests that click "Edit {name}" still open the edit dialog. The Bylines panel in the content editor still uses "More actions for {name}". Tests that clicked a row of the Users table should click the user's name.

- [#4494](https://github.com/emdash-cms/emdash/pull/4494) [`b42176d`](https://github.com/emdash-cms/emdash/commit/b42176dcb061c49cddb596c9fce501ed288c3bcc) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes the content list, Users, and Bylines tables running past the edge of phones and other narrow screens, which hid each row's "…" menu until you scrolled sideways. Each table now folds its less important columns away while the table itself is narrow, including when the sidebar leaves it little room, and brings them back when there is room. Tables 42rem (672px) and wider still show every column they showed before.
  
  - On the content list below 42rem, such as on phones and portrait tablets, each entry's status, locale, and date show under its title, and a sort menu replaces the hidden sortable headers. Columns from the collection's list settings and from plugins are hidden there. The Trash tab shows each entry's locale and deleted date under its title the same way.
  - On the Users page below 28rem (448px), the role shows under the email, with Disabled for a disabled user. Last Login and Passkeys are hidden below 42rem.
  - On the Bylines page below 28rem, the byline type shows under the bio or slug. Website is hidden below 42rem, and now shows on any table that wide instead of only on screens 1024px and wider.
  
  Hidden values still show when you open the entry, user, or byline, except values that only a plugin column displays. Long emails and slugs wrap, long words in titles break on narrow tables, and long bios truncate, instead of widening the table. The content list and Users page headers move their button to its own line when a long translation leaves no room beside the title.

- [#4528](https://github.com/emdash-cms/emdash/pull/4528) [`8ce12b7`](https://github.com/emdash-cms/emdash/commit/8ce12b760dcf28319502617b6f7fc5b107fd41e2) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Updates the Redirects page's redirect and 404 tables to match the content list's look, and fits them on phones.
  
  - Each redirect shows its destination under its source, after an arrow, and its group under that, after a folder icon, at every width. Long paths and group names wrap instead of being cut off. A 410 or 451 rule, which has no destination, skips the arrow line. Clicking a redirect's source opens it for editing, and Edit and Delete move into the row's "…" menu. The enable switch, the loop warning, and the "auto" badge stay on the row, and disabled redirects still look faded.
  - When a table is narrower than 42rem (672px), such as on phones and portrait tablets, the Code and Hits columns fold away and show under each redirect, and the 404 table's Last seen column folds under each path. Below 28rem (448px), such as on phones, the 404 table's Hits column folds under each path too. A folded hit count reads like "12 hits". Nothing scrolls sideways on a 320px screen.
  - The 404 table's Create redirect and Mark as Gone (410) buttons match the admin's other buttons and keep their names, their tooltips, and the Mark as Gone (410) button's description for screen readers.
  
  Browser tests that clicked a redirect's "Delete redirect {source}" button need to open the "Actions for redirect {source}" menu first, where Delete is a menu item with that name. "Edit redirect {source}" now names the source path itself, which is a button, so `button[aria-label^="Edit redirect"]` finds the source. The Source, Destination, and Group headers are one column header, named "Source Destination Group". The 404 buttons no longer have a `title` attribute: their tooltips are popups, and the Mark as Gone (410) button's explanation is its accessible description through `aria-describedby`. A redirect's code and a 404's last seen date are in the row twice, under the path and in their own column, with one copy hidden at any width, so tests that look up that text need to scope it to a cell. A hit count shows as a bare number in the Hits column and as, for example, "12 hits" or "1 hit" under the path.

- [#4497](https://github.com/emdash-cms/emdash/pull/4497) [`e34b8fe`](https://github.com/emdash-cms/emdash/commit/e34b8fe5abc520c6ed450be5b624fc771a03bd1a) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Updates the Content Types, Block types, Relations, and Byline Schema tables in the admin to match the content list's look, and fits them on phones.
  
  - On the Content Types page, Edit and Delete move into each row's "…" menu, and code-defined collections offer Edit only. Block types now show as a table below content types.
  - On the Relations page, clicking a relation's slug opens it for editing, and Edit and Delete move into the row's "…" menu.
  - On the Byline Schema page, clicking a field's label opens it for editing, and Edit, Move up, Move down, and Delete move into the row's "…" menu.
  
  On narrow screens, the buttons in the Content Types, Relations, and Byline Schema page headers move onto their own line instead of running off the edge or crowding the page title. On narrow tables, slugs, sources, types, and link, field, and version counts show under each row's name, and the less important columns fold away.
  
  Browser tests that clicked a row's own Edit or Delete button, such as "Delete Posts", now need to open the "Actions for Posts" menu first. The Delete items keep their "Delete {name}" names, and the Content Types Edit item keeps "Edit {name}". On Relations and Byline Schema, "Edit {name}" now names the row's slug or label button, which opens the editor without the menu. The byline field reorder items are named "Move up" and "Move down" instead of `Move "{label}" up` and `Move "{label}" down`.

- [#4537](https://github.com/emdash-cms/emdash/pull/4537) [`c2a6857`](https://github.com/emdash-cms/emdash/commit/c2a68573f82571fd21ecf172291c8c1bdd2d1ada) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes keyboard focus jumping to the top of the page when the row holding it leaves an admin table, for example after deleting a redirect from its "…" menu, moving an entry to the trash, or approving a comment in the Pending tab. Focus moves to the same control in the row that takes its place, so keyboard and screen-reader users can carry on down the list. When no row takes its place, such as when the last row leaves, focus moves to the "…" button of the row above it instead of a control that would act on a row you didn't choose. Focus stays where you put it when you move it elsewhere, such as into a search box or by clicking, and a mouse or touch press cancels a move that is still waiting for a menu or dialog to close.
  
  On the Redirects page, changes such as toggling a redirect or marking a 404 path as Gone no longer replace the tables with a loading or empty message and drop keyboard focus. After a change, the list still goes back to its first page. Each redirect's switch is now named after its redirect, such as "Disable redirect /old-page", so browser tests that find a switch by its exact name need to include the source path.

- [#4503](https://github.com/emdash-cms/emdash/pull/4503) [`52b430c`](https://github.com/emdash-cms/emdash/commit/52b430c05924d9319e90756aff41a823a93b1971) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Updates the term list on the Categories, Tags, and custom taxonomy pages to the content list's table layout, which fits phones.
  
  - Clicking a term's name opens it for editing, and the term's other actions sit in its row's "…" menu. On Categories and custom taxonomies, that menu holds the Edit, Move, Translate, and Delete buttons that were in each row; on Tags, the Edit button moved into it.
  - A term that is the only one under its parent, or the only top-level term, no longer shows Move up and Move down. A term whose parent has no translation in the current locale shows them disabled, and its menu says why, on touch screens and to screen readers too.
  - Deeply nested terms keep their "…" menu in view on phones, and the header buttons on Categories and custom taxonomy pages wrap onto a new line on narrow screens instead of running off the edge.
  
  Browser tests that clicked a term's Move, Translate, or Delete button need to open "Actions for {name}" first, and tests that opened "More actions for {name}" on a tag open "Actions for {name}" instead. In that menu, Delete is named "Delete {name}" on every taxonomy, and the other items are "Move up", "Move down", and "Translate". The term's name is the button "Edit {name}", which opens the editor without the menu.

- [#4495](https://github.com/emdash-cms/emdash/pull/4495) [`76f0f53`](https://github.com/emdash-cms/emdash/commit/76f0f53221c380cc77b73da5e455408dca720902) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes the info buttons beside admin field labels doing nothing when tapped on a phone or tablet. In the content editor, the content list's byline filter, and the filename, alt text and focal point fields in media details, a tap now shows the help, which stays open until the next tap, a tap elsewhere, or Escape. Hovering over or focusing an info button still shows its help, and a mouse click now keeps it open the same way.

- [#4151](https://github.com/emdash-cms/emdash/pull/4151) [`6d5a10d`](https://github.com/emdash-cms/emdash/commit/6d5a10d0267846e71c7bf87aca02a376e07d2e7e) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fits the admin calendar's month view to the screen.
  
  - The month grid fills the window with one-line entries and shows as many per day as fit, folding the rest into "+N more".
  - On wide screens the entry panel sits beside the calendar instead of covering it, and clicking empty space closes it. On phones it is a bottom sheet that swipes down to close.
  - The page title and description give their space to the month. The view switcher and Filter sit above the month's name, which has Today and the month arrows beside it.
  
  Agenda rows show times in the site's time zone; the side panel and entry tooltips also show the viewer's own time. Month cells no longer draw the red line marking the present; the agenda and the lists of a day's entries still do.

- [#4570](https://github.com/emdash-cms/emdash/pull/4570) [`e737608`](https://github.com/emdash-cms/emdash/commit/e7376088f9a02a473753638ca71d3999d96f5f1b) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes admin pages crashing on missing or unparseable timestamps in imported or legacy data, including publication and scheduling dates in the content editor. Invalid dates now render as empty text, and revision times omit the machine-readable date when it is invalid.

- [#4716](https://github.com/emdash-cms/emdash/pull/4716) [`b766773`](https://github.com/emdash-cms/emdash/commit/b7667732bcee48ed094a3f363578b7d525bff212) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes the preview path for Cloudflare Stream videos stuck at `0:00` in the Media Library detail panel. The panel uses Stream's hosted player instead of the browser's native HLS/DASH support. Stream preview URLs ending in `/watch` are converted to the embeddable `/iframe` URL. Media providers can supply an optional `playerUrl` for admin video previews; providers without one keep native video playback.
  
  If you use Astro's content security policy, allow the Stream player host in `frame-src` so the preview can load. EmDash's default admin policy already allows HTTPS frames.

- [#4595](https://github.com/emdash-cms/emdash/pull/4595) [`213904f`](https://github.com/emdash-cms/emdash/commit/213904fe0f3b7b01161e74cfb6603906b2928ce9) Thanks [@swissky](https://github.com/swissky)! - Makes Buttons blocks editable in the rich text editor. Imported WordPress button groups now open a form for their layout and for each button's text, URL and style, and `/buttons` inserts a new group. Saving a group clears a link URL that an earlier editor stored on the group itself, so its card no longer shows that link. Sites with a plugin that registers its own `buttons` block keep using that plugin's editor.

- [#4629](https://github.com/emdash-cms/emdash/pull/4629) [`2237d52`](https://github.com/emdash-cms/emdash/commit/2237d52c405228d5396fe4c72db48083530f7d79) Thanks [@dmythro](https://github.com/dmythro)! - Fixes the content editor's back button naming its list with the collection's singular label. Screen readers now hear "Back to Posts list", matching the "Posts" link beside it, and translations that name the list get its plural label.

- [#4477](https://github.com/emdash-cms/emdash/pull/4477) [`cada545`](https://github.com/emdash-cms/emdash/commit/cada5450a080c107b8396430143288cd94b332ab) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes uploads into Media Library folders: empty folders offer an upload action, completed picker uploads stay visible in their destination, and queued or retried files keep their original folder. Each upload into a folder creates a new media item, even if the same file already exists in that folder or elsewhere, rather than reusing or moving existing media. Main-library uploads retain duplicate detection and keep reused items visible in the picker even when the existing item belongs to a folder.

- [#4305](https://github.com/emdash-cms/emdash/pull/4305) [`d891305`](https://github.com/emdash-cms/emdash/commit/d891305440e57b2ac3b90c0443d161783b2aef50) Thanks [@iNerdStack](https://github.com/iNerdStack)! - Fixes the WordPress import review screen labeling the SEO toggle "SEO settings (Yoast)" regardless of which SEO plugin the source site uses. The label now reads "SEO settings", consistent with the rest of the admin and accurate for sites using Rank Math or other SEO plugins.

- [#4733](https://github.com/emdash-cms/emdash/pull/4733) [`612569b`](https://github.com/emdash-cms/emdash/commit/612569b1cf590dd80ce5ca68a40046c6cca2ed1c) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes admin browser tabs to show the current page and Site Title, falling back to configured admin branding and then EmDash when Site Title is empty. Content editor tabs include the collection type and entry title and update during client-side navigation.

- [#4718](https://github.com/emdash-cms/emdash/pull/4718) [`c38a5d5`](https://github.com/emdash-cms/emdash/commit/c38a5d5af364fc7ae0f13a75b57754b7328e7168) Thanks [@danielmlr](https://github.com/danielmlr)! - Completes the German admin translations so German-speaking editors see localized text in the SMTP email settings, the blocks field and its block menu, the Buttons block, field and byline field settings, the site status and domain change settings, the content list's sort menu, comments, redirects, menus, widgets, sections, taxonomies, media folders, user invitations, publishing schedules, the personal sidebar layout settings, the Atmosphere sign-in, the editor's save status, the content type's date column, the dashboard's notice about scheduled content that wasn't published, and the browser tab titles.

- [#4545](https://github.com/emdash-cms/emdash/pull/4545) [`871cbfa`](https://github.com/emdash-cms/emdash/commit/871cbfa09b920e3906373ef2cf1d36284f89ba55) Thanks [@danielmlr](https://github.com/danielmlr)! - Completes the German admin translations so German-speaking editors see localized text in the forms plugin's digest, autoresponder and field condition settings, the dialogs for deleting a menu item or a widget, the content list's row actions, the redirect group filter and its empty results, the search engine verification settings, empty media folders, the welcome dialog and the hint under "Hide from navigation". The redirect search placeholder is shorter so it is no longer cut off.

- [#4535](https://github.com/emdash-cms/emdash/pull/4535) [`46e0a54`](https://github.com/emdash-cms/emdash/commit/46e0a544bbe7865558463a9562889ba0850a7da7) Thanks [@CacheMeOwside](https://github.com/CacheMeOwside)! - Adds missing Hindi admin translations and uses Hindi transliteration for authentication terminology.

- [#4308](https://github.com/emdash-cms/emdash/pull/4308) [`4df65eb`](https://github.com/emdash-cms/emdash/commit/4df65eba3e4dd2f990c92f65a4748117182949d5) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Updates `@cloudflare/kumo` to 2.15.0. These packages now require exactly `@cloudflare/kumo@2.15.0`, so sites and plugins that install Kumo themselves should upgrade to that version to match the admin's prebuilt styles. Update `emdash` and the Forms, Field Kit, AI Moderation and AI Search plugins together: their earlier releases require Kumo 2.6.0, and these plugin releases need an `emdash` release with this change. Updating only one side leaves Kumo 2.15 next to an admin built for 2.6.
  
  In the admin, Select menus now open below their field instead of over it, and text sized `text-base` or `text-lg` has a taller line (1.5), so labels and headings take slightly more height. Kumo's `DropdownMenu` now spaces item icons itself, so plugin admin pages should remove any margin classes such as `me-2` from the elements they pass as an item's `icon`.

- [#4213](https://github.com/emdash-cms/emdash/pull/4213) [`caca761`](https://github.com/emdash-cms/emdash/commit/caca7610831465967c5b84e3022fc4db43cac091) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Reduces CPU usage during image upload confirmation by generating placeholders from small browser thumbnails instead of decoding full-resolution originals. For browser-decodable images, the admin now sends thumbnails fitting a 64-pixel box with both signed and direct uploads, and the visual-editing toolbar sends one with every direct upload. This also enables blurhash and dominant-color placeholders for browser-decodable formats such as WebP and AVIF, which previously had none. New uploads and imports no longer generate placeholders for transparent images, including PNGs, so placeholder backgrounds do not show through transparent areas. Existing media keeps its stored placeholders. Image dimensions, upload validation, content hashing, and responsive image variants remain unchanged.
  
  Adds the `imagePlaceholders` configuration option, defaulting to `true` on every runtime, including Cloudflare Workers. This is one site-wide switch for every upload and import: setting it to `false` skips all blurhash and dominant-color generation, including from client thumbnails. WordPress imports, MCP uploads, plugin uploads, and custom clients without thumbnails still decode originals when placeholders are enabled, so sites with constrained CPU budgets may choose to turn this switch off.
  
  Custom clients can send an optional `{ thumbnail: { contentType, data } }` in `POST /_emdash/api/media/{id}/confirm`. Confirm thumbnails accept JPEG or PNG, at most 32,768 base64 characters and 4,096 decoded pixels. Unusable thumbnails omit the placeholder rather than falling back to decoding the original. Thumbnails also work when originals exceed the 8 MiB download cap; supply the original `width` and `height` to record dimensions in that case.

- [#4485](https://github.com/emdash-cms/emdash/pull/4485) [`faeca6c`](https://github.com/emdash-cms/emdash/commit/faeca6cf873ce792359aeadfe4699534eafb06ed) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes the content editor toolbar on mobile with a four-column action grid that keeps actions visible without horizontal scrolling. Removes the persistent visible Saved label and shows save failures in a dismissible banner beneath the header at all widths. Preserves screen-reader save announcements. On phones, Settings offers **Save draft** for collections with drafts and revisions. Tablet and desktop retain their horizontal action layout, and error toasts remain available when the header has scrolled out of view.

- [#4421](https://github.com/emdash-cms/emdash/pull/4421) [`2bd4a39`](https://github.com/emdash-cms/emdash/commit/2bd4a396c44284635e106f95a54d9e9a698ca218) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes the "not found" errors for themes, marketplace plugins, collections, revisions, and users, which stayed in English in an admin set to another language. They can now be translated like the rest of the admin.

- [#3913](https://github.com/emdash-cms/emdash/pull/3913) [`252934b`](https://github.com/emdash-cms/emdash/commit/252934b888453fd18a72f9311e75d1a0bdc109dc) Thanks [@edrpls](https://github.com/edrpls)! - Fixes failed uploads in the media library upload dialog and the media picker showing only "Upload failed". The server's reason, such as a file over the size limit, now appears under the file, as it already does when uploading into an empty image field.

- [#4454](https://github.com/emdash-cms/emdash/pull/4454) [`5a9f1bd`](https://github.com/emdash-cms/emdash/commit/5a9f1bdef6ab92a2c286264aba98eab94bc19b36) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes deleting a menu item on SQLite, libSQL, and Cloudflare D1 so the items nested under it are deleted too, as they already were on PostgreSQL. Before, the nested items stayed behind: the site showed them as top-level menu items, but the menu editor no longer listed them, so they could not be edited or removed.
  
  When a menu item has nested items, the menu editor's delete confirmation now says they will be deleted too.
  
  Upgrading moves every menu item whose parent is missing from its menu to the top level, where the site already shows it, so the menu editor lists it again.
  
  #### What should I do?
  
  After upgrading, review your menus in the admin. Items left behind by an earlier delete now appear at the top level, where your site was already showing them. Delete any you no longer want.

- [#4491](https://github.com/emdash-cms/emdash/pull/4491) [`6331f6b`](https://github.com/emdash-cms/emdash/commit/6331f6b4ba2c9f9d6eac778c2ee311e9cbd79768) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes uploads into image and file fields inside blocks ignoring the nested field's `allowedMimeTypes`. Allowed Word documents and other types outside the default upload list can now be uploaded directly from a block's media picker.
  
  API clients uploading into a block field can send `blockType` (the block type slug) and `blockVersion` (the block's version number) with the composite `fieldId` (`<outerFieldId>:<blockKey>:<fieldSlug>`) to `POST /_emdash/api/media` or `POST /_emdash/api/media/upload-url`. Use the database ID of the collection's blocks field for `outerFieldId`, and send `blockVersion` as a string in multipart requests or a number in upload-URL JSON requests. Without the block context, the default upload allowlist still applies.

- [#4720](https://github.com/emdash-cms/emdash/pull/4720) [`935cdc7`](https://github.com/emdash-cms/emdash/commit/935cdc7f956302da25105aafac9f35897a6b07fa) Thanks [@danielmlr](https://github.com/danielmlr)! - Updates the SMTP Host placeholder in Settings → Email to `smtp.example.com`, so the form no longer suggests a particular email provider.

- [#4235](https://github.com/emdash-cms/emdash/pull/4235) [`d6c56fc`](https://github.com/emdash-cms/emdash/commit/d6c56fcd98137b6e3d967ee7a374b6d6c46be502) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes Croatian (`hr`), Russian (`ru`) and Serbian Latin (`sr-Latn`) admin messages that described counts such as 21 or 101 as a single item. In Croatian, for example, screen readers now announce "Izbrisan 21 redak" after 21 table rows are deleted, instead of "Redak izbrisan" (row deleted).

- [#4708](https://github.com/emdash-cms/emdash/pull/4708) [`752cbcd`](https://github.com/emdash-cms/emdash/commit/752cbcd4311bf12f394045dc75b9144b2b688aa4) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes site transfer imports failing with `TRANSFER_TARGET_NOT_EMPTY` after an interruption while removing starter collections created during setup. Resuming the import now continues that cleanup instead of treating the collection as existing content.
  
  **Settings → Transfer** now identifies collections whose deletion failed and explains how to retry them before importing. Deletions that are still in progress do not block a new import; the importer advances their cleanup.
  
  #### What should I do?
  
  If your import was interrupted, reopen **Settings → Transfer** to continue it, or run `emdash site import resume <operation-id>`. If the import or a collection deletion failed, follow the guide's [retry and recovery steps](https://docs.emdashcms.com/guides/site-transfer/#resolve-failed-collection-cleanup) before starting another import.

- [#4742](https://github.com/emdash-cms/emdash/pull/4742) [`b8886d9`](https://github.com/emdash-cms/emdash/commit/b8886d9476b922990ee1d50abb73facbbf2d131d) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes WXR imports publishing password-protected WordPress posts for anyone to read on the imported site. The admin import and `emdash import wordpress` now bring in a post with a WordPress password as a draft, whatever its WordPress status, and list each one on the **Import Complete** screen and in the CLI output.
  
  Imports through the EmDash Exporter plugin are unchanged: the exporter does not send post passwords, so a published, password-protected post still arrives published.
  
  #### What should I do?
  
  If you imported a WXR file before this release, or import through the EmDash Exporter, find the entries that WordPress marks as "Password protected" on its **Posts**, **Pages** and custom post type screens, and unpublish them in EmDash if they should stay private.

- [#4291](https://github.com/emdash-cms/emdash/pull/4291) [`40c7657`](https://github.com/emdash-cms/emdash/commit/40c76576d82a0e7714ac99869971c3ae85f4fcfa) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes the Revisions and Outline sections and the "Created and updated" dates in the content editor sidebar ignoring the reduced-motion preference when they expand or collapse.

- [#4413](https://github.com/emdash-cms/emdash/pull/4413) [`88e00fe`](https://github.com/emdash-cms/emdash/commit/88e00fedb114e3e98cd32d7b4889bfba3ae3c6c4) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes sandboxed content editor panels giving no feedback during slow button actions or form submissions. Panels keep their controls visible and show a pending indicator while interactions run. Additional interactions run in order instead of cancelling the active request, and consecutive duplicates of a running or queued interaction are ignored. Editing the entry allows a new draft-aware action even while the same button’s earlier request is pending. Saved-version refreshes run in the background without replacing the panel with a skeleton, and superseded loads are cancelled so the latest refresh can start promptly.

- [#4481](https://github.com/emdash-cms/emdash/pull/4481) [`5652829`](https://github.com/emdash-cms/emdash/commit/5652829bd13e8a66583fcbf4ecbe1d1cd390de70) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes saved redirect groups being hidden in the admin Redirects list. Editors can now see each redirect's group and filter by an exact group name, including groups outside the currently loaded page.

- [#4385](https://github.com/emdash-cms/emdash/pull/4385) [`830578b`](https://github.com/emdash-cms/emdash/commit/830578be2ebf1c3192270978d38ade54583ea870) Thanks [@Stormster](https://github.com/Stormster)! - Fixes required file, image and reference fields in the content editor showing "This field is required" (or "Select at least one entry.") as soon as the form opens. The message now appears after the editor tries to save or publish, or when they empty a field they had filled, and is announced to screen readers and linked to the field's button.

- [#4479](https://github.com/emdash-cms/emdash/pull/4479) [`d4d149d`](https://github.com/emdash-cms/emdash/commit/d4d149d08c4d2aa4f18b5bbd8d15d496d6a69a76) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes saving content when an optional select or URL sub-field in a repeater row is left empty or cleared. The save failed with "… has a value that is not one of its options." or "… must be a valid URL."
  
  #### What should I do?
  
  An entry with a repeater row that was saved empty before this release can still fail with these messages. Fill in that sub-field, or fill it in and clear it again, then save.

- [#4625](https://github.com/emdash-cms/emdash/pull/4625) [`5bcccb8`](https://github.com/emdash-cms/emdash/commit/5bcccb82465011d9229334bbb566984e9d5ed446) Thanks [@swissky](https://github.com/swissky)! - Fixes Select sub-fields in the repeater field dialog: you can now enter their choices (one per line) when you create or edit a repeater, and saving a repeater no longer erases the choices of Select sub-fields defined through the API, the CLI or seed files.

- [#4263](https://github.com/emdash-cms/emdash/pull/4263) [`d3e3021`](https://github.com/emdash-cms/emdash/commit/d3e3021c6db69ba0eb08593df4fd2353f3b858c1) Thanks [@henshaw](https://github.com/henshaw)! - Fixes the content editor's and publishing calendar's **Preview** buttons opening a new browser tab on every click. Previewing an entry again now reloads and brings forward its preview tab when that tab is still open; previews of different entries keep their own tabs.

- [#4418](https://github.com/emdash-cms/emdash/pull/4418) [`34fc9e0`](https://github.com/emdash-cms/emdash/commit/34fc9e0781e0254e6aa950fdda50ea0b7338616e) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes the content editor saving outdated rich text over newer content. When the editor picked up a newer version of an entry, for example after a save from another tab, a plugin, or the API, rich text fields and rich text inside blocks kept the old text, and the next keystroke saved it over the newer version without a conflict notice. Discard changes left the discarded text in place the same way. A read that finished after an autosave could also undo it, so a later edit saved the earlier text.
  
  Rich text typed while a save is in progress counts as unsaved and goes out with the next save, which shows the conflict notice if the entry changed elsewhere in the meantime.

- [#4695](https://github.com/emdash-cms/emdash/pull/4695) [`22b87ed`](https://github.com/emdash-cms/emdash/commit/22b87edc3f68ef173683a698af49275c5201d5fe) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes read-only rich text fields so screen readers announce them as read-only instead of as editable text boxes.

- [#4485](https://github.com/emdash-cms/emdash/pull/4485) [`faeca6c`](https://github.com/emdash-cms/emdash/commit/faeca6cf873ce792359aeadfe4699534eafb06ed) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes title and other collection-data edits being reverted when a manual save's refresh finishes. Newly edited collection data is retained while untouched collection fields receive refreshed server values.

- [#4640](https://github.com/emdash-cms/emdash/pull/4640) [`8b484aa`](https://github.com/emdash-cms/emdash/commit/8b484aa92e0dc7c644563eb79e7635293c9d0e2d) Thanks [@swissky](https://github.com/swissky)! - Makes the first save of a new entry clearer in collections with drafts. The content editor labels the button **Save draft**, keeps that label visible in narrow editor bars, and the settings sidebar now shows the Publish section with a note that the entry stays off the site until it is published after the first save.

- [#4585](https://github.com/emdash-cms/emdash/pull/4585) [`372bafa`](https://github.com/emdash-cms/emdash/commit/372bafaeb75148997edff09b9312e722a80534e4) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes the calendar in the scheduling and publication date dialogs (Schedule publication, Schedule changes, Change schedule, and Change publication date) so each day sits centred under its weekday name. The days used to sit at the start of their columns, out of line with the weekday names above them.

- [#4782](https://github.com/emdash-cms/emdash/pull/4782) [`9db2de8`](https://github.com/emdash-cms/emdash/commit/9db2de8db3cf896d350eabdc91de663b481cbda3) Thanks [@eisenbruch](https://github.com/eisenbruch)! - Fixes a scheduled entry that publishing refuses staying overdue forever. When the scheduler's publish fails with a validation error or a slug conflict, the entry is now unscheduled and the dashboard lists it with the error message, as it already does when a plugin rejects a scheduled publish. Before, the error went only to the server log, the scheduler retried it on every run, and the calendar said scheduled publishing might not be running.
  
  `ScheduledPolicyRejection.pluginId` is now optional, and the record gains an optional `code`: a record written for a refused publish has no `pluginId` and carries the publish error's `code` instead. Code that reads `emdash:scheduled-policy-rejection:*` records, or narrows with `isScheduledPolicyRejection`, should handle a missing `pluginId`.

- [#4534](https://github.com/emdash-cms/emdash/pull/4534) [`532e78b`](https://github.com/emdash-cms/emdash/commit/532e78bc3604b43cf9f51c3ed6e586f2f9d6ed68) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes the default SEO title ignoring a collection's `titleField`. When an entry's SEO title is empty, `getSeoMeta()` now takes the page title from the collection's title field for entries from `getEmDashEntry()` and `resolveEmDashPath()`, and falls back to the `title` field when the collection sets no `titleField` or the entry leaves that field empty. The **SEO Title** placeholder in the editor shows the same value. Before, both read only the `title` field, so a collection that keeps its titles in a `headline` field got an empty page title.
  
  #### What should I do?
  
  If a collection's `titleField` names a field other than `title` and the collection also has a `title` field, its pages now take their title from the `titleField` value. To keep using the `title` field, pass it as the default title:
  
  ```ts
  const seo = getSeoMeta(post, { defaultTitle: post.data.title });
  ```

- [#4717](https://github.com/emdash-cms/emdash/pull/4717) [`089716d`](https://github.com/emdash-cms/emdash/commit/089716d3ff85785c5d81e7fd6aee45547dbe1893) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes non-admin users being able to open admin-only screens in the admin UI. A non-admin who opens a site-level settings page, **Users**, **WordPress import**, or a plugin's settings page by its URL now sees an "Access denied" message instead of a screen that fails to load or cannot save. The **Settings** screen stays open to every role and lists only the pages that role can use.
  
  #### Changes for Editors
  
  Editors could previously open **Settings → General**, **Social Links**, and **SEO** and read their values, although saving them already required an administrator. They can no longer open these pages.

- [#4558](https://github.com/emdash-cms/emdash/pull/4558) [`c0930c3`](https://github.com/emdash-cms/emdash/commit/c0930c335f35678a2bb75371ca041765a4e600b7) Thanks [@Yusaku01](https://github.com/Yusaku01)! - Completes the Japanese admin translation catalog, including form settings, dialog descriptions and validation messages, content management actions, and redirect controls.

- [#3008](https://github.com/emdash-cms/emdash/pull/3008) [`a3fc555`](https://github.com/emdash-cms/emdash/commit/a3fc555ef0eedf0e562abb7b1a3885c21f353d54) Thanks [@marks-zyz](https://github.com/marks-zyz)! - Fixes the sidebar active state for a plugin admin page declared with `path: "/"`. The nav target for such a page carries a trailing slash (`/plugins/<id>/`) while the router navigates without it, so the exact comparison in `isItemActive` never matched and the item stayed unhighlighted. This affected the shipped forms plugin's "Forms" page. Both sides are now normalized before comparing, and the admin root keeps its exact match.

- [#4510](https://github.com/emdash-cms/emdash/pull/4510) [`1cf644e`](https://github.com/emdash-cms/emdash/commit/1cf644ef37a5dfb8d5c471d8e42b77ed90bb9ffc) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Replaces the Change domain error "does not serve this site yet" with "Could not verify that … serves this site" when the server cannot verify a domain, including Cloudflare Workers Custom Domains. The dialog now explains that a Worker may be unable to reach its own domain and asks you to confirm the new address shows your site in a browser before using it without the check.

- [#4632](https://github.com/emdash-cms/emdash/pull/4632) [`96945d3`](https://github.com/emdash-cms/emdash/commit/96945d3ec0d7bfe6cb887171648029121ef94451) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes rich text block keys changing on every save. Blocks added in the editor now keep the same `_key` from save to save, so saving the same content twice gives identical Portable Text. Saving also stops changing a few stored shapes:
  
  - List items that start at a nested level keep their level.
  - Line breaks inside table cells keep their spans.
  - A span marked both subscript and superscript keeps subscript.
  - Two links that share a mark definition keep their own destinations.
  - An empty last line, such as the one the editor adds after a final image, isn't saved.
  
  If a plugin block is deleted while its edit dialog is open, the dialog now stays open, keeps what you typed, and says the changes can't be saved. Before, it closed and dropped the input.

- [#4752](https://github.com/emdash-cms/emdash/pull/4752) [`a5223a9`](https://github.com/emdash-cms/emdash/commit/a5223a96122c4676650c464935b728e25b3d1480) Thanks [@kegren](https://github.com/kegren)! - Translates the Swedish admin strings added since 1.2, including the revision history, email settings, block fields, site visibility and the forms plugin.

- [#4401](https://github.com/emdash-cms/emdash/pull/4401) [`e21e01e`](https://github.com/emdash-cms/emdash/commit/e21e01e5eb3b57de6a8c6c4531ca5fe184985114) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes responsive table widths in the admin editor with Tiptap 3.32.0. Gives both editors' textboxes accessible names for screen readers.
  
  Pins the editor's Tiptap dependencies to exactly 3.32.0 so installations use the version covered by the editor tests. Code-block highlighting keeps its existing lowlight extension version. Sites or plugins that share Tiptap dependencies with EmDash should align them to 3.32.0 to avoid installing multiple copies.
  
  Links applied at an empty caret now end when you type a space, following Tiptap's updated behavior. In the visual editor, typing a space at the end of an existing link also ends the link. Text typed after that space is not part of the link.

- [#4600](https://github.com/emdash-cms/emdash/pull/4600) [`eefe351`](https://github.com/emdash-cms/emdash/commit/eefe351616cddda020eae4a8b445a6606cf5a17b) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes the entry editor's taxonomy picker showing an enabled create button with no name entered. The picker now explains that the input can search or create terms, disables creation for an empty name, and shows a hint to type a name first.

- [#4379](https://github.com/emdash-cms/emdash/pull/4379) [`65b1679`](https://github.com/emdash-cms/emdash/commit/65b1679a84a5af6dcc2e951a5064a21e2353c843) Thanks [@Yusaku01](https://github.com/Yusaku01)! - Fixes category and tag pickers creating or selecting terms when Enter confirms an IME composition.

- [#4533](https://github.com/emdash-cms/emdash/pull/4533) [`bb15813`](https://github.com/emdash-cms/emdash/commit/bb158132b8a8b0b9fc863ccc72bbb931618a888f) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes the `rows` widget option on `text` fields having no effect in the content editor. A text field that sets `options.rows` to a positive whole number now renders a textarea with that many rows, so fields that already set it change height after upgrading. Text fields without the option keep the 10-row default.

- [#4776](https://github.com/emdash-cms/emdash/pull/4776) [`98d16d8`](https://github.com/emdash-cms/emdash/commit/98d16d874341c10512c1b5e9d573d2b5ee3da50e) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes the content editor silently overwriting another editor's changes after a background refresh followed by undoing unsaved edits. The next save now reports a conflict instead of sending older field values with the newer revision token.

- [#4759](https://github.com/emdash-cms/emdash/pull/4759) [`93ad617`](https://github.com/emdash-cms/emdash/commit/93ad617386836c029eeb5dd5a83f9ba5b2ea7bf2) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes the content editor's Publish now, Publish changes, and Unpublish buttons to show a spinner and stay disabled while the request is in progress.

- [#4613](https://github.com/emdash-cms/emdash/pull/4613) [`a3da98d`](https://github.com/emdash-cms/emdash/commit/a3da98dd10ad3b374db536e0b2a1b94ca8bce41e) Thanks [@dmythro](https://github.com/dmythro)! - Completes the Ukrainian admin translation, so Ukrainian-speaking editors see every admin screen in Ukrainian. Existing Ukrainian texts that left "passkey", "magic link" or "handle" in English, or had grammar and wording mistakes, are corrected.

- [#4666](https://github.com/emdash-cms/emdash/pull/4666) [`652d957`](https://github.com/emdash-cms/emdash/commit/652d9571e1f05e5bd5a997373a53ee317779b977) Thanks [@dmythro](https://github.com/dmythro)! - Fixes WordPress export file (WXR) imports leaving out menus. The admin said the WXR path imports menus, but the import created none, and the review screen didn't list them. The review screen now lists a file's menus by their names in WordPress, with the switch that exporter imports already have, and the import creates them with their nesting and with links to the imported pages and posts. An item without its own label shows the linked entry's title, as in WordPress. On a site translated with Polylang or WPML, each menu takes the language of the pages it links to. An item that links to a post type archive links to the archive of the collection that the post type was imported into. Items that link to a category or tag archive, to content the import left out, or to one of several pages that share a slug in the same collection and language are skipped and counted in the import result. So is a Polylang language switcher, which only Polylang can turn into language links. A menu that already exists under the same name and language is left as it is.
- Updated dependencies [[`76f0f53`](https://github.com/emdash-cms/emdash/commit/76f0f53221c380cc77b73da5e455408dca720902), [`7d48e95`](https://github.com/emdash-cms/emdash/commit/7d48e95c8b3b0d5f53a48ebbe5ee9f005035c610), [`4df65eb`](https://github.com/emdash-cms/emdash/commit/4df65eba3e4dd2f990c92f65a4748117182949d5), [`4e95f4f`](https://github.com/emdash-cms/emdash/commit/4e95f4f23d9efe288b255d5f94963f8f97dac27a), [`34ff31a`](https://github.com/emdash-cms/emdash/commit/34ff31af2aa096d948ed5657cc409b679df393a9)]:
  - @emdash-cms/blocks@1.5.0
  - @emdash-cms/plugin-types@0.6.1
  - @emdash-cms/registry-lexicons@0.7.1
  - @emdash-cms/registry-client@0.7.2

## 1.4.0

### Minor Changes

- [#3856](https://github.com/emdash-cms/emdash/pull/3856) [`064fbbf`](https://github.com/emdash-cms/emdash/commit/064fbbfe00a9f3b8c2fdea8b0b1abec43e785505) Thanks [@swissky](https://github.com/swissky)! - Adds `admin.hiddenNavItems` to hide built-in admin areas a site doesn't use. Set it to any of `calendar`, `media`, `comments`, `menus`, `redirects`, `widgets`, `sections`, `bylines`, and `import`, for example `admin: { hiddenNavItems: ["comments", "redirects"] }`. Hidden areas disappear from the sidebar and the command palette. On the dashboard, listing `media` hides the Upload Media button, and listing `calendar` keeps the Scheduled count but removes its link to the calendar. The pages and API routes stay reachable for users with the required role. An unknown name fails the build.

### Patch Changes

- [#4446](https://github.com/emdash-cms/emdash/pull/4446) [`6cc69bb`](https://github.com/emdash-cms/emdash/commit/6cc69bbdb06a7a31f3fea4f13096e25005840d71) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Moves the buttons at the end of each content list row into one "…" menu. On the All tab, the menu has Edit and Move to trash, plus View published for published entries and Duplicate for entries you can duplicate. On the Trash tab, it has Restore and Delete permanently. Clicking an entry's title still opens it for editing.
  
  The All and Trash tables also have a new look, with column headers on a tinted band above the rows.
  
  Fixes the Move to trash and Delete permanently confirmations staying open after you confirm. They now close right away, including when the action fails, and a toast reports the error.
  
  Browser tests that clicked a row's own buttons, such as "Edit My post", now need to open the "Actions for My post" menu first.

- [#4303](https://github.com/emdash-cms/emdash/pull/4303) [`3fcf437`](https://github.com/emdash-cms/emdash/commit/3fcf4377334a44f86f8f3289baf73c55b370fef0) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes failure toasts in the admin rendering in the neutral style instead of the error style. Success and warning toasts that set a style now show it too. Toasts returned by plugin editor panels and actions use the success, error, or info style named by their `type`.

- [#4435](https://github.com/emdash-cms/emdash/pull/4435) [`f0956f1`](https://github.com/emdash-cms/emdash/commit/f0956f1f050306442e2d801e0abaff229815a19b) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes the plugin count on the Plugins page reading "1 plugins" when one plugin is installed. Renames the "Google Verification / Bing Verification" section in SEO settings to "Search Engine Verification", so other languages can translate the title as one phrase instead of two labels joined by a slash.

- [#4299](https://github.com/emdash-cms/emdash/pull/4299) [`500a45b`](https://github.com/emdash-cms/emdash/commit/500a45b4cd872401d809187cc5f3f9082b9717ab) Thanks [@MA2153](https://github.com/MA2153)! - Fixes slugs, URLs, paths, URL patterns, regex patterns, emails, and other left-to-right values displaying in the wrong order when the admin uses a right-to-left language such as Arabic. For example, the URL pattern `/blog/{slug}` displayed as `blog/{slug}/`, and the regex `^[a-z0-9-]+$` as `$+[-a-z0-9]^`. These fields and their read-only displays, such as the redirects table, now always read left to right, while the surrounding labels and table layout stay right-to-left.

- [#4433](https://github.com/emdash-cms/emdash/pull/4433) [`2a62e8a`](https://github.com/emdash-cms/emdash/commit/2a62e8afb5b1661e6f6f00403076ac1339b8c980) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes admin URLs that don't exist, such as `/_emdash/admin/does-not-exist`, showing signed-in users a bare, unstyled "Not Found" line with no sidebar and no way back. Signed-in users now see the admin's "Page Not Found" page inside the admin layout at any unknown admin URL, with a link to the dashboard. The "Collection not found" message for an unknown collection is now translated.

- [#4368](https://github.com/emdash-cms/emdash/pull/4368) [`5cd334e`](https://github.com/emdash-cms/emdash/commit/5cd334ed92d7ef9cefa64e8665f53350fba0f187) Thanks [@eisenbruch](https://github.com/eisenbruch)! - Fixes the cursor jumping to the end of an image or video caption while typing anywhere but the end.

- [#4037](https://github.com/emdash-cms/emdash/pull/4037) [`b82016d`](https://github.com/emdash-cms/emdash/commit/b82016d5b9f051b77689585ed0504b77e1929db4) Thanks [@marks-zyz](https://github.com/marks-zyz)! - Translates 1,170 admin strings that fell back to English for Brazilian Portuguese (`pt-BR`) admins, including the publishing calendar, site transfer, relations between content types, editor tables and HTML blocks, passkey setup, the Change domain dialog, the plugin registry, and the invite, sign-in, and domain-change emails. Plugin release strings now consistently use “versão” for release.

- [#4124](https://github.com/emdash-cms/emdash/pull/4124) [`0bc006c`](https://github.com/emdash-cms/emdash/commit/0bc006c8a2e3fb0f55ec587c997101eb0f87eb02) Thanks [@otscup](https://github.com/otscup)! - Completes the Simplified Chinese (`zh-CN`) admin translation. Chinese-speaking admins now see localized text across the whole admin UI, including the editor, media library, publishing calendar, settings, plugin registry, and authentication flows. Previously, roughly half of the admin strings fell back to English.

- [#4434](https://github.com/emdash-cms/emdash/pull/4434) [`d840b08`](https://github.com/emdash-cms/emdash/commit/d840b087244bd3e79caa2ee0266ad3942ac677b7) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes the trash buttons on menu items and widgets deleting immediately on one click. The admin now asks for confirmation first, as it already does for whole menus and widget areas, and keeps the confirmation open with the error if the delete fails.

- [#4096](https://github.com/emdash-cms/emdash/pull/4096) [`a1a0174`](https://github.com/emdash-cms/emdash/commit/a1a0174f99ad4ca301e823bdea92b2a5f21e93c4) Thanks [@masonjames](https://github.com/masonjames)! - Fixes the dashboard's Content card listing collections that are hidden from navigation. The card now matches the sidebar and the quick actions; hidden collections still count toward the dashboard totals, still appear in Recent Activity, and stay reachable by URL, API, and plugins.

- [#3571](https://github.com/emdash-cms/emdash/pull/3571) [`a6b28a6`](https://github.com/emdash-cms/emdash/commit/a6b28a6b1bf96f9ade9cc5c0327cd5b2e5af1ca2) Thanks [@logelog](https://github.com/logelog)! - Updates Dutch admin translations for content editing, revision history and restoration, scheduled publishing, domain changes, menus, visual editing, and passkey setup.

- [#4298](https://github.com/emdash-cms/emdash/pull/4298) [`e80c1f0`](https://github.com/emdash-cms/emdash/commit/e80c1f07f5baf7c6d26e6ef70cbbdf22a330e009) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes recent edits to an entry being overwritten with an older copy when you switch to another entry and back while their autosave is still on its way. The autosaved edits are now kept unless you edit the older copy the editor brought back.

- [#4160](https://github.com/emdash-cms/emdash/pull/4160) [`936a4cb`](https://github.com/emdash-cms/emdash/commit/936a4cb79ab24866cee3f669b9abe0daa5e70359) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes uneven spacing between blocks in the rich text editor. Quotes keep the same space from the text around them as code blocks, images and tables, a heading sits close to the image, code block, table or embed it introduces, and a divider sits midway between a paragraph and the heading after it. In sections, widgets, and every rich text field other than an entry's main content, a heading also gets clearly more space above it than paragraphs have between them, and quotes, code blocks, images, tables and embeds all keep the same space around them.

- [#4160](https://github.com/emdash-cms/emdash/pull/4160) [`936a4cb`](https://github.com/emdash-cms/emdash/commit/936a4cb79ab24866cee3f669b9abe0daa5e70359) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes images and videos in the rich text editor showing an empty caption line, which left more space below them than above. A caption field shows only while the block has a caption or you are writing one. To add one, select **Add caption** in the image toolbar or among a video's corner buttons, or move to the caption with Tab from the selected block.

- [#4160](https://github.com/emdash-cms/emdash/pull/4160) [`936a4cb`](https://github.com/emdash-cms/emdash/commit/936a4cb79ab24866cee3f669b9abe0daa5e70359) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes a quote of several paragraphs reopening as one quote per paragraph. After an entry is saved and reopened, the quote is one block again, so its drag handle, block menu and selection cover the whole quote. The saved content is unchanged.

- [#4298](https://github.com/emdash-cms/emdash/pull/4298) [`e80c1f0`](https://github.com/emdash-cms/emdash/commit/e80c1f07f5baf7c6d26e6ef70cbbdf22a330e009) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes recent edits to an existing entry being lost when you leave the content editor right after typing. Following a link to another admin page now sends those edits before leaving, and the next page shows "Autosave failed" if they don't go through. When the edits can't be sent, for example after a conflict, the editor asks before leaving. Reloading or closing the tab before they are saved shows the browser's prompt.

- [#4355](https://github.com/emdash-cms/emdash/pull/4355) [`9e720d6`](https://github.com/emdash-cms/emdash/commit/9e720d686c9d0ea651b1be044197d00d0e95d185) Thanks [@danielmlr](https://github.com/danielmlr)! - Completes the German admin translations so German-speaking editors see localized text in the leave-without-saving dialog, the date and time errors when scheduling an entry or changing its publication date, the read-only notice for roles that can't edit an entry, the caption buttons on images and videos, and the notice that asks for an image URL on the social sharing image. That field is now called „Bild für soziale Medien“ instead of „OG-Bild“, matching the site's SEO settings.

- [#4210](https://github.com/emdash-cms/emdash/pull/4210) [`2ed2755`](https://github.com/emdash-cms/emdash/commit/2ed27550881c89603a45f6e2212e62209c5a7ac9) Thanks [@danielmlr](https://github.com/danielmlr)! - Completes the German admin translations so German-speaking editors see localized text in the version history, including the change list, version view, and restore dialog, as well as menu renaming and CSS classes on menu links, the AI-training setting in SEO, byline form errors, the WordPress import's bot-protection error, and scheduling labels. Themes are now called "Theme" throughout instead of "Design".

- [#4388](https://github.com/emdash-cms/emdash/pull/4388) [`229c64b`](https://github.com/emdash-cms/emdash/commit/229c64ba737fcb6e4e2db9a3da4b8975f01d29bb) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes repeated "Uncompiled message detected!" console warnings in production for untranslated plugin content-list column labels, editor panel titles, and sandboxed editor action labels.

- [#3867](https://github.com/emdash-cms/emdash/pull/3867) [`d60c43c`](https://github.com/emdash-cms/emdash/commit/d60c43c5bafa16699eeafd6a6329d3f9927f85f6) Thanks [@masonjames](https://github.com/masonjames)! - Fixes admin body colors and mobile dialog width limits overriding public themes when the admin stylesheet is loaded on a public page.

- [#4354](https://github.com/emdash-cms/emdash/pull/4354) [`dd0bc9e`](https://github.com/emdash-cms/emdash/commit/dd0bc9eb04fab475253e375d116e533b81efb87e) Thanks [@CacheMeOwside](https://github.com/CacheMeOwside)! - Adds some missing Hindi translations for revision history, editor controls, settings, and error messages. Updates Hindi failure messages to use “असफल” instead of “विफल”.

- [#4185](https://github.com/emdash-cms/emdash/pull/4185) [`4e4b068`](https://github.com/emdash-cms/emdash/commit/4e4b06829225b27df0224b584f8ccc517de5fd5c) Thanks [@masonjames](https://github.com/masonjames)! - Fixes content editor plugin panels ignoring the reduced-motion preference for height transitions.

- [#4356](https://github.com/emdash-cms/emdash/pull/4356) [`0bc23ad`](https://github.com/emdash-cms/emdash/commit/0bc23ad0f0e073eab3d6ce16decce49c815364d4) Thanks [@Zahid09987](https://github.com/Zahid09987)! - Updates Indonesian admin translations for newly added publishing date/time, SEO image, and sharing-related strings.

- [#4382](https://github.com/emdash-cms/emdash/pull/4382) [`7a04c81`](https://github.com/emdash-cms/emdash/commit/7a04c81372d5ab1f3cdb420a19cd2d857a57e56d) Thanks [@Yusaku01](https://github.com/Yusaku01)! - Adds Japanese translations for site transfers, passkey setup and access controls, site settings, plugin verification and permissions, menus, taxonomies, sections, and remaining admin messages.

- [#4260](https://github.com/emdash-cms/emdash/pull/4260) [`046ec3c`](https://github.com/emdash-cms/emdash/commit/046ec3c9cef712fceefbd6576734d15ecaee4a12) Thanks [@Yusaku01](https://github.com/Yusaku01)! - Adds missing Japanese translations for publishing, version history, editor controls, bulk taxonomy assignment, byline profiles, content type settings, relationships, and reusable blocks in the admin UI.

- [#4338](https://github.com/emdash-cms/emdash/pull/4338) [`15557d1`](https://github.com/emdash-cms/emdash/commit/15557d1ee7c41a8efb3906fc3b58e68086f8fb7d) Thanks [@Chiji1108](https://github.com/Chiji1108)! - Adds Japanese translations for the screens editors use most: the content editor and its publishing panel, the media picker and media details, sign-in, invite and magic-link emails, the setup wizard, and the visual editing toolbar.

- [#4452](https://github.com/emdash-cms/emdash/pull/4452) [`2e103a4`](https://github.com/emdash-cms/emdash/commit/2e103a45aa1b680318022c59e8cc0af0629c3ca3) Thanks [@urmshr](https://github.com/urmshr)! - Adds Japanese translations for menu item and widget deletion confirmations, welcome dialog titles that include a custom site name, the plugin count in the plugin manager, the "Collection not found" page, the search engine verification settings heading, and the "Hide from navigation" description in the content type editor.

- [#4427](https://github.com/emdash-cms/emdash/pull/4427) [`245a562`](https://github.com/emdash-cms/emdash/commit/245a5623ad1fbb30df2be4db4282d5229db7687e) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes admin term creation dialogs retaining the previous term's values when reopened after saving or cancelling.

- [#3130](https://github.com/emdash-cms/emdash/pull/3130) [`fa46578`](https://github.com/emdash-cms/emdash/commit/fa465787470aff612103213232992c9df3fdf00a) Thanks [@eisenbruch](https://github.com/eisenbruch)! - Fixes the admin console filling with "Uncompiled message detected!" warnings for plugin sidebar, command palette and dashboard widget labels that have no translation. A plugin label or widget title is now looked up in the catalog only when the catalog has it; one without a translation renders as declared, as before, without a warning on every render.

- [#4425](https://github.com/emdash-cms/emdash/pull/4425) [`585cd22`](https://github.com/emdash-cms/emdash/commit/585cd222e1279f7055b6559540f0b2285dee8abd) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes "Invalid input" errors when saving content with an optional datetime field left empty or cleared, including datetime sub-fields in newly added repeater rows.

- [#4307](https://github.com/emdash-cms/emdash/pull/4307) [`e847d4b`](https://github.com/emdash-cms/emdash/commit/e847d4b61902757a6d829058e7d6afc6c4d0691e) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes the Schedule button in the scheduling dialog appearing to do nothing when the date or time was missing or invalid. The dialog now explains what to change, and when nothing is scheduled yet it opens with the next whole hour (at least five minutes away) selected. Clearing the hour or minute and moving on puts back the last value. In both the scheduling and publication date dialogs, clicking the selected day no longer clears it, and the publication date dialog now shows its validation errors too. In right-to-left languages, the time fields now read hour then minute instead of appearing reversed.

- [#4315](https://github.com/emdash-cms/emdash/pull/4315) [`e6ee72f`](https://github.com/emdash-cms/emdash/commit/e6ee72f9e4301c1e5298a364fda9b8c1bf492f7e) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes the setup wizard and the first-login welcome dialog showing EmDash branding when `admin.logo` and `admin.siteName` are configured. The setup wizard now shows the configured logo, and the welcome dialog greets new users with the configured site name, for example "Welcome to Acme, Alice!".

- [#4386](https://github.com/emdash-cms/emdash/pull/4386) [`53acf71`](https://github.com/emdash-cms/emdash/commit/53acf7159f405786d484b35288f5effb6ffb81be) Thanks [@Stormster](https://github.com/Stormster)! - Fixes entry slugs being generated from a field named `title` instead of the collection's configured title field. In a collection whose `titleField` is `name` and which also has a `title` field (a person's job title, say), typing in the editor now fills the slug from the name, and entries created through the API without a slug get one from the name too, so two people with the same job title no longer collide with `SLUG_CONFLICT`. Collections without a `titleField` keep the previous `title`, then `name`, order.

- [#4314](https://github.com/emdash-cms/emdash/pull/4314) [`0709277`](https://github.com/emdash-cms/emdash/commit/070927753e19cfc5fd2bb9342947bb2b2a5185ac) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes the admin editor offering URL editing for unregistered blocks without an existing `id` or `url`, including WordPress-imported buttons. These blocks now show an unavailable-editor notice instead of saving an unrelated URL onto the block. Imported embeds and files with existing URLs remain editable. This does not add a Buttons editor or remove previously saved stray URLs. Blocks that already contain a stray `id` still offer URL editing; removing that `id` from the stored Portable Text block disables those controls.

- [#4302](https://github.com/emdash-cms/emdash/pull/4302) [`6094ff8`](https://github.com/emdash-cms/emdash/commit/6094ff8a9743ecfd5e86ec54b5273094736a8cea) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes the entry editor’s OG Image preview for seeded or imported SEO images stored as bare media IDs. The editor now shows the resolved image and warns that the saved ID may not work in shared links. Choose **Save image URL** to explicitly replace the ID with a working file URL for social previews and sitemap images; viewing the preview alone does not change the saved value. Relative media paths such as `uploads/og.png` also resolve correctly in the preview.

- [#4271](https://github.com/emdash-cms/emdash/pull/4271) [`d160cb0`](https://github.com/emdash-cms/emdash/commit/d160cb04e0060658fa56a8e4de4be024204b63e8) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes entry taxonomy assignments not refreshing after a plugin editor panel returns `refresh: true`, so later sidebar edits preserve terms the plugin added.

- [#4395](https://github.com/emdash-cms/emdash/pull/4395) [`20a5923`](https://github.com/emdash-cms/emdash/commit/20a5923a4073b1bab5442b86d42c2540ba5bd312) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes inserting a table from the editor toolbar at the end of a post, and the "List" and "Quote" hints on empty list items and quotes, when `@tiptap/extensions` 3.27.3 or later is installed.

- [#4396](https://github.com/emdash-cms/emdash/pull/4396) [`9201138`](https://github.com/emdash-cms/emdash/commit/92011387eb2fee065e54f7d4b2c20405d1a3e347) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes keyboard navigation and entrance animations in the admin and visual editor's floating toolbars with Tiptap 3.20.3 and later. Escape closes image alt-text editing, Shift+Tab returns to the caption, and arrow keys move between toolbar controls again.

- [#3572](https://github.com/emdash-cms/emdash/pull/3572) [`26c4faf`](https://github.com/emdash-cms/emdash/commit/26c4faff448a98c33f0af2e369c1fe822d882e17) Thanks [@logelog](https://github.com/logelog)! - Translates the remaining Turkish admin text, including the publishing calendar, version history, domain changes, HTML and video blocks, and sign-in emails. Renames the capability, caption and alt-text labels to "İzinler", "Resim yazısı" and "Alt metin". Labels the plugin registry "Eklenti kataloğu". Corrects the MIME type example, email validation message and resend countdown.

- [#4165](https://github.com/emdash-cms/emdash/pull/4165) [`3ad08dc`](https://github.com/emdash-cms/emdash/commit/3ad08dc041ab1ea728926a2267c55a27bc52e933) Thanks [@h3xexe](https://github.com/h3xexe)! - Fixes the first-login welcome dialog showing the EmDash icon on sites that set a custom `admin.logo`. The dialog now shows the configured logo, like the sidebar and login screens, and falls back to the EmDash icon when no logo is set.
- Updated dependencies [[`190022c`](https://github.com/emdash-cms/emdash/commit/190022cbd71a20d06c856cf5673acb0b2d2d9f1f)]:
  - @emdash-cms/blocks@1.4.0

## 1.3.1

### Patch Changes

- [#4177](https://github.com/emdash-cms/emdash/pull/4177) [`eba70bc`](https://github.com/emdash-cms/emdash/commit/eba70bc5f70d79592acba9aa17b598299f0ad23c) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes Contributors and Authors seeing Duplicate, Publish, Unpublish, and Schedule on entries where the server refuses them. An entry the user can't save now opens read-only, with a note saying why.

- [#4241](https://github.com/emdash-cms/emdash/pull/4241) [`1390d82`](https://github.com/emdash-cms/emdash/commit/1390d82b964021b5ebc757467f71a66d856ae3ae) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fixes the Title Separator field in Settings > SEO so its value can be cleared with Backspace and replaced without the previous fallback reappearing. The default separator is now shown as a placeholder.

- [#4181](https://github.com/emdash-cms/emdash/pull/4181) [`d33d0a5`](https://github.com/emdash-cms/emdash/commit/d33d0a50b40ca3b2f1f79069895f2917988ebb5c) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes the admin dashboard showing the number of users to roles that cannot list users. The Users card, and `userCount` in the `GET /_emdash/api/dashboard` response, are now limited to Administrators.

- [#4206](https://github.com/emdash-cms/emdash/pull/4206) [`6b168aa`](https://github.com/emdash-cms/emdash/commit/6b168aab35b1642d3ef72fc74018aa36b2050f65) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes a new, not yet saved entry being discarded without warning when you leave the editor. Following a link to another admin page now asks before leaving, and reloading or closing the tab shows the browser's prompt.

- [#4013](https://github.com/emdash-cms/emdash/pull/4013) [`03409e6`](https://github.com/emdash-cms/emdash/commit/03409e67ee01a949a8c3ddc4948e10ebbef4f9a7) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fixes the admin login page so the help text under a provider's `LoginForm` is no longer hard-coded to "Enter your handle to sign in." for every provider.
  
  Providers can now export an optional `loginHelp` string or component from their admin entry. When `loginHelp` is absent, the page falls back to a neutral "Continue with {label}." message.
  
  The built-in AT Protocol provider keeps its handle-specific prompt and translates it using the admin's active locale. It requires `@lingui/react` as a peer dependency; if your package manager does not install peers automatically, install a compatible Lingui 5 version alongside the provider.

- [#4264](https://github.com/emdash-cms/emdash/pull/4264) [`2940ab9`](https://github.com/emdash-cms/emdash/commit/2940ab9ddba8e3f56104ce49753a05f28e864bef) Thanks [@MarioCerulo](https://github.com/MarioCerulo)! - Adds Italian translations for the admin navigation, including the sidebar, navigation bar, and command palette. Italian remains unavailable in the language selector while translation coverage is still incomplete.

- [#4104](https://github.com/emdash-cms/emdash/pull/4104) [`66d0294`](https://github.com/emdash-cms/emdash/commit/66d029411fb53c660f8706030d782dd9b3b8d70d) Thanks [@CacheMeOwside](https://github.com/CacheMeOwside)! - Adds Hindi (`hi`) admin translations for deleting and editing media, folders, tags, table and block controls, domain changes, and error messages. Hindi strings now consistently use the transliterations "एरर" for error and "सोर्स" for source.

- [#4197](https://github.com/emdash-cms/emdash/pull/4197) [`a763760`](https://github.com/emdash-cms/emdash/commit/a7637608a591bcfc4b92c76145d75aa5e4edf792) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes accessible field names in Portable Text plugin block dialogs so screen readers announce text, number, select, and toggle labels, and identify media picker and repeater groups.

- [#4142](https://github.com/emdash-cms/emdash/pull/4142) [`68b954e`](https://github.com/emdash-cms/emdash/commit/68b954e651da818b53cdacc477ea6fd5ae8ad5cf) Thanks [@Zahid09987](https://github.com/Zahid09987)! - Adds missing Indonesian (`id`) translations for publishing-date labels, menu rename notices, menu CSS class hints, and scheduled-publication descriptions in the admin UI.

- [#4211](https://github.com/emdash-cms/emdash/pull/4211) [`fabbbb0`](https://github.com/emdash-cms/emdash/commit/fabbbb00713a52b84411be01b961402f0b1eaf14) Thanks [@Zahid09987](https://github.com/Zahid09987)! - Adds missing Indonesian (`id`) translations for revision history, version restore dialogs, AI crawler training rules, and WordPress import bot-protection notices in the admin UI.

- [#4257](https://github.com/emdash-cms/emdash/pull/4257) [`d2da24b`](https://github.com/emdash-cms/emdash/commit/d2da24b5ccbd2096cb00f4a8e0f3928d1aa7aaf2) Thanks [@Yusaku01](https://github.com/Yusaku01)! - Adds Japanese translations for the menu renaming dialog, success notification, and fallback update error.

- [#4230](https://github.com/emdash-cms/emdash/pull/4230) [`9310f50`](https://github.com/emdash-cms/emdash/commit/9310f505547eb9436c43937f26cef736c6370dde) Thanks [@Yusaku01](https://github.com/Yusaku01)! - Adds Japanese translations for relationship deletion warnings and error messages, including details of affected links and reference fields.

- [#4201](https://github.com/emdash-cms/emdash/pull/4201) [`185c709`](https://github.com/emdash-cms/emdash/commit/185c709c096f78f390da81279f1732929e67423a) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes captions being omitted from image field values and their generated TypeScript types. Image selection, content saves, and seed export/import preserve captions, including explicitly empty captions. Seed exports keep library defaults separately from per-use captions. Image and focal-point edits retain per-use captions unless the caption is explicitly edited. Templates should read the top-level `caption`; the legacy `meta.caption` alias stays consistent when present.
  
  For existing image fields whose captions were previously omitted, reselect the image or explicitly edit its caption, then save and publish the content entry. Upgrading alone does not fill captions into previously stored content values.

- [#3556](https://github.com/emdash-cms/emdash/pull/3556) [`7846c84`](https://github.com/emdash-cms/emdash/commit/7846c84b3686bec825d70e1f601f5735a6709e42) Thanks [@nesmachny](https://github.com/nesmachny)! - Adds Russian (Русский) translations for the admin UI. The locale is selectable from the language picker.

- [#4106](https://github.com/emdash-cms/emdash/pull/4106) [`a0b6610`](https://github.com/emdash-cms/emdash/commit/a0b661073ba5bcd22f8f59ddac43156b221d5766) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Stop forcing `blank: true` on every new text link.
  
  TipTap's Link extension defaults `HTMLAttributes.target` to `"_blank"`. Because both the admin rich-text editor and the inline visual editor configured Link with only styling classes, the default survived deep-merge, so every link created with `setLink()` was serialized as `blank: true` and rendered with `target="_blank" rel="noopener noreferrer"`. Both editors now set `target: null` in their Link `HTMLAttributes`, so newly saved text links no longer open in a new tab unless an author explicitly chooses that option (available only for image links today).
  
  Existing content that already has `blank: true` is unchanged and will continue to open in a new tab.

- [#4222](https://github.com/emdash-cms/emdash/pull/4222) [`34b218d`](https://github.com/emdash-cms/emdash/commit/34b218de2e6ef4073cc8fb7da07c9499fe562467) Thanks [@Yusaku01](https://github.com/Yusaku01)! - Adds Japanese translations for media deletion, image replacement, and cropping confirmation dialogs and their progress messages.
- Updated dependencies [[`9e74ea3`](https://github.com/emdash-cms/emdash/commit/9e74ea36b88509ba3e6b61f718aabe4dda26784a)]:
  - @emdash-cms/blocks@1.3.1
