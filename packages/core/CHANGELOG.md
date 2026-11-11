# emdash

<!-- emdash-changelog-archive: ./changelog/1.2.0-to-1.3.1.md -->

## 1.5.0

### Minor Changes

- [#4628](https://github.com/emdash-cms/emdash/pull/4628) [`1eedf99`](https://github.com/emdash-cms/emdash/commit/1eedf999dfc4bc119fc82f56b4d39165a46bd728) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Adds **Settings > Sidebars**, where each admin user hides and reorders entries in the admin navigation and sections in the content editor's settings sidebar. Every role can open it from the user menu. The layout is saved to the user's account, so it follows them to every browser, and it changes nobody else's sidebars.
  
  - Navigation entries move within their group or folder. Dashboard always stays first and visible. `admin.hiddenNavItems` still hides entries for everyone, and those entries don't appear on the page.
  - The editor sidebar order applies to every collection and to new entries. Publish can move but can't be hidden.
  - Reset restores a list's default and offers Undo.
  
  The editor settings sidebar no longer shows a drag handle on each section. A **Customize sidebar** link after the last section opens the new page, and a pencil at the bottom of the navigation does too. Section orders that the drag handles saved in a browser are not carried over, so every user starts from the default order.
  
  `GET /_emdash/api/auth/me` returns the stored layout as `adminLayout`, or `null`. `POST /_emdash/api/auth/me` accepts `{ "action": "setAdminLayout", "adminLayout": { ... } }` to replace it, or `"adminLayout": null` to remove it. A layout is limited to 200 IDs per list and 16 KB.
  
  Browser tests that used the editor sections' "Drag to reorder …" buttons need to change, because those buttons no longer exist. Byline reorder handles are unchanged.

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

- [#4641](https://github.com/emdash-cms/emdash/pull/4641) [`007f71c`](https://github.com/emdash-cms/emdash/commit/007f71c94461f5a592e3134f3935fa607d74169b) Thanks [@swissky](https://github.com/swissky)! - Adds type checking for `emdash()` options in `astro.config.mjs`. A value of the wrong type, such as `mcp: "yes"`, `maxUploadSize: "10MB"` or `toolbar: "always"`, now stops `astro dev`, `astro build` and `astro sync` with one error that lists each invalid option by its path, for example `→ at mcp`. Before, these values loaded without an error and failed later or were silently ignored. Adapter, plugin and provider descriptors are checked only for their outer shape, and `registry`, `migrations`, `middleware`, `admin.locales` and `admin.hiddenNavItems` keep their existing errors.
  
  An unrecognized top-level option still loads, but EmDash now logs a warning. When the name is close to a known option, the warning suggests it, so `sitUrl` points to `siteUrl`.
  
  #### What should I do?
  
  If the config fails to load after upgrading, fix each option named in the error, for example change `mcp: "true"` to `mcp: true`. The check can't be turned off. Configurations that match the documented option types are not affected.

- [#4730](https://github.com/emdash-cms/emdash/pull/4730) [`a17a4b3`](https://github.com/emdash-cms/emdash/commit/a17a4b34bd59f6a5074dd061642760113dadb3aa) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Adds support for `publishedAt`, `createdAt`, and `updatedAt` as a collection's `dateField`, so editors can see and sort by publication dates without duplicating system timestamps in a custom field. Choose **Date column source** in the existing content type's settings, or set `dateField` through the collection update API or a seed file.
  
  Collections without a configured `dateField` still show and sort by last-updated. Entries with a missing or invalid configured date display their last-updated date, while sorting uses the configured source.

- [#3307](https://github.com/emdash-cms/emdash/pull/3307) [`98e0924`](https://github.com/emdash-cms/emdash/commit/98e0924dfde61966730a7361d1b4296dd1a72bbe) Thanks [@swissky](https://github.com/swissky)! - Adds a `formats` prop to the `Image` component from `emdash/ui`, so sites can serve modern image formats with a fallback.
  
  List the formats in order of preference. With more than one entry, the component renders a `<picture>` element: the earlier entries become `<source>` elements and the last entry becomes the fallback `<img>`. Without `fallbackFormat`, a single entry renders one `<img>` in that format.
  
  ```astro
  <Image image={post.data.featured_image} width={1200} height={675} formats={["avif", "webp"]} />
  ```
  
  The optional `fallbackFormat` prop sets the format of the `<img>` and keeps every `formats` entry as a `<source>`. The `quality` prop applies to every format the component renders. `formats` only applies to images optimized by the site's image service; images from external media providers keep the provider's own URLs. Without `formats`, the output is unchanged.

- [#4213](https://github.com/emdash-cms/emdash/pull/4213) [`caca761`](https://github.com/emdash-cms/emdash/commit/caca7610831465967c5b84e3022fc4db43cac091) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Reduces CPU usage during image upload confirmation by generating placeholders from small browser thumbnails instead of decoding full-resolution originals. For browser-decodable images, the admin now sends thumbnails fitting a 64-pixel box with both signed and direct uploads, and the visual-editing toolbar sends one with every direct upload. This also enables blurhash and dominant-color placeholders for browser-decodable formats such as WebP and AVIF, which previously had none. New uploads and imports no longer generate placeholders for transparent images, including PNGs, so placeholder backgrounds do not show through transparent areas. Existing media keeps its stored placeholders. Image dimensions, upload validation, content hashing, and responsive image variants remain unchanged.
  
  Adds the `imagePlaceholders` configuration option, defaulting to `true` on every runtime, including Cloudflare Workers. This is one site-wide switch for every upload and import: setting it to `false` skips all blurhash and dominant-color generation, including from client thumbnails. WordPress imports, MCP uploads, plugin uploads, and custom clients without thumbnails still decode originals when placeholders are enabled, so sites with constrained CPU budgets may choose to turn this switch off.
  
  Custom clients can send an optional `{ thumbnail: { contentType, data } }` in `POST /_emdash/api/media/{id}/confirm`. Confirm thumbnails accept JPEG or PNG, at most 32,768 base64 characters and 4,096 decoded pixels. Unusable thumbnails omit the placeholder rather than falling back to decoding the original. Thumbnails also work when originals exceed the 8 MiB download cap; supply the original `width` and `height` to record dimensions in that case.

- [#4728](https://github.com/emdash-cms/emdash/pull/4728) [`73c9b70`](https://github.com/emdash-cms/emdash/commit/73c9b70550026ed973ac67c31fcec8188e18f8a0) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Adds `$media.file` to seed files so local images can be imported without serving them over HTTP or disabling URL SSRF protection. Use `{ "$media": { "file": "assets/photo.jpg" } }` with an image next to the seed at `assets/photo.jpg`.
  
  The CLI and Astro setup resolve files relative to the selected seed file's directory. Programmatic callers must supply `mediaBasePath` and a storage adapter. Supply exactly one non-null `url` or `file`; null values are treated as absent, and references that supply both sources are skipped. File paths must stay within that directory, including symlink targets. Local files require a Node.js filesystem at seed-apply time and are not bundled for deployment; Astro setup requires the seed directory at its build-time path. `skipMediaDownload` skips local files rather than creating external URLs for them.

- [#4729](https://github.com/emdash-cms/emdash/pull/4729) [`006cfc0`](https://github.com/emdash-cms/emdash/commit/006cfc0e024ed0b0dd9cd29e7726ac9706d19524) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Adds the `no-scheduling` collection support flag to disable creating or changing schedules in the content editor, calendar, and scheduling API. Scheduling remains enabled by default, and existing schedules continue to run and can be removed.
  
  To disable scheduling, add `no-scheduling` to the collection's `supports` in a seed file, or update an existing collection through `PUT /_emdash/api/schema/collections/{slug}` or the `schema_update_collection` MCP tool. For example, a collection with drafts and revisions can use:
  
  ```json
  { "supports": ["drafts", "revisions", "no-scheduling"] }
  ```
  
  Preserve the collection's other support values when updating its list. There is no Content Type editor checkbox for this flag, but saving in that editor preserves it.
  
  If you previously omitted `scheduling` expecting scheduling to be disabled, add `no-scheduling` instead. The legacy `scheduling` value is deprecated and has no effect; it remains accepted for compatibility and can be removed from seed files. If both values are present, `no-scheduling` takes precedence. Sites that want to keep scheduling enabled do not need to change anything.
  
  WordPress imports into a collection with `no-scheduling` keep future-dated posts as drafts and report a scheduling error for each such post.

- [#4668](https://github.com/emdash-cms/emdash/pull/4668) [`4d4165c`](https://github.com/emdash-cms/emdash/commit/4d4165ccbc78b76648000d492c1f1a61d78df2fc) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Adds recovery revisions, which keep a copy of an editor's unsaved fields in an entry's revision history without changing the entry. Save one with `POST /_emdash/api/content/{collection}/{id}/revisions` and a body of `{ "data": { ... }, "slug": "..." }`, where `slug` may be `null`.
  
  - The route needs a signed-in session, not an API token, and edit access to the entry. It works for entries in Trash, accepts up to 1.9 MB of fields, and responds with the new revision's `id`.
  - The revision is stored as sent, without field validation or `content:beforeSave`, and changes neither the draft nor the published version. Restoring it saves its fields and slug as an edit by the restoring user, so validation and `content:beforeSave` run then.
  - Site export leaves recovery revisions out.

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

- [#3707](https://github.com/emdash-cms/emdash/pull/3707) [`118dcf9`](https://github.com/emdash-cms/emdash/commit/118dcf9caa3eb7c75a79bfcaee8aa736af9530e9) Thanks [@nozamdavid](https://github.com/nozamdavid)! - Fixes the admin manifest so the logo selected in Site Settings appears in the admin branding when no logo is configured directly in `admin.logo`.

- [#4631](https://github.com/emdash-cms/emdash/pull/4631) [`32eab5c`](https://github.com/emdash-cms/emdash/commit/32eab5c3fd28b9712077ed72b52dc43136566f0d) Thanks [@swissky](https://github.com/swissky)! - Reduces database queries on pages that render the same byline more than once in a single request, such as several `getEmDashCollection()` lists or a `getEmDashEntry()` page with a related-posts list, when byline custom fields are defined. Each byline's custom field values are now loaded once per request instead of once per list, including when several lists render at the same time.

- [#4237](https://github.com/emdash-cms/emdash/pull/4237) [`40e4400`](https://github.com/emdash-cms/emdash/commit/40e4400ea99b1448aa4c157028aae0d70bbfe163) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes the command `emdash login` suggests after "Device Flow is not available for this instance.", such as on a site that uses Cloudflare Access for sign-in. The suggested `emdash --token` command failed with "Unknown command"; the hint now shows `emdash schema list --url <url> --token <token>`, and when login got past Cloudflare Access with `--header` flags, `EMDASH_HEADERS` or cloudflared, it also says how to pass that access with each command.

- [#4340](https://github.com/emdash-cms/emdash/pull/4340) [`e79a7ff`](https://github.com/emdash-cms/emdash/commit/e79a7ff14ae4451cb5dabeaedd8edbda1fb6d658) Thanks [@Chiji1108](https://github.com/Chiji1108)! - Fixes `EmDashClient` so migration scripts can keep an entry's original dates: `create()` accepts `publishedAt` and `createdAt`, and `update()` and `publish()` accept `publishedAt`. The content API already accepted these fields for users with `content:publish_any`, but the client's types rejected them and `update()` and `publish()` did not send them.

- [#4339](https://github.com/emdash-cms/emdash/pull/4339) [`7169073`](https://github.com/emdash-cms/emdash/commit/71690735a5c3249dc343cd801d5a70c0b3ee0711) Thanks [@Chiji1108](https://github.com/Chiji1108)! - Fixes the `MediaItem` type returned by `EmDashClient` so it describes the media items the API sends. `storageKey`, `status`, `contentHash`, `blurhash`, `dominantColor` and `authorId` are now typed, and `mediaList()` and `mediaUpload()` return items with their file `url`.
  
  Code that reads these items may need small type changes; runtime values are unchanged:
  
  - `key` and `updatedAt` are removed. The API never returned them, so they were always `undefined`. Read `item.storageKey`, or use `item.url` to link to the file.
  - `size`, `width`, `height`, `alt` and `caption` are typed `T | null` instead of optional `T`, because the API sends `null` when they are unset. Use `item.alt ?? undefined` where a `string | undefined` is expected.

- [#4582](https://github.com/emdash-cms/emdash/pull/4582) [`2abe403`](https://github.com/emdash-cms/emdash/commit/2abe4037f589cfad92f6259e404230c806dccec1) Thanks [@swissky](https://github.com/swissky)! - Fixes `@emdash-cms/cloudflare` installing its own copy of `emdash` when the site has a different `emdash` version. The adapter now declares `emdash` as a peer dependency with its exact matching version, so a site always has a single `emdash`.
  
  Keep both packages on the same version and update them together:
  
  ```sh
  npm install emdash@latest @emdash-cms/cloudflare@latest
  ```
  
  A project with mismatched versions now fails `npm install` with an `ERESOLVE` error instead of installing a second copy. pnpm and Yarn print a peer dependency warning, and `astro build` and `astro dev` warn as before.

- [#4603](https://github.com/emdash-cms/emdash/pull/4603) [`e8ba1b8`](https://github.com/emdash-cms/emdash/commit/e8ba1b865a70ff91a267ffd485c2e4afbbc17931) Thanks [@dmythro](https://github.com/dmythro)! - Fixes the Columns and Cover blocks dropping everything inside them except text. Images, buttons, galleries, embeds, tables and other blocks inside a column or a cover now render on the site, with the same components EmDash's `PortableText` uses elsewhere.

- [#4575](https://github.com/emdash-cms/emdash/pull/4575) [`39a9ccb`](https://github.com/emdash-cms/emdash/commit/39a9ccb5631c64735261bff23523596da74857a4) Thanks [@disney2002](https://github.com/disney2002)! - Fixes dark mode styling across `Comments` and `CommentForm` components under `.dark`:
  
  - Updates `Comments` to use a dark border color (`[#374151](https://github.com/emdash-cms/emdash/issues/374151)`, overridable via `--ec-comment-border-color-dark`) for separators and reaction buttons.
  - Inverts `.ec-comment-form-submit` in dark mode (`#f3f4f6` background, `[#111827](https://github.com/emdash-cms/emdash/issues/111827)` text, overridable via `--ec-form-submit-bg-dark` and `--ec-form-submit-color-dark`) for high contrast against dark backgrounds.
  - Fixes `.ec-comment-user-info` retaining a light border color in dark mode by applying `border-color: var(--ec-form-user-border-dark, #4b5563)`.

- [#4716](https://github.com/emdash-cms/emdash/pull/4716) [`b766773`](https://github.com/emdash-cms/emdash/commit/b7667732bcee48ed094a3f363578b7d525bff212) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes the preview path for Cloudflare Stream videos stuck at `0:00` in the Media Library detail panel. The panel uses Stream's hosted player instead of the browser's native HLS/DASH support. Stream preview URLs ending in `/watch` are converted to the embeddable `/iframe` URL. Media providers can supply an optional `playerUrl` for admin video previews; providers without one keep native video playback.
  
  If you use Astro's content security policy, allow the Stream player host in `frame-src` so the preview can load. EmDash's default admin policy already allows HTTPS frames.

- [#4098](https://github.com/emdash-cms/emdash/pull/4098) [`ddc4e82`](https://github.com/emdash-cms/emdash/commit/ddc4e82e96b6a58d9514c8e8e1f42b7a8d2733f0) Thanks [@marcodangelo](https://github.com/marcodangelo)! - Fixes generating a taxonomy term slug on Cloudflare D1 when the slug derived from the term's name is already taken and 49 characters or longer. The lookup failed with `LIKE or GLOB pattern too complex` instead of adding a numeric suffix.

- [#4651](https://github.com/emdash-cms/emdash/pull/4651) [`638cbaf`](https://github.com/emdash-cms/emdash/commit/638cbaf23df18ef5c2b60b3ceb047988f976fdeb) Thanks [@viktor-kryzhanovsky](https://github.com/viktor-kryzhanovsky)! - Fixes sites using an `objectCache` backend serving the previous version of an entry after a content update under concurrent read load, where the stale entry could keep being served until the next write to the same collection or until the cache TTL expired.

- [#4445](https://github.com/emdash-cms/emdash/pull/4445) [`678a0c2`](https://github.com/emdash-cms/emdash/commit/678a0c2d33ed821d40da2f53141b5740b3dc7773) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes slug changes on draft entries so they no longer create a redirect from the draft's old URL or remove the redirect that already answers at its new URL.

- [#4483](https://github.com/emdash-cms/emdash/pull/4483) [`7d48e95`](https://github.com/emdash-cms/emdash/commit/7d48e95c8b3b0d5f53a48ebbe5ee9f005035c610) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Updates the Zod dependency from 4.5.4 to 4.6.7 to address the reported high-severity `npm audit` warning for the older version. Upgrade EmDash and any separately installed plugin tooling to receive the updated dependency; refreshing a lockfile alone cannot replace the previous exact pin.
  
  Oversized repeater arrays now report the array-length error without validating their rows. Arrays within the configured limit still report individual row errors.

- [#4696](https://github.com/emdash-cms/emdash/pull/4696) [`18844a7`](https://github.com/emdash-cms/emdash/commit/18844a71b8db37b44af600b95e6af906b2c9a208) Thanks [@swissky](https://github.com/swissky)! - Fixes embed blocks whose HTML contains an iframe from a host other than YouTube or Vimeo, such as Google My Maps embeds imported from WordPress, or whose HTML is empty after sanitizing. They rendered as an empty frame or box; they now link to the embed URL, and any other HTML in the embed still renders.

- [#3600](https://github.com/emdash-cms/emdash/pull/3600) [`8418def`](https://github.com/emdash-cms/emdash/commit/8418def8ff01ce7b56b0a0dbaf4693e62afe1e62) Thanks [@itaides](https://github.com/itaides)! - Exports the email hook types (`EmailMessage`, `EmailDeliverEvent`, `EmailBeforeSendEvent`, `EmailAfterSendEvent` and their handler types) from `emdash`, so a plugin that provides `email:deliver` or hooks `email:beforeSend` / `email:afterSend` can type its handlers without copying the definitions.

- [#4619](https://github.com/emdash-cms/emdash/pull/4619) [`fbddae0`](https://github.com/emdash-cms/emdash/commit/fbddae016c160e147acadb7b103b5fc8a722acdc) Thanks [@swissky](https://github.com/swissky)! - Returns a generic `503 Service Unavailable` (with `Retry-After: 60` and `Cache-Control: private, no-store`) instead of `401 Authentication failed` when external authentication such as Cloudflare Access succeeds but the local user lookup, provisioning, or sync fails, for example because database migrations have not been applied. Rejected identities still return 401.

- [#4727](https://github.com/emdash-cms/emdash/pull/4727) [`f5aab79`](https://github.com/emdash-cms/emdash/commit/f5aab791d186f36d9f4434ef6620f288c17f0f4b) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Removes a separate schema-version query when `getEmDashEntry()` and `getEmDashCollection()` render bylines, saving a round trip to D1 and other remote databases. Changes to custom byline fields remain visible across server instances on the next request.

- [#4508](https://github.com/emdash-cms/emdash/pull/4508) [`5137be5`](https://github.com/emdash-cms/emdash/commit/5137be5b4e678c6e71e1daa83001e81009571692) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes invite creation returning “Admin privileges required” for signed-in admins when the API URL has a trailing slash. Invite acceptance remains available without signing in.

- [#4172](https://github.com/emdash-cms/emdash/pull/4172) [`679ad6c`](https://github.com/emdash-cms/emdash/commit/679ad6c4301047e5f99844ba357d3ef15dd87925) Thanks [@cyface](https://github.com/cyface)! - When using auto migration mode, cold starts on an already-migrated database no longer spend a separate database round trip on the migration check: on backends with a coalescing dialect (D1, Durable Object SQL), the applied-migration count is read in the same batch as the other startup reads.

- [#4733](https://github.com/emdash-cms/emdash/pull/4733) [`612569b`](https://github.com/emdash-cms/emdash/commit/612569b1cf590dd80ce5ca68a40046c6cca2ed1c) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes admin browser tabs to show the current page and Site Title, falling back to configured admin branding and then EmDash when Site Title is empty. Content editor tabs include the collection type and entry title and update during client-side navigation.

- [#4460](https://github.com/emdash-cms/emdash/pull/4460) [`b331cf3`](https://github.com/emdash-cms/emdash/commit/b331cf3bfd67c3af03222e09b54b22de688c6bd0) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes stale comments on route-cached pages after approved submissions, moderation, or deletion, including bulk actions. Comment actions that leave approved comments unchanged do not purge cached pages.

- [#4734](https://github.com/emdash-cms/emdash/pull/4734) [`786fd09`](https://github.com/emdash-cms/emdash/commit/786fd09db81be5a8af5b5174044396fb620aa91f) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes content lists showing the original title and field values after saving changes to unpublished drafts in collections with revisions. Entries with a live revision continue to show their published values until the draft is published.

- [#4644](https://github.com/emdash-cms/emdash/pull/4644) [`97aa98a`](https://github.com/emdash-cms/emdash/commit/97aa98ab97a35af4775be5ff70afa56dcc1f3993) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes auth emails, test emails, domain-change notices, and passkey prompts ignoring the title saved in Settings > General. They now prefer that title, falling back to the title recorded during setup when no Settings title is set. Plugins also receive this title when the runtime initializes; an already-running runtime needs to reload before plugins see a changed title.

- [#4531](https://github.com/emdash-cms/emdash/pull/4531) [`f8462af`](https://github.com/emdash-cms/emdash/commit/f8462af329732a38789c980cd6ef632dd89252f3) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes widget API mutations purging cached routes and returning before the object-cache epoch write has settled. Widget edits now wait for the epoch-write attempt before purging routes. This orders the epoch write only: isolates that revalidate through the site-wide change marker can still reuse an old widget epoch until the background marker update becomes visible. Workers KV propagation delays and isolate-local epoch reuse also remain; this does not guarantee immediate cross-isolate freshness.
  
  Code that writes widget tables directly can await `invalidateWidgetObjectCache({ waitForPersist: true })` before purging routes. The same option is available on `invalidateObjectCache(namespace, { waitForPersist: true })`. Existing calls without options remain non-blocking. Epoch writes for all namespaces now use the configured cache timeout, logging failures without failing the mutation; a timed-out backend write may still complete later. Change-marker updates and retries remain background work.

- [#4705](https://github.com/emdash-cms/emdash/pull/4705) [`55273d7`](https://github.com/emdash-cms/emdash/commit/55273d7db78b70a1c5294ff18ba413445aa21c40) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes CLI authentication against local dev servers configured with an external auth provider, such as Cloudflare Access, so commands can use dev bypass without a stored token.

- [#4607](https://github.com/emdash-cms/emdash/pull/4607) [`53b4f32`](https://github.com/emdash-cms/emdash/commit/53b4f321a15d36c5c8f82e90cc2e1041f9940598) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes Markdown imports through the client API, CLI, and MCP to preserve nested inline formatting, links, and list depth. GFM pipe tables now import as native table blocks and export as Markdown tables, including cell formatting and alignment. Tables with merged cells or other layouts that GFM cannot represent remain preserved in opaque block comments. Headings containing hard line breaks are also exported as opaque blocks to preserve their text and formatting.
  
  Markdown imports now treat a single newline as a soft wrap within one paragraph; separate paragraphs with a blank line. Reads escape literal inline punctuation (for example, `snake_case` becomes `snake\_case`), use `*text*` for italics instead of `_text_`, and write hard line breaks as a trailing backslash (`\`).
  
  Unlinked images in ordinary paragraphs become native image blocks, splitting surrounding text into separate paragraphs. Images inside list items, blockquotes, or links remain inline Markdown text so their containing list, quote, or link is preserved.

- [#4484](https://github.com/emdash-cms/emdash/pull/4484) [`55964d5`](https://github.com/emdash-cms/emdash/commit/55964d56d4ed866b1e676fa632fd620f44e1dabe) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes the visual editor toolbar to detect and publish unpublished changes for every annotated entry on the page, rather than only the first entry on load or the last entry saved. If an entry fails to publish, other pending entries are still published and the page stays open so failed entries can be retried without republishing entries that already succeeded.

- [#4417](https://github.com/emdash-cms/emdash/pull/4417) [`235a11a`](https://github.com/emdash-cms/emdash/commit/235a11af21e801ec9f0195cdfc3d46f51341d526) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes seed imports assigning taxonomy terms from another locale when slugs are shared across translations. Taxonomy references now resolve in the content entry's locale. When no term with that slug exists in the entry's locale, the import logs a warning and skips that assignment instead of attaching a term from another locale; add the term in that locale to keep the assignment.
  
  Reapplying a seed in update mode also preserves taxonomy assignments contributed by each content translation instead of letting later translations erase earlier ones.
  
  Existing assignments are not repaired automatically. To repair seeded entries already attached to a wrong-locale term, reapply the seed with `--on-conflict update`. This also overwrites other seeded records with the seed's values, so review the seed before reapplying it.

- [#4703](https://github.com/emdash-cms/emdash/pull/4703) [`4ccc279`](https://github.com/emdash-cms/emdash/commit/4ccc2794518a9796d9adfeb8362a56845f193c18) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes concurrent CLI sign-ins, token refreshes, and sign-outs overwriting credentials for other EmDash sites.

- [#4095](https://github.com/emdash-cms/emdash/pull/4095) [`ab2c40b`](https://github.com/emdash-cms/emdash/commit/ab2c40b49bc8de4aa3616713c63d35c7b6fd19cc) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fixes plugin storage-index synchronization so a fresh runtime cannot serve state-changing plugin routes before the declared indexes are materialized. These routes return `503 STORAGE_INDEXES_NOT_READY` if synchronization is incomplete. After correcting the underlying conflict, a subsequent write request or scheduled maintenance pass retries synchronization without a process restart. GET and HEAD plugin routes do not trigger index synchronization.
  
  When stored indexes match the plugin's declarations, a cold runtime checks them once without reissuing index statements. Updating or reinstalling a runtime-installed plugin rechecks its declarations before its next state-changing route runs. While a conflict remains, each subsequent write request retries the plugin's full index synchronization and returns 503. Correct the conflicting data before retrying to avoid repeated index work.

- [#4476](https://github.com/emdash-cms/emdash/pull/4476) [`e30df1e`](https://github.com/emdash-cms/emdash/commit/e30df1ed488bbbae21669ecf169da3376989a69e) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes stale runtimes and background cron jobs surviving Node.js `astro dev` restarts, such as after editing `astro.config.mjs`, which could cause `Vite module runner has been closed` errors. The next request now initializes a fresh runtime.

- [#4542](https://github.com/emdash-cms/emdash/pull/4542) [`7159eda`](https://github.com/emdash-cms/emdash/commit/7159edac7db4998d3ff92a5b8cd6d64b9ecefc85) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes content creation on Cloudflare D1 when a long generated slug is already taken, allowing repeated titles to receive numeric slug suffixes instead of failing with `CONTENT_CREATE_ERROR`.

- [#4353](https://github.com/emdash-cms/emdash/pull/4353) [`9699645`](https://github.com/emdash-cms/emdash/commit/9699645f8062794bf50183d5208dc61c4be33a6f) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes intermittent Cloudflare Workers startup failures with `Cannot access 'VALID_HOOK_NAMES_SET' before initialization` when standard-format plugins are configured in the Astro integration.

- [#4598](https://github.com/emdash-cms/emdash/pull/4598) [`dd4ae19`](https://github.com/emdash-cms/emdash/commit/dd4ae190fb90d495650b46012a97c335c37459cf) Thanks [@onetogregorio](https://github.com/onetogregorio)! - Fixes the Portable Text link mark dropping a `title` stored on the link, so `<PortableText>` now renders it as the link's `title` attribute (shown by browsers on hover). Links without a title render as before.

- [#4563](https://github.com/emdash-cms/emdash/pull/4563) [`82eb778`](https://github.com/emdash-cms/emdash/commit/82eb778c8931ae6af16a85725617e4131d5a225e) Thanks [@saariuslystoned](https://github.com/saariuslystoned)! - Fixes `<LiveSearch>` keyboard navigation after a result has focus: Down and Up keep moving through the results (wrapping at either end), and Escape closes the results and returns focus to the search input. Previously both keys stopped working once the first result was focused.

- [#4694](https://github.com/emdash-cms/emdash/pull/4694) [`3f9c77b`](https://github.com/emdash-cms/emdash/commit/3f9c77ba7f98f5aa500b645095038100e6753a14) Thanks [@swissky](https://github.com/swissky)! - Fixes the MCP `settings_update` tool reporting success for `seo.robotsTxt` and `seo.disallowAiTraining` on sites with their own `src/pages/robots.txt`. That file replaces EmDash's `/robots.txt`, so these settings never took effect. The tool now rejects changes to them with `ROBOTS_TXT_OVERRIDDEN` and stores nothing. Sending the stored values back unchanged, or clearing them with `""` or `false`, still works.

- [#4668](https://github.com/emdash-cms/emdash/pull/4668) [`4d4165c`](https://github.com/emdash-cms/emdash/commit/4d4165ccbc78b76648000d492c1f1a61d78df2fc) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes MCP `content_update` reporting a plain conflict after it had already saved field changes. When it saves the fields and the publish or unpublish requested with `status` then conflicts, the `CONFLICT` error now says the fields were saved and returns their new `_rev` in `details._rev`, so an agent can retry the status change without sending the fields again.

- [#4326](https://github.com/emdash-cms/emdash/pull/4326) [`e25d2ee`](https://github.com/emdash-cms/emdash/commit/e25d2ee7bf2da9a972923e2ee82fb5aa77265a89) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes **Used in** missing rich text images and videos that refer to a library file by its `/_emdash/api/media/file/` URL instead of its media ID. Markdown images written through MCP or the CLI are stored this way, so files placed by agents and scripts looked unused, even right after media usage tracking was turned on. These references are now indexed. On sites that already track media usage, collections with rich text or blocks fields are marked for reindexing after the upgrade, and **Used in** reports their index as stale. To reindex them, an administrator opens **Settings** > **Media usage tracking** and keeps the page open until the status reads **Ready**.
  
  Saving rich text through the REST API, MCP, or the CLI now also stores the media ID (`asset._ref`) for these blocks when the URL matches a file in the media library, as images placed in the editor already have.

- [#4454](https://github.com/emdash-cms/emdash/pull/4454) [`5a9f1bd`](https://github.com/emdash-cms/emdash/commit/5a9f1bdef6ab92a2c286264aba98eab94bc19b36) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes deleting a menu item on SQLite, libSQL, and Cloudflare D1 so the items nested under it are deleted too, as they already were on PostgreSQL. Before, the nested items stayed behind: the site showed them as top-level menu items, but the menu editor no longer listed them, so they could not be edited or removed.
  
  When a menu item has nested items, the menu editor's delete confirmation now says they will be deleted too.
  
  Upgrading moves every menu item whose parent is missing from its menu to the top level, where the site already shows it, so the menu editor lists it again.
  
  #### What should I do?
  
  After upgrading, review your menus in the admin. Items left behind by an earlier delete now appear at the top level, where your site was already showing them. Delete any you no longer want.

- [#4491](https://github.com/emdash-cms/emdash/pull/4491) [`6331f6b`](https://github.com/emdash-cms/emdash/commit/6331f6b4ba2c9f9d6eac778c2ee311e9cbd79768) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes uploads into image and file fields inside blocks ignoring the nested field's `allowedMimeTypes`. Allowed Word documents and other types outside the default upload list can now be uploaded directly from a block's media picker.
  
  API clients uploading into a block field can send `blockType` (the block type slug) and `blockVersion` (the block's version number) with the composite `fieldId` (`<outerFieldId>:<blockKey>:<fieldSlug>`) to `POST /_emdash/api/media` or `POST /_emdash/api/media/upload-url`. Use the database ID of the collection's blocks field for `outerFieldId`, and send `blockVersion` as a string in multipart requests or a number in upload-URL JSON requests. Without the block context, the default upload allowlist still applies.

- [#4289](https://github.com/emdash-cms/emdash/pull/4289) [`19c4f28`](https://github.com/emdash-cms/emdash/commit/19c4f281361f03eb907ba9521bf76fce289b2519) Thanks [@Antonio-Bennett](https://github.com/Antonio-Bennett)! - Fixes OAuth sign-in on Node adapters ignoring provider credentials (`EMDASH_OAUTH_*` and provider `*_CLIENT_ID`, `*_CLIENT_SECRET` and `*_TENANT_ID` values) set at runtime, for example with container environment variables. Sign-in failed with `provider_not_configured` unless the credentials were also present when the site was built, and credentials present at build time were written into the server bundle.
  
  On Node, OAuth credentials must now be in the server's process environment at runtime; values baked in from `.env` at build time are no longer used. If you only set them in a `.env` file, load it when starting the server (for example `node --env-file=.env ./dist/server/entry.mjs`) or set them in your host's environment; otherwise sign-in fails with `provider_not_configured`. `astro dev` still falls back to `.env`. If your server build output was shared or stored, rotate any client secret that was present at build time.

- [#4079](https://github.com/emdash-cms/emdash/pull/4079) [`fc44f40`](https://github.com/emdash-cms/emdash/commit/fc44f406c32e2997e9e7e96ace12f70b65293a13) Thanks [@marcodangelo](https://github.com/marcodangelo)! - Fixes the object cache reading one epoch key per namespace on every render once `revalidate` has passed. On Workers KV with `kvCache()`, a page that reads several collections, menus, bylines, and taxonomies now usually reads one change-marker key to revalidate all of them, instead of one KV read per namespace. Isolates still pick up a change within KV propagation plus `revalidate`. After deploying, the saving starts with the first content, menu, or settings change, because older releases do not write the marker. Comment changes don't rewrite the marker, and the comments epoch is always read directly. With `revalidate: 0`, every query still reads its epochs directly.

- [#3019](https://github.com/emdash-cms/emdash/pull/3019) [`df0f952`](https://github.com/emdash-cms/emdash/commit/df0f952b4e4811696996540ab56156cf1b395570) Thanks [@marcin-misiewicz-pl](https://github.com/marcin-misiewicz-pl)! - Fixes the JSON-LD that core emits on public pages, which published nodes nothing could reference. `BlogPosting`, its `publisher`, and `WebSite` had no `@id`, so an Organization graph describing the site — from a plugin or written into a template — stood beside the article's publisher as a second, competing organisation instead of merging with it. Article pages carried two organisations, and the fuller one was not the article's publisher.
  
  Each of the three nodes now carries an `@id`: `<canonical>#article`, `<origin>/#organization`, and `<origin>/#website`. The publisher keeps its `@type` and `name`, so a site publishing no Organization graph of its own is unaffected.
  
  Sites already emitting an Organization graph should confirm its `@id` is `<origin>/#organization` — with the slash before the fragment. `https://example.com#organization` is a different IRI, and a mismatch produces two organisations rather than one.

- [#3266](https://github.com/emdash-cms/emdash/pull/3266) [`60fef17`](https://github.com/emdash-cms/emdash/commit/60fef17db3df5844d6401e1ebe3f03cc722d688a) Thanks [@eisenbruch](https://github.com/eisenbruch)! - Speeds up `getEmDashCollection()` listings on SQLite and D1 that filter by two or more taxonomies and no content fields. The listing now starts from the taxonomy with the fewest entries instead of the one written first in `where`, so a broad taxonomy listed first no longer slows it down.

- [#4511](https://github.com/emdash-cms/emdash/pull/4511) [`b9fc5f2`](https://github.com/emdash-cms/emdash/commit/b9fc5f2b15444a4090f5e2e7ad7a0c36487c6228) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes preview links in Playground sessions: the admin's Preview button now shows the saved draft instead of the published page.

- [#2817](https://github.com/emdash-cms/emdash/pull/2817) [`dfbb9fc`](https://github.com/emdash-cms/emdash/commit/dfbb9fc8d8eb24dd17d363918155edc40b26d147) Thanks [@scottbuscemi](https://github.com/scottbuscemi)! - Fixes config-registered plugins showing their identifier instead of their display name and omitting their description in the admin Plugins list.

- [#4593](https://github.com/emdash-cms/emdash/pull/4593) [`5605cec`](https://github.com/emdash-cms/emdash/commit/5605cec9f89b42202955af49d3e5e776d5ae2cbb) Thanks [@swissky](https://github.com/swissky)! - Fixes `astro dev` reloading the admin on the first visit after a cold start. Plugin admin pages that import `emdash/plugin-utils` no longer load against stale pre-bundled modules from before the reload.

- [#4284](https://github.com/emdash-cms/emdash/pull/4284) [`9aa2259`](https://github.com/emdash-cms/emdash/commit/9aa225935e6219cca3ece4e44c8f1e7de073f99c) Thanks [@devondragon](https://github.com/devondragon)! - Fixes `getSiteSettings()` and `getSiteSetting()` ignoring the storage `publicUrl`. On sites that serve media from an R2 custom domain or S3 CDN, the site logo, favicon, and default social image now use that URL instead of `/_emdash/api/media/file/`. Admin and REST API responses keep the internal route.
  
  Also fixes `<Media>` throwing "Local media provider requires database connection" when rendering media from the media library. It now renders local media with the storage `publicUrl` when one is configured.

- [#4591](https://github.com/emdash-cms/emdash/pull/4591) [`b528fc0`](https://github.com/emdash-cms/emdash/commit/b528fc0c33a9708dfe6d93737ee27f6e93f766c4) Thanks [@swissky](https://github.com/swissky)! - Fixes Archives and Recent Posts widget links and `hreflang` alternate URLs on sites configured with an Astro `base`. They now include the base path instead of pointing to the site root.

- [#4708](https://github.com/emdash-cms/emdash/pull/4708) [`752cbcd`](https://github.com/emdash-cms/emdash/commit/752cbcd4311bf12f394045dc75b9144b2b688aa4) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes site transfer imports failing with `TRANSFER_TARGET_NOT_EMPTY` after an interruption while removing starter collections created during setup. Resuming the import now continues that cleanup instead of treating the collection as existing content.
  
  **Settings → Transfer** now identifies collections whose deletion failed and explains how to retry them before importing. Deletions that are still in progress do not block a new import; the importer advances their cleanup.
  
  #### What should I do?
  
  If your import was interrupted, reopen **Settings → Transfer** to continue it, or run `emdash site import resume <operation-id>`. If the import or a collection deletion failed, follow the guide's [retry and recovery steps](https://docs.emdashcms.com/guides/site-transfer/#resolve-failed-collection-cleanup) before starting another import.

- [#4742](https://github.com/emdash-cms/emdash/pull/4742) [`b8886d9`](https://github.com/emdash-cms/emdash/commit/b8886d9476b922990ee1d50abb73facbbf2d131d) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes WXR imports publishing password-protected WordPress posts for anyone to read on the imported site. The admin import and `emdash import wordpress` now bring in a post with a WordPress password as a draft, whatever its WordPress status, and list each one on the **Import Complete** screen and in the CLI output.
  
  Imports through the EmDash Exporter plugin are unchanged: the exporter does not send post passwords, so a published, password-protected post still arrives published.
  
  #### What should I do?
  
  If you imported a WXR file before this release, or import through the EmDash Exporter, find the entries that WordPress marks as "Password protected" on its **Posts**, **Pages** and custom post type screens, and unpublish them in EmDash if they should stay private.

- [#3016](https://github.com/emdash-cms/emdash/pull/3016) [`c095458`](https://github.com/emdash-cms/emdash/commit/c095458800274d4c4c18c7b68a94df5a595b7ebb) Thanks [@jakevis](https://github.com/jakevis)! - Fixes `emdash schema delete --force` so it can delete a collection that still has content. The flag only skipped the confirmation prompt and was never sent to the API, which then refused with "Use force: true to delete". `EmDashClient.deleteCollection` accepts `{ force: true }` for the same purpose.

- [#3916](https://github.com/emdash-cms/emdash/pull/3916) [`8f397e0`](https://github.com/emdash-cms/emdash/commit/8f397e031882768abbab04d534e6f2ad32288b97) Thanks [@eisenbruch](https://github.com/eisenbruch)! - Fixes `getEmDashCollection()` with `where: { id: [...] }` on SQLite walking the whole collection once `ANALYZE` has run on a database with trashed entries. The requested ids are now looked up by primary key; other list queries are unchanged.

- [#4403](https://github.com/emdash-cms/emdash/pull/4403) [`b436669`](https://github.com/emdash-cms/emdash/commit/b436669627e29784019e1e0a4b23b09b532003cd) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes re-enabling a plugin reporting success when its `plugin:activate` hook fails. Failed activation now returns an enable error and leaves the plugin inactive, with its routes, hooks, sandbox host access, and cron tasks disabled.

- [#4557](https://github.com/emdash-cms/emdash/pull/4557) [`4cb8305`](https://github.com/emdash-cms/emdash/commit/4cb8305ef818f21ceac6d2eacd85e2e26239f0fb) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes Registry plugin installs and updates failing with `AGGREGATOR_RECORD_MISMATCH` when a newer package profile is awaiting listing review. Releases still have to match the publisher's signed records, and verification and consent continue to use the publisher's current signed release policy. While a newer profile is awaiting review, installed and updated plugins take their name and description from the approved registry listing.

- [#4539](https://github.com/emdash-cms/emdash/pull/4539) [`0c57c94`](https://github.com/emdash-cms/emdash/commit/0c57c94de64350880e7cb637a43d93c53bd93dcd) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes a rare case where a redirect that took too long to create could still be added after a newer redirect change had started, once the redirect write lock had been recreated. Such a redirect is now rejected.

- [#4366](https://github.com/emdash-cms/emdash/pull/4366) [`56c801c`](https://github.com/emdash-cms/emdash/commit/56c801cbe995d9a55368a53d541aab12901ac150) Thanks [@cameronapak](https://github.com/cameronapak)! - Fixes redirect creation and editing failing with "Another redirect change is in progress" when the redirect write lock row is missing. Redirect writes now recreate the missing row automatically while preserving active locks.

- [#4615](https://github.com/emdash-cms/emdash/pull/4615) [`aef09ae`](https://github.com/emdash-cms/emdash/commit/aef09aed2b7341499d7915562d293dcca923faa1) Thanks [@swissky](https://github.com/swissky)! - Fixes redirects whose source path contains non-ASCII characters, such as `/stitek/domácí-zvířata`. These rules never matched before and visitors got a 404. Exact and pattern redirects now match whether the source was entered as raw Unicode or percent-encoded in either letter case, with no changes needed to existing rules. Non-ASCII characters in a redirect destination are percent-encoded in the `Location` header instead of failing the request. Loop detection, both when saving a redirect and on the Redirects page, treats raw and percent-encoded spellings of a path as the same path.

- [#4061](https://github.com/emdash-cms/emdash/pull/4061) [`1f46f0d`](https://github.com/emdash-cms/emdash/commit/1f46f0dee6e2fd2d19631dd873aa224c3a6f1881) Thanks [@eisenbruch](https://github.com/eisenbruch)! - Fixes API tokens being unable to manage redirects without the `admin` scope. Reading redirects now takes `content:read` and creating, updating or deleting one takes `settings:manage`. Reading the 404 log, which holds visitor IP addresses, takes `settings:read`, and clearing or pruning it takes `settings:manage`. The token owner's role is still checked.

- [#4668](https://github.com/emdash-cms/emdash/pull/4668) [`4d4165c`](https://github.com/emdash-cms/emdash/commit/4d4165ccbc78b76648000d492c1f1a61d78df2fc) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes `ctx.content.delete()` in sandboxed plugins, on Cloudflare and with `@emdash-cms/sandbox-workerd`, so it moves entries to Trash as the admin does. Sites with an `objectCache` no longer keep serving the trashed entry from the cache, and the entry's `updated_at` and `_rev` no longer change.

- [#4782](https://github.com/emdash-cms/emdash/pull/4782) [`9db2de8`](https://github.com/emdash-cms/emdash/commit/9db2de8db3cf896d350eabdc91de663b481cbda3) Thanks [@eisenbruch](https://github.com/eisenbruch)! - Fixes a scheduled entry that publishing refuses staying overdue forever. When the scheduler's publish fails with a validation error or a slug conflict, the entry is now unscheduled and the dashboard lists it with the error message, as it already does when a plugin rejects a scheduled publish. Before, the error went only to the server log, the scheduler retried it on every run, and the calendar said scheduled publishing might not be running.
  
  `ScheduledPolicyRejection.pluginId` is now optional, and the record gains an optional `code`: a record written for a refused publish has no `pluginId` and carries the publish error's `code` instead. Code that reads `emdash:scheduled-policy-rejection:*` records, or narrows with `isScheduledPolicyRejection`, should handle a missing `pluginId`.

- [#4560](https://github.com/emdash-cms/emdash/pull/4560) [`1357172`](https://github.com/emdash-cms/emdash/commit/135717212559ed710bb1b7d7b447284641ac1734) Thanks [@marcodangelo](https://github.com/marcodangelo)! - Shortens each cron tick on sites with several collections, most noticeably on Cloudflare D1, where every query is a network round trip: the scheduled-publishing sweep now skips collections with nothing due instead of querying each of them twice.

- [#4715](https://github.com/emdash-cms/emdash/pull/4715) [`2c2a1e8`](https://github.com/emdash-cms/emdash/commit/2c2a1e83b23b6be9f6ec8caf9bc06482b615967d) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes plugin storage `uniqueIndexes` rejecting duplicate field values in unrelated plugins and collections. Uniqueness now applies only to the collection that declares it, while indexed lookups remain available. A database migration repairs existing tracked unique indexes, including those left by plugins removed from configuration; no manual index cleanup is needed. Unique index names also keep case-distinct collections and fields separate on SQLite/D1 and avoid PostgreSQL truncation collisions. Existing regular lookup indexes retain their short names; tracked names longer than 63 characters may be rebuilt on the next storage-index sync, triggered by a write or scheduled task.
  
  Sites with plugin storage unique indexes need a maintenance window for migration `095_plugin_storage_unique_scope`. Do not apply it in a pre-deploy migration job while older builds still serve traffic or scheduled work: they can recreate the non-partial constraints. Stop and drain old Node.js processes before migrating. On Workers, route traffic to maintenance and drain old invocations, deploy the upgraded build in `check` mode, then migrate and reopen traffic. Follow the platform-specific steps in the [upgrade guide](https://docs.emdashcms.com/deployment/updating/#fixed-plugin-storage-uniqueness).
  
  If a previous index-name collision or manual index removal allowed duplicates in a declared unique field, the migration stops without deleting data or dropping legacy constraints. Resolve the duplicate values in the collection named by the error, then retry the migration.

- [#4534](https://github.com/emdash-cms/emdash/pull/4534) [`532e78b`](https://github.com/emdash-cms/emdash/commit/532e78bc3604b43cf9f51c3ed6e586f2f9d6ed68) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes the default SEO title ignoring a collection's `titleField`. When an entry's SEO title is empty, `getSeoMeta()` now takes the page title from the collection's title field for entries from `getEmDashEntry()` and `resolveEmDashPath()`, and falls back to the `title` field when the collection sets no `titleField` or the entry leaves that field empty. The **SEO Title** placeholder in the editor shows the same value. Before, both read only the `title` field, so a collection that keeps its titles in a `headline` field got an empty page title.
  
  #### What should I do?
  
  If a collection's `titleField` names a field other than `title` and the collection also has a `title` field, its pages now take their title from the `titleField` value. To keep using the `title` field, pass it as the default title:
  
  ```ts
  const seo = getSeoMeta(post, { defaultTitle: post.data.title });
  ```

- [#4553](https://github.com/emdash-cms/emdash/pull/4553) [`5845694`](https://github.com/emdash-cms/emdash/commit/5845694c7991250484036551a96428f5ef96c5f3) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes the `Embed` component rendering unrelated links as YouTube or Vimeo players when they contain a video URL in their path or query string, or use a lookalike hostname. Video detection now recognizes only `youtube.com`, `www.youtube.com`, `m.youtube.com`, `youtu.be`, `vimeo.com`, and `www.vimeo.com`; other hosts remain links unless the block supplies HTML or an explicit audio/video provider.

- [#4697](https://github.com/emdash-cms/emdash/pull/4697) [`c9dffb7`](https://github.com/emdash-cms/emdash/commit/c9dffb751c59e968c967ff62c678a0f6622e3ceb) Thanks [@swissky](https://github.com/swissky)! - Fixes slug-change redirects for collections whose URL pattern ends in `/`, such as `/whats-on/{slug}/`. The automatic redirect now points to the URL with its trailing slash. When an entry's slug changes, existing redirects to or from its old and new URLs are matched with or without the trailing slash, so old URLs no longer take an extra hop and a redirect at the new URL no longer sends visitors away. Disabled redirects and 410 or 451 rules at the old URL are left unchanged, and the old URL keeps that rule instead of getting a new redirect. When an entry is published at a URL that an automatic slug-change redirect still points away from, that redirect is now removed in either form.

- [#4596](https://github.com/emdash-cms/emdash/pull/4596) [`2f64c3c`](https://github.com/emdash-cms/emdash/commit/2f64c3ca0311d71a5f8eeb1de900eaf2a161c8fc) Thanks [@eisenbruch](https://github.com/eisenbruch)! - Reduces the code a site evaluates on the first request of each new server instance. Importing anything from `emdash`, such as `getEmDashCollection`, no longer forces the API schemas, the WordPress importer, the seed applier and other admin-only code to load before a page renders. They load when an admin, API or import request first uses them. Sites need no changes.

- [#4610](https://github.com/emdash-cms/emdash/pull/4610) [`34a8e5a`](https://github.com/emdash-cms/emdash/commit/34a8e5a33e8da018da06b0ebf3d42ec3f6bf73ee) Thanks [@swissky](https://github.com/swissky)! - Fixes backup downloads and preview snapshots failing on Cloudflare D1 for sites with a lot of content or revision history. From November 4, 2026, D1 rejects query results larger than 50 MB. Backups and snapshots now stay under that limit and contain the same data as before.

- [#4478](https://github.com/emdash-cms/emdash/pull/4478) [`3a13512`](https://github.com/emdash-cms/emdash/commit/3a1351219c7b369b43f40d7a09160731fff2384b) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes the public Image component and Portable Text image and gallery blocks emitting duplicate `srcset` URLs when Astro’s image service returns the source URL unchanged. This includes the public Image component’s `formats`/`<picture>` output for light and dark variants. These images now render without generated `srcset` or `sizes`; resizing still requires a working image service.

- [#4510](https://github.com/emdash-cms/emdash/pull/4510) [`1cf644e`](https://github.com/emdash-cms/emdash/commit/1cf644ef37a5dfb8d5c471d8e42b77ed90bb9ffc) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Replaces the Change domain error "does not serve this site yet" with "Could not verify that … serves this site" when the server cannot verify a domain, including Cloudflare Workers Custom Domains. The dialog now explains that a Worker may be unable to reach its own domain and asks you to confirm the new address shows your site in a browser before using it without the check.

- [#4389](https://github.com/emdash-cms/emdash/pull/4389) [`fac4008`](https://github.com/emdash-cms/emdash/commit/fac4008afe4842bdb5fd5ba7b43695831bdf52b6) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes Revisions missing the content an entry started with, so editors can compare against it or restore it after editing. In collections with revisions, the first save of an entry that has no revision yet now keeps its starting content as its oldest revision, whether that save comes from the admin, the API, MCP or a plugin. This covers new and duplicated entries, translations, imported posts, and existing entries that haven't been saved since they were created.

- [#4589](https://github.com/emdash-cms/emdash/pull/4589) [`c54ca68`](https://github.com/emdash-cms/emdash/commit/c54ca68b564719ea238d783dfd3fc3a7f9668f6c) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes category, tag, and search widget URLs on sites configured with an Astro `base`. Built-in sitemap routes now initialize correctly under the base instead of returning 500, and sitemap URLs and robots.txt sitemap references include the base path.

- [#4401](https://github.com/emdash-cms/emdash/pull/4401) [`e21e01e`](https://github.com/emdash-cms/emdash/commit/e21e01e5eb3b57de6a8c6c4531ca5fe184985114) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes responsive table widths in the admin editor with Tiptap 3.32.0. Gives both editors' textboxes accessible names for screen readers.
  
  Pins the editor's Tiptap dependencies to exactly 3.32.0 so installations use the version covered by the editor tests. Code-block highlighting keeps its existing lowlight extension version. Sites or plugins that share Tiptap dependencies with EmDash should align them to 3.32.0 to avoid installing multiple copies.
  
  Links applied at an empty caret now end when you type a space, following Tiptap's updated behavior. In the visual editor, typing a space at the end of an existing link also ends the link. Text typed after that space is not part of the link.

- [#4726](https://github.com/emdash-cms/emdash/pull/4726) [`f298866`](https://github.com/emdash-cms/emdash/commit/f2988667f6f1a0ee5915d2a14003034a4b17bff7) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes unnecessary session-store reads on public pages for visitors without a session cookie, reducing anonymous render latency on sites using remote session storage such as Cloudflare KV. Respects custom Astro session cookie names when identifying authenticated requests in the main middleware and on public routes.

- [#4088](https://github.com/emdash-cms/emdash/pull/4088) [`dafb551`](https://github.com/emdash-cms/emdash/commit/dafb55184d977e05a4f236faea5f4a14ad6c0f6a) Thanks [@mateusz-zadorozny](https://github.com/mateusz-zadorozny)! - Avoids an extra query when a listed entry has no terms in a taxonomy. `getTermsForEntries()` and `getEntryTerms()` now answer from the terms already loaded with the content query, so a blog list with an untagged post no longer queries its tags again.

- [#4581](https://github.com/emdash-cms/emdash/pull/4581) [`3d569ab`](https://github.com/emdash-cms/emdash/commit/3d569ab609970195d0d8185fe36697420492664f) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes taxonomy `where` filters with long term-slug lists failing with D1's bound-parameter limit and returning an empty collection result with an error, including queries that combine taxonomy and field filters.

- [#4711](https://github.com/emdash-cms/emdash/pull/4711) [`6ee8a5f`](https://github.com/emdash-cms/emdash/commit/6ee8a5f0dc488201f394df5164d6e0a9bae3b3fd) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes CLI dev authentication creating `dev@emdash.local` before first-run setup and blocking the setup wizard with “Admin user already exists”. Dev authentication now requires completed setup; finish the wizard first or explicitly skip it under `astro dev` with `/_emdash/api/setup/dev-bypass?content=0`.
  
  If an earlier version has already left your development site blocked by this error, opening `/_emdash/api/setup/dev-bypass?content=0` under `astro dev` completes setup using the existing dev account without adding sample content, bylines, or taxonomy terms. It still applies the seed's schema and structure. This skips the wizard rather than replacing the dev account with a personal account.

- [#4699](https://github.com/emdash-cms/emdash/pull/4699) [`d541993`](https://github.com/emdash-cms/emdash/commit/d54199397adae38a0875d9d501932434059f1020) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes WordPress import URL rewriting skipping Portable Text images and links on PostgreSQL. Also handles image and file fields returned as parsed JSON, while preserving existing behavior for text-backed media fields.

- [#4526](https://github.com/emdash-cms/emdash/pull/4526) [`34a6816`](https://github.com/emdash-cms/emdash/commit/34a6816c3b5d3b72d39b17425bbfec8392e8a3e7) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes passkey login returning “Not authenticated” before the browser can request a passkey when middleware adds trailing slashes to API URLs. Public API routes, including login options and health checks, now accept either spelling while keeping private routes protected and preserving CSRF checks.

- [#4482](https://github.com/emdash-cms/emdash/pull/4482) [`88a61f8`](https://github.com/emdash-cms/emdash/commit/88a61f85c55ff80b9f9ec1ac7cc9e2c0d76cf77a) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes stylesheets imported by a plugin's `adminEntry` appearing on public pages in production builds. Plugin admin styles now load with the admin app without adding render-blocking stylesheet requests for public visitors.

- [#4358](https://github.com/emdash-cms/emdash/pull/4358) [`0008289`](https://github.com/emdash-cms/emdash/commit/0008289cca28c2618e4de40a6eb3159552321ef8) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes config-declared sandboxed plugins, including those running with `sandbox: false`, skipping `plugin:install` and `plugin:activate` on first boot. These hooks now run for plugins without a recorded state, including on the first start after upgrading, so activation hooks can set up recurring tasks without an admin disable/re-enable cycle.
  
  If a sandbox stops before setup finishes, `plugin:install` can run again on the next boot. Make install hooks safe to repeat when settings or plugin data already exist.
  
  `createPluginRuntimeTestHost()` also runs install → activate when creating a host, before test fixtures are added. A failure in the plugin's own lifecycle hook disables it in the test host, so later actions will not invoke its hooks. Tests that explicitly call `actions.plugin.activate()` should account for the initial activation.
  
  #### What should I do?
  
  Make install hooks set only missing values. If a plugin hook failed, fix the hook and re-enable the plugin from the Plugins page to run `plugin:activate` again.

- [#4398](https://github.com/emdash-cms/emdash/pull/4398) [`a7cf38f`](https://github.com/emdash-cms/emdash/commit/a7cf38fb8babfea53f9c10bf6b7eac53e40609b7) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes `/_emdash/api/search` silently returning no results on Node.js builds whose SQLite lacks FTS5. Search and suggestion requests return `503 SEARCH_UNAVAILABLE` with an explanation; enabling or rebuilding search reports the same cause. MCP search errors also use the `SEARCH_UNAVAILABLE` code. Programmatic search functions throw the exported `SearchUnavailableError`. Server-rendered search pages that do not catch it return an error until FTS5 is available. Catch this error to display an unavailable message. After switching to a build with FTS5 support, enable search for any collections whose setup failed.

- [#4415](https://github.com/emdash-cms/emdash/pull/4415) [`76c1936`](https://github.com/emdash-cms/emdash/commit/76c1936cd88fb2cd18b4c10d69c6d74d63eca233) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes content previews after a saved slug change to open and render the draft at its new slug, without changing the published URL until publication.

- [#4662](https://github.com/emdash-cms/emdash/pull/4662) [`222658c`](https://github.com/emdash-cms/emdash/commit/222658c8ca639cf9322d8c21b4c40fe7dc57bc71) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes Portable Text type exports from `emdash/ui` so TypeScript consumers can resolve the types and reject invalid values such as a number assigned to `PortableTextBlock`.
  
  The `<PortableText>` component's props are now type-checked too, so invalid `value`, `components`, or `listNestingMode` arguments may report errors after upgrading. Undefined content remains supported and renders as empty content.

- [#4702](https://github.com/emdash-cms/emdash/pull/4702) [`c2792d5`](https://github.com/emdash-cms/emdash/commit/c2792d5a1fc7084d9ca1354137949df39906b122) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes plugin route handlers receiving `null` client IP and geo metadata on Cloudflare when invoked through MCP tools, content editor panels, or editor actions.

- [#4660](https://github.com/emdash-cms/emdash/pull/4660) [`064b566`](https://github.com/emdash-cms/emdash/commit/064b566d6331c58c7a68f8772dee6d809252fadb) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes `emdash/ui`, `emdash/ui/search`, `emdash/ui/comments`, and `emdash/ui/webmcp-search` imports so TypeScript uses package declarations instead of checking EmDash source under your project's compiler settings, including when using Astro's TypeScript content mapper. Astro continues to compile the components from source when building your site.
  
  Plain `tsc` now checks component props, including required props and `Blocks` renderer types. Calls that previously relied on loosely typed `.astro` imports may report invalid props after upgrading.

- [#4632](https://github.com/emdash-cms/emdash/pull/4632) [`96945d3`](https://github.com/emdash-cms/emdash/commit/96945d3ec0d7bfe6cb887171648029121ef94451) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Updates `portableTextToProsemirror` so a video block's unset `provider`, `width` and `height` attributes are `null`, as in the admin editor, instead of `undefined`.

- [#4277](https://github.com/emdash-cms/emdash/pull/4277) [`26528bb`](https://github.com/emdash-cms/emdash/commit/26528bb0fd018472f9a2ccff880a0317ebca874a) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes `ctx.kv` values disappearing when a plugin with the same ID moves between `plugins: []` and `sandboxed: []`. **This storage migration requires a coordinated upgrade; it cannot be deployed as a rolling upgrade.**
  
  Both sandbox runners share the in-process KV store. A database migration copies existing non-`settings:` sandbox values and revisions without overwriting in-process values, warns about conflicting plugin IDs and keys, and retains the original sandbox rows for recovery. Uninstalling a marketplace or registry plugin with data deletion removes its shared KV values and settings; failed-install rollback preserves existing data, including partial writes made by an installation hook before it fails. Plugin-test KV fixtures and inspection use the shared store; use the settings inspection API for `settings:` keys.
  
  #### What should I do?
  
  1. Back up the database.
  2. Stop all application instances and plugin jobs that write to it.
  3. Upgrade `emdash` and your sandbox runner together, then build the site without starting it.
  4. Run `pnpm emdash migrate` against the reviewed database target.
  5. Resolve conflicting KV copies before plugins can write again.
  6. Start or deploy the upgraded site.
  
  Do not rely on default `auto` migrations for this upgrade: they start plugins immediately after migrating, leaving no conflict-review window. Mixed package versions are not automatically rejected. See the [plugin upgrade guide](https://docs.emdashcms.com/plugins/upgrading-sites/#plugin-kv-storage-when-changing-execution-mode) for target selection, recovery queries, and rollback instructions. Downgrading packages alone hides post-upgrade KV writes; restoring the pre-upgrade database backup discards all site changes made since it was taken.

- [#4709](https://github.com/emdash-cms/emdash/pull/4709) [`a107170`](https://github.com/emdash-cms/emdash/commit/a1071707495a162c509f4594eed48fe09ca84b53) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes WordPress WXR and plugin imports discarding dates on posts imported as drafts. Publishing those posts now keeps the imported date and date-based permalink. This also applies to genuine WordPress drafts with a source date, including the local-date fallback, rather than dating them at first publication in EmDash. Posts scheduled for a future date still get their publication date from the final schedule. WordPress missed schedules remain drafts and keep their past source date when published.

- [#4604](https://github.com/emdash-cms/emdash/pull/4604) [`c77bfb1`](https://github.com/emdash-cms/emdash/commit/c77bfb16c6df734523f4f7059048a46ea25f3b1e) Thanks [@dmythro](https://github.com/dmythro)! - Fixes the Categories, Tags, Recent Posts and Archives widgets showing visitors the default language on translated pages. They now list the terms, posts and months of the page's own locale, as signed-in editors already saw, and link under that locale, such as `/en/category/news`, `/en/archives/2025/01` and `/en/posts/museum-news`. A Recent Posts `urlTemplate` gets the locale prefix too, after Astro's `base` when the template starts with it, unless the template already has the prefix.
  
  Recent Posts links to translated posts change from `/posts/en/museum-news` to `/en/posts/museum-news`, the shape Astro's locale routing and the EmDash templates use.

- [#3765](https://github.com/emdash-cms/emdash/pull/3765) [`776c95e`](https://github.com/emdash-cms/emdash/commit/776c95e9afb4730a887c1266ff36e6d466e089b3) Thanks [@maikunari](https://github.com/maikunari)! - Adds the `emdash import wordpress` command that the WordPress migration guide refers to. It converts a WordPress WXR export into JSON files on disk. This release also fixes `emdash --version` and `emdash --help` reporting `v0.0.0` instead of the installed version.
  
  Analyze the export first, review the generated `migration-config.json`, then convert the content:
  
  ```sh
  npx emdash import wordpress export.xml
  npx emdash import wordpress export.xml --execute
  ```
  
  Converted entries, a redirect map, downloaded attachments, and a progress file are written to `./wordpress-import` unless you pass `--output-dir`. After an interruption, run the command again with `--resume` to skip entries and attachments that were already converted. The analysis step does not overwrite an existing `migration-config.json` unless you pass `--force`. Attachments keep their path below `wp-content/uploads` inside the media directory, and scheduled WordPress posts are converted with the status `scheduled` and a `scheduledAt` date. `--skip-media` leaves attachments out, and `--dry-run` reports the files a step would write. The command does not write to an EmDash database; the admin importer remains the way to import WordPress content into a site.

- [#4601](https://github.com/emdash-cms/emdash/pull/4601) [`44daa08`](https://github.com/emdash-cms/emdash/commit/44daa081c1e3c4428f791e0f27594bc5aed6d0fa) Thanks [@dmythro](https://github.com/dmythro)! - Fixes WordPress WXR file imports creating a new guest byline for the same author every 30 posts. An author who is not mapped to a user now gets one byline for the whole file import, so their posts are no longer split between `author`, `author-2`, `author-3` and so on. Imports through the WordPress plugin connector (EmDash Exporter) are not yet covered by this fix.

- [#4592](https://github.com/emdash-cms/emdash/pull/4592) [`746db9f`](https://github.com/emdash-cms/emdash/commit/746db9f3ae5ebb734bbb59da96591e39bdbb49c3) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes WordPress menu links to custom post type entries disappearing from the site after an import through the EmDash Exporter plugin. Imported menu items now link to the collection the content was imported into.
  
  #### What should I do?
  
  Menus imported before this release are not repaired. Links to post types with a hyphen in their name, such as `team-member`, and to post types the import renames, such as `event`, `faq` and `testimonial`, can be missing from the site, together with their submenu items. If you imported through the exporter API (`/_emdash/api/import/wordpress-plugin/execute`) with your own `postTypeMappings`, links to any post type you mapped to a different collection can be missing too, `post` and `page` included.
  
  In the menu editor, an affected link's badge names a collection your content isn't in, such as `team-member` instead of `team_member`. Add each affected link again with **Add Content**. Deleting a link also deletes its submenu items, so first make the new link the **Parent** of the old link's submenu items. Then delete the old link.

- [#4666](https://github.com/emdash-cms/emdash/pull/4666) [`652d957`](https://github.com/emdash-cms/emdash/commit/652d9571e1f05e5bd5a997373a53ee317779b977) Thanks [@dmythro](https://github.com/dmythro)! - Fixes WordPress export file (WXR) imports leaving out menus. The admin said the WXR path imports menus, but the import created none, and the review screen didn't list them. The review screen now lists a file's menus by their names in WordPress, with the switch that exporter imports already have, and the import creates them with their nesting and with links to the imported pages and posts. An item without its own label shows the linked entry's title, as in WordPress. On a site translated with Polylang or WPML, each menu takes the language of the pages it links to. An item that links to a post type archive links to the archive of the collection that the post type was imported into. Items that link to a category or tag archive, to content the import left out, or to one of several pages that share a slug in the same collection and language are skipped and counted in the import result. So is a Polylang language switcher, which only Polylang can turn into language links. A menu that already exists under the same name and language is left as it is.
- Updated dependencies [[`c108e7b`](https://github.com/emdash-cms/emdash/commit/c108e7b03756005db7df404b0c6c916dc8463fd1), [`7bce592`](https://github.com/emdash-cms/emdash/commit/7bce59234985ed110beb063ce1d55a99d5d9a853), [`3d4faaf`](https://github.com/emdash-cms/emdash/commit/3d4faaff6c06005c5e9e5e046720b2fe502f5020), [`76f0f53`](https://github.com/emdash-cms/emdash/commit/76f0f53221c380cc77b73da5e455408dca720902), [`76f0f53`](https://github.com/emdash-cms/emdash/commit/76f0f53221c380cc77b73da5e455408dca720902), [`5a8c620`](https://github.com/emdash-cms/emdash/commit/5a8c6200a78a83bbde4c941a9b0c7f4b63e542a6), [`968a23e`](https://github.com/emdash-cms/emdash/commit/968a23e2a52e2033d33e57d657b031d88012dda1), [`1eedf99`](https://github.com/emdash-cms/emdash/commit/1eedf999dfc4bc119fc82f56b4d39165a46bd728), [`b42176d`](https://github.com/emdash-cms/emdash/commit/b42176dcb061c49cddb596c9fce501ed288c3bcc), [`8ce12b7`](https://github.com/emdash-cms/emdash/commit/8ce12b760dcf28319502617b6f7fc5b107fd41e2), [`e34b8fe`](https://github.com/emdash-cms/emdash/commit/e34b8fe5abc520c6ed450be5b624fc771a03bd1a), [`c2a6857`](https://github.com/emdash-cms/emdash/commit/c2a68573f82571fd21ecf172291c8c1bdd2d1ada), [`52b430c`](https://github.com/emdash-cms/emdash/commit/52b430c05924d9319e90756aff41a823a93b1971), [`76f0f53`](https://github.com/emdash-cms/emdash/commit/76f0f53221c380cc77b73da5e455408dca720902), [`84e173f`](https://github.com/emdash-cms/emdash/commit/84e173f1fb7aa4ec19ccd59ca327d9145822dc77), [`8d0250c`](https://github.com/emdash-cms/emdash/commit/8d0250c9cac044fc2fc897bd90115fea7ed42e78), [`6d5a10d`](https://github.com/emdash-cms/emdash/commit/6d5a10d0267846e71c7bf87aca02a376e07d2e7e), [`e737608`](https://github.com/emdash-cms/emdash/commit/e7376088f9a02a473753638ca71d3999d96f5f1b), [`73158ea`](https://github.com/emdash-cms/emdash/commit/73158eafddf3689a9a6e03c2d8232b3fcdaee5e3), [`0d5c65d`](https://github.com/emdash-cms/emdash/commit/0d5c65d4a1d4cacc553d79e547bb41ca2d98be8d), [`a499750`](https://github.com/emdash-cms/emdash/commit/a4997505cbf8d38f90168384f8e89b2359189a96), [`22b87ed`](https://github.com/emdash-cms/emdash/commit/22b87edc3f68ef173683a698af49275c5201d5fe), [`b766773`](https://github.com/emdash-cms/emdash/commit/b7667732bcee48ed094a3f363578b7d525bff212), [`213904f`](https://github.com/emdash-cms/emdash/commit/213904fe0f3b7b01161e74cfb6603906b2928ce9), [`2237d52`](https://github.com/emdash-cms/emdash/commit/2237d52c405228d5396fe4c72db48083530f7d79), [`7d48e95`](https://github.com/emdash-cms/emdash/commit/7d48e95c8b3b0d5f53a48ebbe5ee9f005035c610), [`cada545`](https://github.com/emdash-cms/emdash/commit/cada5450a080c107b8396430143288cd94b332ab), [`d891305`](https://github.com/emdash-cms/emdash/commit/d891305440e57b2ac3b90c0443d161783b2aef50), [`612569b`](https://github.com/emdash-cms/emdash/commit/612569b1cf590dd80ce5ca68a40046c6cca2ed1c), [`a17a4b3`](https://github.com/emdash-cms/emdash/commit/a17a4b34bd59f6a5074dd061642760113dadb3aa), [`cdfd98d`](https://github.com/emdash-cms/emdash/commit/cdfd98d8ef532ece23312a1c254aa505858c4adb), [`c38a5d5`](https://github.com/emdash-cms/emdash/commit/c38a5d5af364fc7ae0f13a75b57754b7328e7168), [`871cbfa`](https://github.com/emdash-cms/emdash/commit/871cbfa09b920e3906373ef2cf1d36284f89ba55), [`46e0a54`](https://github.com/emdash-cms/emdash/commit/46e0a544bbe7865558463a9562889ba0850a7da7), [`4df65eb`](https://github.com/emdash-cms/emdash/commit/4df65eba3e4dd2f990c92f65a4748117182949d5), [`caca761`](https://github.com/emdash-cms/emdash/commit/caca7610831465967c5b84e3022fc4db43cac091), [`faeca6c`](https://github.com/emdash-cms/emdash/commit/faeca6cf873ce792359aeadfe4699534eafb06ed), [`2bd4a39`](https://github.com/emdash-cms/emdash/commit/2bd4a396c44284635e106f95a54d9e9a698ca218), [`252934b`](https://github.com/emdash-cms/emdash/commit/252934b888453fd18a72f9311e75d1a0bdc109dc), [`5a9f1bd`](https://github.com/emdash-cms/emdash/commit/5a9f1bdef6ab92a2c286264aba98eab94bc19b36), [`6331f6b`](https://github.com/emdash-cms/emdash/commit/6331f6b4ba2c9f9d6eac778c2ee311e9cbd79768), [`935cdc7`](https://github.com/emdash-cms/emdash/commit/935cdc7f956302da25105aafac9f35897a6b07fa), [`d6c56fc`](https://github.com/emdash-cms/emdash/commit/d6c56fcd98137b6e3d967ee7a374b6d6c46be502), [`752cbcd`](https://github.com/emdash-cms/emdash/commit/752cbcd4311bf12f394045dc75b9144b2b688aa4), [`b8886d9`](https://github.com/emdash-cms/emdash/commit/b8886d9476b922990ee1d50abb73facbbf2d131d), [`40c7657`](https://github.com/emdash-cms/emdash/commit/40c76576d82a0e7714ac99869971c3ae85f4fcfa), [`88e00fe`](https://github.com/emdash-cms/emdash/commit/88e00fedb114e3e98cd32d7b4889bfba3ae3c6c4), [`5652829`](https://github.com/emdash-cms/emdash/commit/5652829bd13e8a66583fcbf4ecbe1d1cd390de70), [`830578b`](https://github.com/emdash-cms/emdash/commit/830578be2ebf1c3192270978d38ade54583ea870), [`006cfc0`](https://github.com/emdash-cms/emdash/commit/006cfc0e024ed0b0dd9cd29e7726ac9706d19524), [`4e95f4f`](https://github.com/emdash-cms/emdash/commit/4e95f4f23d9efe288b255d5f94963f8f97dac27a), [`d4d149d`](https://github.com/emdash-cms/emdash/commit/d4d149d08c4d2aa4f18b5bbd8d15d496d6a69a76), [`5bcccb8`](https://github.com/emdash-cms/emdash/commit/5bcccb82465011d9229334bbb566984e9d5ed446), [`d3e3021`](https://github.com/emdash-cms/emdash/commit/d3e3021c6db69ba0eb08593df4fd2353f3b858c1), [`c9696af`](https://github.com/emdash-cms/emdash/commit/c9696af9d29514666c37c358ae700b2122cc06e9), [`34fc9e0`](https://github.com/emdash-cms/emdash/commit/34fc9e0781e0254e6aa950fdda50ea0b7338616e), [`22b87ed`](https://github.com/emdash-cms/emdash/commit/22b87edc3f68ef173683a698af49275c5201d5fe), [`faeca6c`](https://github.com/emdash-cms/emdash/commit/faeca6cf873ce792359aeadfe4699534eafb06ed), [`8b484aa`](https://github.com/emdash-cms/emdash/commit/8b484aa92e0dc7c644563eb79e7635293c9d0e2d), [`372bafa`](https://github.com/emdash-cms/emdash/commit/372bafaeb75148997edff09b9312e722a80534e4), [`9db2de8`](https://github.com/emdash-cms/emdash/commit/9db2de8db3cf896d350eabdc91de663b481cbda3), [`532e78b`](https://github.com/emdash-cms/emdash/commit/532e78bc3604b43cf9f51c3ed6e586f2f9d6ed68), [`089716d`](https://github.com/emdash-cms/emdash/commit/089716d3ff85785c5d81e7fd6aee45547dbe1893), [`c0930c3`](https://github.com/emdash-cms/emdash/commit/c0930c335f35678a2bb75371ca041765a4e600b7), [`a3fc555`](https://github.com/emdash-cms/emdash/commit/a3fc555ef0eedf0e562abb7b1a3885c21f353d54), [`284fa80`](https://github.com/emdash-cms/emdash/commit/284fa8049a29113c5f400e2780b002169994ba56), [`25574da`](https://github.com/emdash-cms/emdash/commit/25574da51e580b95799a0ec3d43f680730d33f5f), [`1cf644e`](https://github.com/emdash-cms/emdash/commit/1cf644ef37a5dfb8d5c471d8e42b77ed90bb9ffc), [`96945d3`](https://github.com/emdash-cms/emdash/commit/96945d3ec0d7bfe6cb887171648029121ef94451), [`a5223a9`](https://github.com/emdash-cms/emdash/commit/a5223a96122c4676650c464935b728e25b3d1480), [`e21e01e`](https://github.com/emdash-cms/emdash/commit/e21e01e5eb3b57de6a8c6c4531ca5fe184985114), [`eefe351`](https://github.com/emdash-cms/emdash/commit/eefe351616cddda020eae4a8b445a6606cf5a17b), [`65b1679`](https://github.com/emdash-cms/emdash/commit/65b1679a84a5af6dcc2e951a5064a21e2353c843), [`bb15813`](https://github.com/emdash-cms/emdash/commit/bb158132b8a8b0b9fc863ccc72bbb931618a888f), [`98d16d8`](https://github.com/emdash-cms/emdash/commit/98d16d874341c10512c1b5e9d573d2b5ee3da50e), [`93ad617`](https://github.com/emdash-cms/emdash/commit/93ad617386836c029eeb5dd5a83f9ba5b2ea7bf2), [`34ff31a`](https://github.com/emdash-cms/emdash/commit/34ff31af2aa096d948ed5657cc409b679df393a9), [`a3da98d`](https://github.com/emdash-cms/emdash/commit/a3da98dd10ad3b374db536e0b2a1b94ca8bce41e), [`652d957`](https://github.com/emdash-cms/emdash/commit/652d9571e1f05e5bd5a997373a53ee317779b977)]:
  - @emdash-cms/admin@1.5.0
  - @emdash-cms/blocks@1.5.0
  - @emdash-cms/gutenberg-to-portable-text@1.5.0
  - @emdash-cms/auth@1.5.0
  - @emdash-cms/plugin-types@0.6.1
  - @emdash-cms/registry-lexicons@0.7.1
  - @emdash-cms/registry-verification@0.3.5
  - @emdash-cms/registry-client@0.7.2

## 1.4.0

### Minor Changes

- [#3856](https://github.com/emdash-cms/emdash/pull/3856) [`064fbbf`](https://github.com/emdash-cms/emdash/commit/064fbbfe00a9f3b8c2fdea8b0b1abec43e785505) Thanks [@swissky](https://github.com/swissky)! - Adds `admin.hiddenNavItems` to hide built-in admin areas a site doesn't use. Set it to any of `calendar`, `media`, `comments`, `menus`, `redirects`, `widgets`, `sections`, `bylines`, and `import`, for example `admin: { hiddenNavItems: ["comments", "redirects"] }`. Hidden areas disappear from the sidebar and the command palette. On the dashboard, listing `media` hides the Upload Media button, and listing `calendar` keeps the Scheduled count but removes its link to the calendar. The pages and API routes stay reachable for users with the required role. An unknown name fails the build.

### Patch Changes

- [#4364](https://github.com/emdash-cms/emdash/pull/4364) [`75030fc`](https://github.com/emdash-cms/emdash/commit/75030fc48cff39d5925367295c9072b038bca11f) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes translating a menu on Cloudflare D1, which failed for larger menus and left an empty translated menu behind. On D1, translating or deleting a menu and reordering or replacing its items now either save completely or leave the menus unchanged.
  
  #### What should I do?
  
  If translating a menu failed before, delete the empty translated menu it left behind, then translate the menu again.

- [#4167](https://github.com/emdash-cms/emdash/pull/4167) [`ec973c0`](https://github.com/emdash-cms/emdash/commit/ec973c06c216c8e81dae77848f476982649b29f5) Thanks [@cyface](https://github.com/cyface)! - Fixes extra database round trips on `getEmDashEntry` and `getEmDashCollection` for sites that register byline custom fields or have entries with an author but no explicit byline credit. These reads now resolve bylines from the content query itself and load custom-field values in one batched step, instead of re-reading every entry's credits. On Cloudflare D1, a page that reads a few entries saves two to six sequential queries.

- [#4287](https://github.com/emdash-cms/emdash/pull/4287) [`ceaf9b6`](https://github.com/emdash-cms/emdash/commit/ceaf9b68bdeca07dcaf3484b79e211241931a471) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes expired OAuth tokens and unused login codes from `emdash login` and MCP clients staying in the database forever. Scheduled cleanup now deletes them after they expire.

- [#4286](https://github.com/emdash-cms/emdash/pull/4286) [`3d29980`](https://github.com/emdash-cms/emdash/commit/3d29980290fd2ebcbe9ce7d53808b17c4aa65190) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes lost edits on D1, Durable Objects and PostgreSQL when two saves of the same entry, both based on the same version, arrive at once, for example from two MCP clients or from scripts using `emdash content update --rev`: both reported success, and the first was silently overwritten. The second save now returns `409 CONFLICT`, the same response a save based on an outdated version already gets.

- [#4459](https://github.com/emdash-cms/emdash/pull/4459) [`9d9fd82`](https://github.com/emdash-cms/emdash/commit/9d9fd82c50986496809e9e5c414569c13210f1bb) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes `POST /_emdash/api/oauth/token` returning uppercase `INVALID_GRANT` for refresh-token and device-code failures. These responses now use the RFC-standard `invalid_grant` code so OAuth clients can recognize rejected grants and restart authorization.

- [#4243](https://github.com/emdash-cms/emdash/pull/4243) [`3ce9d36`](https://github.com/emdash-cms/emdash/commit/3ce9d368e1c7cab41aa5ab6d58d2ad5636d9dead) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fixes Cloudflare-cached pages remaining outdated after content is deleted or unpublished. Pages using EmDash cache hints no longer send an automatic `Last-Modified` header, so Cloudflare stops answering `304 Not Modified` based on an entry timestamp that does not cover related lists or settings changes. This applies to entry, collection, publication-date, and reference-list hints. Sites using an object cache reload those content snapshots once after upgrading so cached validators from earlier versions are not reused.
  
  Taxonomy definitions and collection-to-taxonomy mappings also revalidate in the background after 30 seconds, so long-lived server processes pick up changes saved elsewhere without adding a blocking query to each render. A failed refresh retains the last good snapshot.
  
  #### What should I do?
  
  `cacheHint.lastModified` is no longer populated automatically. For an entry's displayed modification date, use `entry.data.updatedAt` instead; it is not a validator for the whole page.
  
  Pages relying on automatic validators also lose Astro's implicit `Cache-Control: no-cache` header. Set your own browser `Cache-Control` if you need a fresh check on every visit. If you want conditional requests, supply a custom `lastModified` hint to `Astro.cache.set()`. Its timestamp must advance whenever any part of the response changes, including settings, related entries, deletions, and unpublishes.

- [#4157](https://github.com/emdash-cms/emdash/pull/4157) [`8da0792`](https://github.com/emdash-cms/emdash/commit/8da0792564d06cf2411eee2bcbb832d7a1cdfc5c) Thanks [@opariffazman](https://github.com/opariffazman)! - Fixes external auth providers, such as Cloudflare Access, writing the session store on every authenticated `/_emdash` request. EmDash now writes the session only when the signed-in user differs from the stored one, so sites on Cloudflare no longer spend one Workers KV write per request, which could exhaust the Workers Free plan's daily write limit and hit KV's one-write-per-second limit on a key for parallel requests.

- [#3192](https://github.com/emdash-cms/emdash/pull/3192) [`c238da2`](https://github.com/emdash-cms/emdash/commit/c238da2931b12ab58f6228a5a4d79551d05f6d3b) Thanks [@bazemoreb](https://github.com/bazemoreb)! - Names media downloads after the file that was uploaded. The public media file route previously sent `Content-Disposition: attachment` with no `filename`, so browsers fell back to the last path segment of the URL and saved every PDF, DOCX or CSV under its storage key. The route now looks the original filename up by storage key and emits both the quoted ASCII `filename` and the RFC 5987 `filename*` form, so non-ASCII names survive.
  
  Media with no matching database row is served exactly as before, and a failed lookup never fails the download.

- [#3129](https://github.com/emdash-cms/emdash/pull/3129) [`a6f4091`](https://github.com/emdash-cms/emdash/commit/a6f4091c056df606b98340b566916cf44e99b567) Thanks [@eisenbruch](https://github.com/eisenbruch)! - Fixes saving an entry turning an empty image or file field (`""`) into `{ "provider": "external", "id": "", "src": "" }`. A blank image or file field, or a blank image inside a repeater, is now saved as `null`, the canonical empty value. Entries with no image stop changing on every save after that.
  
  A required image or file field now returns a validation error for `""` instead of saving an empty image. This only affects API, MCP or import clients, because the admin never sends `""`.

- [#4296](https://github.com/emdash-cms/emdash/pull/4296) [`f197acf`](https://github.com/emdash-cms/emdash/commit/f197acf3abdac8bde0f67fc3e87ae26559dab67c) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes media usage tracking in collections that have a reference field named `title` or `name`, where saving an entry recorded none of the images and files it uses. Saving now records them.
  
  #### What should I do?
  
  Entries in those collections that were saved before this release can still be missing from **Used in** after you upgrade. Open **Settings → Media usage tracking** and wait until it shows **Ready**. If it shows **Needs attention** instead, repair each affected collection once:
  
  ```sh
  npx emdash media repair-usage --collection <collection>
  ```

- [#4285](https://github.com/emdash-cms/emdash/pull/4285) [`57abb5c`](https://github.com/emdash-cms/emdash/commit/57abb5c445e0627acff748999e2ca35b75d1e102) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes menus showing dead links to entries that are in the trash or not published. `getMenu()` leaves those items out. Any item `getMenu()` leaves out now takes its child items with it, instead of moving them to the top level of the menu. In edit mode, menus still link to unpublished entries. With the object cache enabled, a cached menu now refreshes when an entry or taxonomy term it links to changes.

- [#4365](https://github.com/emdash-cms/emdash/pull/4365) [`e1c4a87`](https://github.com/emdash-cms/emdash/commit/e1c4a87a7b3c634b96d7274dbd728975b9382b05) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes creating a child menu item through the menu items API on PostgreSQL. A request with a `parentId` and no `sortOrder` failed; the item is now placed after its existing siblings.

- [#4208](https://github.com/emdash-cms/emdash/pull/4208) [`bed3e42`](https://github.com/emdash-cms/emdash/commit/bed3e421e02429f51c2717fe0aa90ea5340ff921) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes content list search, in the admin and through the content list API's `q` parameter, failing when the collection has a reference field named `title` or `name`. The search now leaves out a reference field bound to a relation and matches the entry's other fields.

- [#4205](https://github.com/emdash-cms/emdash/pull/4205) [`4409acb`](https://github.com/emdash-cms/emdash/commit/4409acb10736c2bf8031bbf29c761dc594e919ed) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes entry creation, entry saves and content-list search failing with `no such column` in a collection that has a reference field marked `searchable`. Adding such a field to a search-enabled collection failed, and after a seed turned search on, creating or saving any entry in that collection failed. Site search and content-list search now ignore the `searchable` flag on a reference field bound to a relation.
  
  #### What should I do?
  
  If creating or saving entries in a collection still fails after upgrading and the server log shows `no such column`, open the collection under **Content Types**, untick **Search** and save, then tick it again and save. This rebuilds the collection's search index.

- [#4386](https://github.com/emdash-cms/emdash/pull/4386) [`53acf71`](https://github.com/emdash-cms/emdash/commit/53acf7159f405786d484b35288f5effb6ffb81be) Thanks [@Stormster](https://github.com/Stormster)! - Fixes entry slugs being generated from a field named `title` instead of the collection's configured title field. In a collection whose `titleField` is `name` and which also has a `title` field (a person's job title, say), typing in the editor now fills the slug from the name, and entries created through the API without a slug get one from the name too, so two people with the same job title no longer collide with `SLUG_CONFLICT`. Collections without a `titleField` keep the previous `title`, then `name`, order.

- [#4394](https://github.com/emdash-cms/emdash/pull/4394) [`6be7263`](https://github.com/emdash-cms/emdash/commit/6be726348b2414e95dec6eb910680e215bb9abbb) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes sandboxed plugin `ctx.taxonomies` mutations (`createTerm()`, `addEntryTerms()`, and `removeEntryTerms()`), `ctx.content.create()`, versioned content actions (`getVersioned()`, `publish()`, `unpublish()`, `schedule()`, `unschedule()`, `getTrashedVersioned()`, and `restore()`), and `ctx.comments.setStatus()` on Cloudflare when requests run across multiple Worker isolates. Content creation consistently uses runtime validation and hooks and preserves `translationOf` links instead of falling back to a plain database insert.
  
  Runner-created invocations without a content-create callback now receive `Content creation is not configured` rather than a database insert that bypasses runtime behavior. `createPluginTestHost()` supplies a database-backed callback with content-handler validation so transport-level tests can continue creating content and linked translations without starting the full EmDash runtime. It preserves the transport host's support for `data.slug` and `data.status`.
  
  Await these operation promises before returning from a plugin route or hook. Their RPC connection now lasts only for that invocation; unlike the previous loopback binding, it cannot support work that outlives the invocation.
  
  Publication after-hooks remain deferred. Same-entry actions attempted while an after-hook is running can return `CONTENT_ACTION_REENTRANT`; faster callback routing can expose this overlap in tests that assumed hooks had already finished. In runtime-host tests, call `await host.waitForDeferredTasks()` after an action before inspecting its after-hook effects or starting another action on the same entry. This method waits for queued deferred runtime work, including work those tasks enqueue; it does not run future scheduled tasks or wait for arbitrary unawaited plugin operations.

- [#4380](https://github.com/emdash-cms/emdash/pull/4380) [`9e7cd3d`](https://github.com/emdash-cms/emdash/commit/9e7cd3ddf5faa76b54d2db223081f506de57b1e7) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes `emdash site import` failing with `COLLECTION_EXISTS` when manually deleted target collections still have media-usage cleanup pending. For these manually deleted collections, import now runs as many cleanup steps as the request budget allows, then imports the collection in the same request if enough budget remains. It waits for active deletion leases or retry delays before reusing a slug. Cancellation during this per-collection cleanup stops before importing the collection. Failed cleanup of a manually deleted collection includes recovery instructions, and collection schema error messages are preserved in status `errorDetail`.

- [#4276](https://github.com/emdash-cms/emdash/pull/4276) [`a16ab2c`](https://github.com/emdash-cms/emdash/commit/a16ab2c2b3f2d6e97bdcca3ab32015d9194d6554) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes site builds using `zustand/traditional` or other dependencies that default-import `use-sync-external-store` shims, which previously failed with a missing default export error.

- [#4396](https://github.com/emdash-cms/emdash/pull/4396) [`9201138`](https://github.com/emdash-cms/emdash/commit/92011387eb2fee065e54f7d4b2c20405d1a3e347) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes keyboard navigation and entrance animations in the admin and visual editor's floating toolbars with Tiptap 3.20.3 and later. Escape closes image alt-text editing, Shift+Tab returns to the caption, and arrow keys move between toolbar controls again.

- [#3279](https://github.com/emdash-cms/emdash/pull/3279) [`d1e25e0`](https://github.com/emdash-cms/emdash/commit/d1e25e01fdcfed9d05e7dc42f9f3f2500cf96700) Thanks [@eisenbruch](https://github.com/eisenbruch)! - Fixes the visual editing toolbar's "Open in admin" so each entry gets its own admin window. The window name was a single constant shared by the whole site, so opening the admin for one entry navigated away from another already open in that tab. A repeat click on the same entry still reuses that entry's window.

- [#3596](https://github.com/emdash-cms/emdash/pull/3596) [`6c5d878`](https://github.com/emdash-cms/emdash/commit/6c5d87831c4e0ed3976ac6d449e37952c4387a61) Thanks [@swissky](https://github.com/swissky)! - Caches widget areas in the object cache. With an object cache configured, `<WidgetArea>`, `getWidgetArea()`, `getWidgetAreaWithCacheHint()` and `getWidgetAreas()` no longer query the database on each page load. Widget changes made in the admin, by seeding or by a site transfer invalidate the cached areas; code that writes the widget tables directly should call the new `invalidateWidgetObjectCache()` export.

- [#3890](https://github.com/emdash-cms/emdash/pull/3890) [`56cb9da`](https://github.com/emdash-cms/emdash/commit/56cb9dab91c2798c147dc6482aa2db62d0f6f7f1) Thanks [@swissky](https://github.com/swissky)! - Fixes importing WordPress custom post types with a hyphen in their name (such as `team-member`) through the EmDash Exporter plugin. The import created the `team_member` collection but then failed every entry with `Collection "team-member" does not exist`, and custom taxonomies for that post type were not linked to the collection. The review step now shows the collection the import will use and recognizes it on a repeated import, so field type conflicts with it are reported. The `wxrSource` import source now suggests the same valid collection names, such as `team_member` for `team-member` and `wp_content` for a post type named `content`.
- Updated dependencies [[`6cc69bb`](https://github.com/emdash-cms/emdash/commit/6cc69bbdb06a7a31f3fea4f13096e25005840d71), [`3fcf437`](https://github.com/emdash-cms/emdash/commit/3fcf4377334a44f86f8f3289baf73c55b370fef0), [`064fbbf`](https://github.com/emdash-cms/emdash/commit/064fbbfe00a9f3b8c2fdea8b0b1abec43e785505), [`f0956f1`](https://github.com/emdash-cms/emdash/commit/f0956f1f050306442e2d801e0abaff229815a19b), [`500a45b`](https://github.com/emdash-cms/emdash/commit/500a45b4cd872401d809187cc5f3f9082b9717ab), [`2a62e8a`](https://github.com/emdash-cms/emdash/commit/2a62e8afb5b1661e6f6f00403076ac1339b8c980), [`5cd334e`](https://github.com/emdash-cms/emdash/commit/5cd334ed92d7ef9cefa64e8665f53350fba0f187), [`b82016d`](https://github.com/emdash-cms/emdash/commit/b82016d5b9f051b77689585ed0504b77e1929db4), [`0bc006c`](https://github.com/emdash-cms/emdash/commit/0bc006c8a2e3fb0f55ec587c997101eb0f87eb02), [`d840b08`](https://github.com/emdash-cms/emdash/commit/d840b087244bd3e79caa2ee0266ad3942ac677b7), [`a1a0174`](https://github.com/emdash-cms/emdash/commit/a1a0174f99ad4ca301e823bdea92b2a5f21e93c4), [`a6b28a6`](https://github.com/emdash-cms/emdash/commit/a6b28a6b1bf96f9ade9cc5c0327cd5b2e5af1ca2), [`e80c1f0`](https://github.com/emdash-cms/emdash/commit/e80c1f07f5baf7c6d26e6ef70cbbdf22a330e009), [`936a4cb`](https://github.com/emdash-cms/emdash/commit/936a4cb79ab24866cee3f669b9abe0daa5e70359), [`936a4cb`](https://github.com/emdash-cms/emdash/commit/936a4cb79ab24866cee3f669b9abe0daa5e70359), [`936a4cb`](https://github.com/emdash-cms/emdash/commit/936a4cb79ab24866cee3f669b9abe0daa5e70359), [`e80c1f0`](https://github.com/emdash-cms/emdash/commit/e80c1f07f5baf7c6d26e6ef70cbbdf22a330e009), [`190022c`](https://github.com/emdash-cms/emdash/commit/190022cbd71a20d06c856cf5673acb0b2d2d9f1f), [`9e720d6`](https://github.com/emdash-cms/emdash/commit/9e720d686c9d0ea651b1be044197d00d0e95d185), [`2ed2755`](https://github.com/emdash-cms/emdash/commit/2ed27550881c89603a45f6e2212e62209c5a7ac9), [`229c64b`](https://github.com/emdash-cms/emdash/commit/229c64ba737fcb6e4e2db9a3da4b8975f01d29bb), [`d60c43c`](https://github.com/emdash-cms/emdash/commit/d60c43c5bafa16699eeafd6a6329d3f9927f85f6), [`dd0bc9e`](https://github.com/emdash-cms/emdash/commit/dd0bc9eb04fab475253e375d116e533b81efb87e), [`4e4b068`](https://github.com/emdash-cms/emdash/commit/4e4b06829225b27df0224b584f8ccc517de5fd5c), [`0bc23ad`](https://github.com/emdash-cms/emdash/commit/0bc23ad0f0e073eab3d6ce16decce49c815364d4), [`7a04c81`](https://github.com/emdash-cms/emdash/commit/7a04c81372d5ab1f3cdb420a19cd2d857a57e56d), [`046ec3c`](https://github.com/emdash-cms/emdash/commit/046ec3c9cef712fceefbd6576734d15ecaee4a12), [`15557d1`](https://github.com/emdash-cms/emdash/commit/15557d1ee7c41a8efb3906fc3b58e68086f8fb7d), [`2e103a4`](https://github.com/emdash-cms/emdash/commit/2e103a45aa1b680318022c59e8cc0af0629c3ca3), [`245a562`](https://github.com/emdash-cms/emdash/commit/245a5623ad1fbb30df2be4db4282d5229db7687e), [`fa46578`](https://github.com/emdash-cms/emdash/commit/fa465787470aff612103213232992c9df3fdf00a), [`585cd22`](https://github.com/emdash-cms/emdash/commit/585cd222e1279f7055b6559540f0b2285dee8abd), [`e847d4b`](https://github.com/emdash-cms/emdash/commit/e847d4b61902757a6d829058e7d6afc6c4d0691e), [`e6ee72f`](https://github.com/emdash-cms/emdash/commit/e6ee72f9e4301c1e5298a364fda9b8c1bf492f7e), [`53acf71`](https://github.com/emdash-cms/emdash/commit/53acf7159f405786d484b35288f5effb6ffb81be), [`0709277`](https://github.com/emdash-cms/emdash/commit/070927753e19cfc5fd2bb9342947bb2b2a5185ac), [`6094ff8`](https://github.com/emdash-cms/emdash/commit/6094ff8a9743ecfd5e86ec54b5273094736a8cea), [`d160cb0`](https://github.com/emdash-cms/emdash/commit/d160cb04e0060658fa56a8e4de4be024204b63e8), [`20a5923`](https://github.com/emdash-cms/emdash/commit/20a5923a4073b1bab5442b86d42c2540ba5bd312), [`9201138`](https://github.com/emdash-cms/emdash/commit/92011387eb2fee065e54f7d4b2c20405d1a3e347), [`26c4faf`](https://github.com/emdash-cms/emdash/commit/26c4faff448a98c33f0af2e369c1fe822d882e17), [`3ad08dc`](https://github.com/emdash-cms/emdash/commit/3ad08dc041ab1ea728926a2267c55a27bc52e933)]:
  - @emdash-cms/admin@1.4.0
  - @emdash-cms/blocks@1.4.0
  - @emdash-cms/auth@1.4.0
  - @emdash-cms/gutenberg-to-portable-text@1.4.0
