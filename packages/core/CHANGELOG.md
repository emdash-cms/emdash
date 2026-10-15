# emdash

<!-- emdash-changelog-archive: ./changelog/0.39.1-to-0.42.0.md -->

## 1.2.0

### Minor Changes

- [#3056](https://github.com/emdash-cms/emdash/pull/3056) [`b92f2d6`](https://github.com/emdash-cms/emdash/commit/b92f2d653689984b804998633276d1bdd7ccec89) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Adds an `admin.locales` option that limits the admin interface to the languages a site uses, which makes the admin bundle smaller.
  
  ```js
  emdash({
  	admin: { locales: ["en", "de"] },
  });
  ```
  
  Only the listed languages are built into the admin and offered in its language switcher. Users whose preferred languages aren't listed see English. `en` is always included as the fallback, even when the list leaves it out, so `admin: { locales: ["en-GB"] }` still ships English alongside British English. A code the admin doesn't ship fails the build, and the error lists the available codes. Sites that don't set the option keep every language.

- [#3877](https://github.com/emdash-cms/emdash/pull/3877) [`5f69896`](https://github.com/emdash-cms/emdash/commit/5f69896ade7567f8af99373ef655046d6b823518) Thanks [@swissky](https://github.com/swissky)! - Updates the admin user editor to show the name as read-only, with a hint to change it at the identity provider, when an external auth provider such as Cloudflare Access syncs names (the default). Previously the field looked editable, but the change was replaced on that user's next request. Set `syncName: false` in the provider config to make names editable again.

- [#3744](https://github.com/emdash-cms/emdash/pull/3744) [`1e275ae`](https://github.com/emdash-cms/emdash/commit/1e275ae8b4f1a2766c2f29d2efa8d5a8492233d6) Thanks [@swissky](https://github.com/swissky)! - Adds a **Change domain** dialog to **Settings > General** for moving a site to a new domain. Before it changes the **Site URL**, EmDash checks that the new domain serves the site. Links in emails and plugins, sitemaps, `robots.txt`, hreflang links, social image URLs, and canonical links set in the SEO panel then use the new domain. If the check can't reach the site, for example on `localhost` or behind a login, the dialog offers to store the address without the check.
  
  The **Site URL** field becomes read-only, and saving **Settings > General** no longer writes it. When `siteUrl`, `EMDASH_SITE_URL`, or `SITE_URL` is set, the page names that address, which links in emails and plugins keep using.
  
  Passkeys only work at the address where they were created. After a move, keep signing in at the old address, or sign in at the new one with an email link and add a passkey there.

- [#3697](https://github.com/emdash-cms/emdash/pull/3697) [`0742f27`](https://github.com/emdash-cms/emdash/commit/0742f27408d14bfba8477063f36c26357483cedc) Thanks [@swissky](https://github.com/swissky)! - Adds a `labels` prop to the `Comments` and `CommentForm` components from `emdash/ui/comments`, so sites can translate the comment heading, member badge, Like button, form fields, submit button, and status messages. Keys you leave out keep their English defaults.
  
  `Comments` now formats comment dates in the page locale (`Astro.currentLocale`) instead of always using `en-US`, and accepts a `locale` prop to override it. Sites without Astro i18n routing still show `en-US` dates; pass `locale="en-US"` to keep the previous format on a localized site.
  
  After a successful submission, `CommentForm` now says "Comment published" when the comment is approved immediately and "Comment submitted for review" when it waits for moderation, instead of always showing "Comment submitted!".

- [#3744](https://github.com/emdash-cms/emdash/pull/3744) [`1e275ae`](https://github.com/emdash-cms/emdash/commit/1e275ae8b4f1a2766c2f29d2efa8d5a8492233d6) Thanks [@swissky](https://github.com/swissky)! - Adds an **Email users** action to **Settings > General** that tells every other active user where the site now lives. Each user gets an email with a button to the sign-in page at the configured `siteUrl`, or the **Site URL** when none is set, and a note that passkeys from the old address don't work there. The email does not sign anyone in. The action needs an email provider, passkey sign-in, and the `users:manage` permission, and shows how many emails were sent and how many the provider rejected.
  
  The emails come from the new `POST /_emdash/api/settings/domain/notify` endpoint. It accepts signed-in sessions only and can be used 3 times per hour per site.

- [#3827](https://github.com/emdash-cms/emdash/pull/3827) [`373446f`](https://github.com/emdash-cms/emdash/commit/373446f973d33703718f2f0c22322548fad6ab1a) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Adds a video block to the rich text editor. Type `/video` to choose a Media Library video or upload one. Closing the picker leaves an empty video block in place, which you can fill later by clicking it or dropping a video file on it. Video files dropped or pasted anywhere in the text also upload to the Media Library and appear where you dropped them. The video plays in the editor at the width of the text, with a caption field under it and **Replace video** and **Delete video** in its corner. A video's **Used in** tab in the Media Library lists the entries that use it in a video block.
  
  On the site, `Video` from `emdash/ui` renders the `video` block as the browser's own player with its caption. Media Library videos play from your storage's public URL when one is configured, and need the block's `asset.url`: a block without one renders nothing on the site, and the editor shows it as unplayable. A block whose `asset.provider` names a media provider renders from that provider's embed. An empty video block is saved without `asset` and renders nothing.
  
  Uploads follow `maxUploadSize`, 50 MiB by default. The admin's content security policy now allows media from `blob:` and `https:` URLs (`media-src 'self' blob: https:`), as it already did for images. This lets the admin read a video's size before uploading it, and preview a video block whose `asset.url` is on another site. Before, videos uploaded from the admin in production were saved without a width and height.
  
  #### What should I do?
  
  - If a plugin already defines a `video` block, the editor keeps using the plugin's block: it doesn't offer the built-in Video block, and dropped video files aren't uploaded. On the site, the plugin's renderer still wins; a plugin without one gets `Video` for blocks that have only the built-in fields. In TypeScript, narrowing `PortableTextBlock` on `_type === "video"` now gives `PortableTextVideoBlock | PortableTextUnknownBlock`, so reading the plugin's own fields needs a check.
  - If you edit Portable Text with `portableTextToProsemirror` and `prosemirrorToPortableText` from `emdash` in your own TipTap editor, add a `videoBlock` node with the attributes `src`, `mediaId`, `provider`, `caption`, `width` and `height` to its schema. `portableTextToProsemirror` turns every built-in video block into that node, and a schema without it can't load the document.
  - The media usage API and `emdash/client` can now return the reference type `"portable_text_video"` for a video used in a video block. Code that checks every reference type, or validates the list, needs to accept it.
  - With Astro's content security policy turned on and media on another host, allow that host in `media-src`.

- [#3875](https://github.com/emdash-cms/emdash/pull/3875) [`0a17191`](https://github.com/emdash-cms/emdash/commit/0a171919fd68507516f6a50c951336817b25165f) Thanks [@swissky](https://github.com/swissky)! - Adds a `syncName` option to external auth providers such as Cloudflare Access. By default, EmDash still replaces a user's name with the provider's name on every authenticated request, so a name edited in the admin is restored on that user's next request. Set `syncName: false` to keep names edited in the admin; the provider's name is then used only when the user is first provisioned.
  
  ```js
  auth: access({
  	teamDomain: "myteam.cloudflareaccess.com",
  	syncName: false,
  }),
  ```

- [#3773](https://github.com/emdash-cms/emdash/pull/3773) [`e6fe5d4`](https://github.com/emdash-cms/emdash/commit/e6fe5d498a527b5e6bd6cbc80ee5220ce626673c) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Adds numbered pages to every collection list in the admin. The All and Trash tabs load one page of entries at a time, so a collection opens with 20 entries instead of fetching 100, and both tabs use the Media Library's pagination footer pinned to the bottom of the screen: the entry range, 20, 50, or 100 entries per page, and controls to jump to any page. The Trash badge counts every trashed entry instead of stopping at 50, and every trashed entry is reachable.
  
  Selections persist across pages. Changing the search, a filter, the locale, or the collection clears them.
  
  `GET /_emdash/api/content/{collection}` and `GET /_emdash/api/content/{collection}/trash` accept a 1-based `page` parameter instead of `cursor`. A numbered page returns `total` and no `nextCursor`, and sending both `page` and `cursor` returns a `400` validation error. Cursor pagination is unchanged.
  
  `ContentList` accepts optional `pagination` and `trashPagination` props for numbered pages; without them it behaves as before.

- [#3744](https://github.com/emdash-cms/emdash/pull/3744) [`1e275ae`](https://github.com/emdash-cms/emdash/commit/1e275ae8b4f1a2766c2f29d2efa8d5a8492233d6) Thanks [@swissky](https://github.com/swissky)! - Adds a **Continue on** button to **Settings > General** after a site moves to a new domain. Passkeys only work at the address where they were created, so a user signed in at the old address can select the button to sign in at the new one without email. The single-use link expires after 5 minutes and opens **Settings > Security**, ready to add a passkey for the new address. The button appears when you are signed in at an address other than the **Site URL**, or the configured `siteUrl` when one is set. It is not shown when an external provider such as Cloudflare Access handles sign-in.
  
  The link comes from the new `POST /_emdash/api/auth/handover` endpoint, which accepts signed-in sessions only and allows 5 links per user every 5 minutes. `GET /_emdash/api/settings/domain` now also returns `siteOrigin`, the address the link points to.
  
  `@emdash-cms/auth` exports `createMagicLinkUrl()`, which creates a single-use sign-in link without sending an email.

### Patch Changes

- [#3781](https://github.com/emdash-cms/emdash/pull/3781) [`d22f62f`](https://github.com/emdash-cms/emdash/commit/d22f62fb46844e377eec4fd331f5071df3d76467) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fixes locally stored images being served as unoptimized originals on sites that set their public origin with `EMDASH_SITE_URL` or `SITE_URL` instead of `siteUrl`, such as Node.js deployments behind an HTTPS reverse proxy. The variable must be set when `astro build` runs; a value set only in the runtime environment does not enable image optimization.

- [#3767](https://github.com/emdash-cms/emdash/pull/3767) [`04a3d8d`](https://github.com/emdash-cms/emdash/commit/04a3d8db8d1c88b889167a1567a5d7a2ef76332d) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes API token "Last used" dates and the cleanup of expired authentication and rate-limit records on Cloudflare Workers, where the Worker could stop before these writes finished. These writes now finish after the response is sent, and a failure is logged instead of ignored.

- [#3753](https://github.com/emdash-cms/emdash/pull/3753) [`36b46d9`](https://github.com/emdash-cms/emdash/commit/36b46d9431fac3787396b0db2d42474530a41e91) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fixes scheduled 404-log cleanup to run only when the table has grown past its cap. The check uses a bounded sample, so most cron ticks no longer scan the entire `_emdash_404_log` table when there is nothing to evict. This prevents the per-minute cleanup from consuming a large D1 row-read budget for tables that are below the limit.

- [#3762](https://github.com/emdash-cms/emdash/pull/3762) [`f09797c`](https://github.com/emdash-cms/emdash/commit/f09797c847778e29a697f83ae76f9e7f253cbdcf) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes WordPress imports turning tables in Classic editor posts into a single paragraph. Tables whose cells hold only text now import as tables, keeping their rows, header row, formatting and links. Tables with images, headings, lists or merged cells, with a caption or footer rows, or inside a `<div>` or `<figure>` keep their previous output.
  
  `gutenbergToPortableText()` also sets `hasHeaderRow: true` on tables whose first row holds only `<th>` cells.

- [#3802](https://github.com/emdash-cms/emdash/pull/3802) [`cd21162`](https://github.com/emdash-cms/emdash/commit/cd211628e602471c63cf3c46f1206722d1dd1de8) Thanks [@DiogoDuart3](https://github.com/DiogoDuart3)! - Fixes `getEmDashCollection()` returning published content in edit mode and preview, while `getEmDashEntry()` returned the draft. Lists now show each entry's draft revision to editors in edit mode, and the draft of the previewed entry to a preview link, so inline edits made on a list page no longer appear to revert after saving and previews of list pages show the changes. Other entries in a preview, and all public requests, still get published content.

- [#3631](https://github.com/emdash-cms/emdash/pull/3631) [`e3a9de3`](https://github.com/emdash-cms/emdash/commit/e3a9de322736de8398225225f5909bff07bf4e1e) Thanks [@DavidPivert](https://github.com/DavidPivert)! - Fixes `comment:afterCreate` hooks being cut short on Cloudflare Workers. The hooks for a new comment ran as fire-and-forget work that the host did not keep alive, so they could be cancelled as soon as the response was sent. Sandboxed plugins, which call back into the host for settings and email, were stopped at their first call and never ran: a plugin that emails admins about new comments sent nothing. These hooks now run through the host's `waitUntil`, after the response, until they finish.

- [#3381](https://github.com/emdash-cms/emdash/pull/3381) [`5b01664`](https://github.com/emdash-cms/emdash/commit/5b016649799b681a531d19be213abf7c97c7ad57) Thanks [@swissky](https://github.com/swissky)! - Fixes comment listings so a fractional `limit` no longer fails with a 500. The page size is rounded down to a whole number on the public comments endpoint, the moderation inbox, and plugin comment reads, and a non-numeric `limit` uses the default of 50.

- [#3785](https://github.com/emdash-cms/emdash/pull/3785) [`4b2b6e4`](https://github.com/emdash-cms/emdash/commit/4b2b6e4591abc8a4782399aecfc8b2755536fea2) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fixes `plugin:install` and `plugin:activate` never running for plugins registered in the `plugins` array of `astro.config.mjs`, so setup such as `ctx.cron.schedule()` in `plugin:activate` now takes effect.
  
  Each plugin's hooks run once, when the site first starts with that plugin. On existing sites, this happens on the first start after upgrading for every plugin in `plugins` that you have never enabled, disabled, or changed MCP access for in the admin. A `plugin:install` hook that is not safe to run on a site where the plugin is already in use will run then, so check your plugins before upgrading.
  
  If either hook throws, EmDash logs the error and disables the plugin instead of retrying on every start. Re-enable it from the Plugins page after fixing the problem; this runs `plugin:activate` again.

- [#3930](https://github.com/emdash-cms/emdash/pull/3930) [`47cb798`](https://github.com/emdash-cms/emdash/commit/47cb7985ec0d0dfc0643a15a64ba85c4700fd9ef) Thanks [@ryofukutani](https://github.com/ryofukutani)! - Fixes `PUT /_emdash/api/content/{collection}/{id}` so a save that carries `_rev` can no longer overwrite a change another writer saved while the request was being processed. The token was checked once against the first read of the entry, and a save that landed before the entry was read again for the write went unnoticed. The version used by the write is now checked against `_rev` as well, and a mismatch returns `409 CONFLICT`. Saves without `_rev` are unchanged.

- [#3911](https://github.com/emdash-cms/emdash/pull/3911) [`c4e6737`](https://github.com/emdash-cms/emdash/commit/c4e6737c937acacd240d634d6df116843ad0a6f1) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Load `EMDASH_ENCRYPTION_KEY` from the project `.env` into `process.env` during `astro dev`. This lets freshly scaffolded Node.js sites save plugin settings declared with `type: "secret"` without first exporting the `.env` file into the shell. Existing environment variables are honored and never overwritten; other EmDash variables are not copied so that `.env` values intended for production do not override generated dev values.

- [#3744](https://github.com/emdash-cms/emdash/pull/3744) [`1e275ae`](https://github.com/emdash-cms/emdash/commit/1e275ae8b4f1a2766c2f29d2efa8d5a8492233d6) Thanks [@swissky](https://github.com/swissky)! - Fixes email links pointing to the address a site was set up on after it moved to a new domain. Sign-in, invitation, self-signup, recovery, and comment notification emails now use the **Site URL** from **Settings > General** when `siteUrl`, `EMDASH_SITE_URL`, or `SITE_URL` is not configured, and fall back to the setup address when the field is empty. Only the origin of the **Site URL** is used, and it must use `https://` unless the host is a loopback address. A configured `siteUrl` still takes precedence. `emdash export-seed` no longer copies the **Site URL** into the seed.
  
  If you don't configure `siteUrl` and the **Site URL** field holds an address that doesn't serve this site's admin, for example an old domain, links in these emails point there after upgrading. Check the field before upgrading; clearing it restores the previous behavior. Seeds that set `settings.url`, including seeds exported by earlier versions, still fill in the **Site URL**, so remove `url` from a seed copied from another site before using it.

- [#3920](https://github.com/emdash-cms/emdash/pull/3920) [`709dbf4`](https://github.com/emdash-cms/emdash/commit/709dbf42dbc6764057c5eceb8997ff4131ef047a) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fixes `emdash types` so the generated `.emdash/types.ts` imports `BylineSummary`, `ContentBylineCredit`, and `TaxonomyTerm` alongside `PortableTextBlock`.
  
  Previously the CLI downloaded TypeScript definitions whose collection interfaces referenced these three names but only imported `PortableTextBlock`, causing `tsc` to report `TS2304` errors for every collection.

- [#3591](https://github.com/emdash-cms/emdash/pull/3591) [`038e322`](https://github.com/emdash-cms/emdash/commit/038e3228773132a753172968b33ec413dcff3f5c) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fixes the visual editor stripping superscript and subscript formatting from Portable Text fields on save, and adds superscript and subscript buttons to its formatting menu. A field that contains formatting the visual editor can't represent now shows a message instead of opening for editing, so editing on the page no longer silently removes that formatting.

- [#3736](https://github.com/emdash-cms/emdash/pull/3736) [`b9613bd`](https://github.com/emdash-cms/emdash/commit/b9613bd4bbf2bd5ecc1935279821c37b43445a6e) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fixes the `core:recent-posts` widget so it shows each post's publication date and thumbnail. Dates use the page's locale and the site's configured timezone, falling back to UTC when the timezone setting isn't recognized. The widget doesn't apply the `dateFormat` setting; dates always use the locale's long format, such as "October 1, 2026" in English. Thumbnails render at up to 96 pixels wide instead of at full size.

- [#3731](https://github.com/emdash-cms/emdash/pull/3731) [`6cf612c`](https://github.com/emdash-cms/emdash/commit/6cf612cbf2a04a7eb1b22cb3e4ffecb53a1a438a) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fixes `decodeSlug()` so malformed percent-escaped slugs return `undefined` instead of throwing, letting `[slug]` pages fall through to their 404 handling.

- [#3941](https://github.com/emdash-cms/emdash/pull/3941) [`8450114`](https://github.com/emdash-cms/emdash/commit/845011455d8badcede71d4a2c994b1c492b197be) Thanks [@swissky](https://github.com/swissky)! - Fixes installing and updating registry plugins whose releases were attested with `actions/attest-build-provenance` v3, including releases from the workflow that `emdash-plugin release setup` generates. These installs previously failed with "release provenance could not be verified". Provenance in both GitHub formats is now accepted, and releases built on self-hosted runners are still rejected.

- [#3851](https://github.com/emdash-cms/emdash/pull/3851) [`3bcd2cb`](https://github.com/emdash-cms/emdash/commit/3bcd2cbb949b6eb69182446cc6c49a38cf156d7f) Thanks [@Zahid09987](https://github.com/Zahid09987)! - Adds Indonesian translations for the site domain-change flow, general settings screen, marketplace capability labels, and visual-editing toolbar strings.

- [#3746](https://github.com/emdash-cms/emdash/pull/3746) [`9ee7415`](https://github.com/emdash-cms/emdash/commit/9ee7415a35c01ae2591af1a1c21787ca694b9c99) Thanks [@keybits](https://github.com/keybits)! - Fixes in-page visual editing removing the link and alignment from Portable Text images. Saving any edit to a Portable Text field from the page no longer turns linked images into plain images or resets left, right, center, wide, and full alignment.

- [#3795](https://github.com/emdash-cms/emdash/pull/3795) [`36aee2d`](https://github.com/emdash-cms/emdash/commit/36aee2d17225a44cd4060f1ae158e723e3730372) Thanks [@DiogoDuart3](https://github.com/DiogoDuart3)! - Fixes the content editor failing to open any entry with a date field when the site timezone setting is not a valid IANA timezone (for example `Lisboa` instead of `Europe/Lisbon`). The editor now falls back to UTC for such a value instead of crashing, and the settings API and MCP settings tool reject an unrecognized timezone with a validation error. A site that already stores one can still save its other settings, and can fix the timezone in Settings > General.

- [#3922](https://github.com/emdash-cms/emdash/pull/3922) [`da088aa`](https://github.com/emdash-cms/emdash/commit/da088aa96ac11c6f65af889f7272c76d24a3e736) Thanks [@swissky](https://github.com/swissky)! - Fixes `entry.id` sometimes missing the locale prefix on multilingual sites. With several locales configured, entries in a locale whose URLs are prefixed get an `entry.id` such as `en/my-post`. With a Cloudflare database (D1, Durable Object SQL or Hyperdrive), in production and in `astro dev`, the prefix could be missing, depending on what else had already run in the same isolate, so the same entry returned `my-post` on some requests and `en/my-post` on others. Collection queries, `getEmDashEntry()` and referenced entries now always include the prefix.
  
  If your templates add the locale to links themselves, for example `/en/posts/${entry.id}`, or pass `entry.id` to `getEmDashEntry()`, use `entry.data.slug` instead, which never includes the locale.

- [#3828](https://github.com/emdash-cms/emdash/pull/3828) [`609c912`](https://github.com/emdash-cms/emdash/commit/609c91298940ccee0566d1eb14e01c0f7ff51967) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes videos served from `/_emdash/api/media/file/` not playing in Safari and on iOS, and not seeking past the buffered part in other browsers. With the local, S3, and R2 storage adapters, the media route answers `Range` requests with `206 Partial Content`, or `416 Range Not Satisfiable` for a range past the end of the file, and sends `Accept-Ranges: bytes`.
  
  Custom storage adapters can serve ranges by accepting the optional `options.range` argument to `download()` and setting `range` on the result, as described in [the storage interface docs](https://docs.emdashcms.com/deployment/storage/#byte-ranges). Adapters that ignore the argument still work: range requests to them receive the whole file, or `416` for a range past the end of the file.

- [#3914](https://github.com/emdash-cms/emdash/pull/3914) [`a834e75`](https://github.com/emdash-cms/emdash/commit/a834e75327368f24a42f358564c316449c9503e1) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fixes admin media uploads skipping `media:beforeUpload` and `media:afterUpload` plugin hooks. Plugins can validate, rename, change the file type, or cancel uploads before they are accepted, and receive a notification after a new media item becomes ready. Filename and type changes are validated; the upload size stays tied to the original client bytes.

- [#3755](https://github.com/emdash-cms/emdash/pull/3755) [`e2a07ae`](https://github.com/emdash-cms/emdash/commit/e2a07ae1b02951d77a32341302ff5c504cb52b1c) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes `emdash media upload --alt` and `--caption`, which reported a successful upload but saved neither value on the new media item. Direct uploads to `POST /_emdash/api/media` store the `alt` and `caption` form fields.

- [#3855](https://github.com/emdash-cms/emdash/pull/3855) [`e8b61b3`](https://github.com/emdash-cms/emdash/commit/e8b61b304e33c18c77dd7b85cc9960a16cb41f4e) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Adds `ETag` and `Last-Modified` validators to media file responses and `/image` transforms, and returns `304 Not Modified` when a browser's `If-None-Match` or `If-Modified-Since` precondition matches. This lets cached mutable media (images that can be replaced under the same storage key) be revalidated with a single header exchange instead of re-downloaded on every visit. Storage backends now report `lastModified` with downloads where available (local filesystem, S3-compatible, and R2). The short `public, max-age=0, must-revalidate` cache lifetime for images is unchanged, so replacements still appear immediately.

- [#3758](https://github.com/emdash-cms/emdash/pull/3758) [`d0c7384`](https://github.com/emdash-cms/emdash/commit/d0c73843245234ea1230d570b1ed9f586f6698c1) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes the admin's new-entry form ignoring field default values: a boolean field with `defaultValue: true` started switched off, and saving the entry untouched could store no value. New entries in the admin now start with each field's default value.
  
  Manifest field descriptors now include stored field defaults as `defaultValue`, except for relation-bound reference fields.

- [#3573](https://github.com/emdash-cms/emdash/pull/3573) [`c3cc974`](https://github.com/emdash-cms/emdash/commit/c3cc97432fb76098d918eefdf3676e45f60d52c6) Thanks [@swissky](https://github.com/swissky)! - Speeds up the first anonymous page views on each new server instance, such as a fresh Cloudflare Worker isolate, when migrations run automatically: the database setup check now runs at the same time as runtime startup instead of before it.
  
  When all migrations are already applied, a temporary database error during the startup migration check (for example a lost D1 connection) no longer blocks runtime startup on that instance for 30 seconds; the next request tries again. An error while pending migrations are being applied, or a migration lock left behind by a stopped instance, still pauses retries.

- [#3806](https://github.com/emdash-cms/emdash/pull/3806) [`07f6f44`](https://github.com/emdash-cms/emdash/commit/07f6f443fa16fb0fd2f50fea85039d216e0345df) Thanks [@swissky](https://github.com/swissky)! - Fixes collection sitemaps silently dropping entries beyond the first 50,000. Each `/sitemap-{collection}.xml` now holds up to 2,000 entries, ordered by entry ID instead of last update, and continues at `/sitemap-{collection}-2.xml`, `-3.xml`, and so on. `/sitemap.xml` lists every page with its own last-modified date, and translations that land on different pages still list each other as hreflang alternates.
  
  #### What should I do?
  
  Nothing, if search engines read `/sitemap.xml` and you have not replaced the sitemap routes. For collections with more than 2,000 listed entries:
  
  - If you submitted a collection sitemap such as `/sitemap-post.xml` directly to a search console, submit `/sitemap.xml` instead so search engines find every page.
  - If you replaced `src/pages/sitemap.xml.ts`, add `/sitemap-{collection}-{n}.xml` for each further page of 2,000 entries.
  - If you replaced `src/pages/sitemap-[collection].xml.ts`, handle the `-{n}` suffix in the `collection` parameter (for example `post-2`) and serve that page of entries.

- [#3546](https://github.com/emdash-cms/emdash/pull/3546) [`2c8c12a`](https://github.com/emdash-cms/emdash/commit/2c8c12a6b84d7c790944aebd5e7e090514fccfd6) Thanks [@swissky](https://github.com/swissky)! - Adds `group` to plugin admin pages, in native plugin descriptors and in `admin.pages` of `emdash-plugin.jsonc`, to place them in collapsible admin sidebar folders. A page whose group matches the group of a collection shown in the sidebar appears inside that folder, after its collections and taxonomies. Pages that share any other group, from one plugin or several, fold into one folder in the Plugins section. Pages without a group stay where they are.

- [#3602](https://github.com/emdash-cms/emdash/pull/3602) [`82cea2c`](https://github.com/emdash-cms/emdash/commit/82cea2cd54ee14506d043818a423cfc58f339c54) Thanks [@itaides](https://github.com/itaides)! - Fixes trusted (in-process) plugin API routes dropping error `details`: a route that throws `PluginRouteError.badRequest(message, details)`, or whose `input` schema rejects the request, now returns those details in the JSON error body (`error.details`), so a form can show which fields failed. Unexpected errors still return only a generic message.

- [#3741](https://github.com/emdash-cms/emdash/pull/3741) [`4bc129c`](https://github.com/emdash-cms/emdash/commit/4bc129ce6e36041596b63c59e680a5dca7838a1d) Thanks [@KirbyBT](https://github.com/KirbyBT)! - Fixes native plugin routes returning a generic `INTERNAL_ERROR` under `astro dev` when the handler throws `PluginRouteError`, so the client receives the error's code, status, and message.

- [#3744](https://github.com/emdash-cms/emdash/pull/3744) [`1e275ae`](https://github.com/emdash-cms/emdash/commit/1e275ae8b4f1a2766c2f29d2efa8d5a8492233d6) Thanks [@swissky](https://github.com/swissky)! - Fixes plugins seeing an outdated site address in `ctx.site.url` and `ctx.url()`. They now use the same origin as links in emails: the configured `siteUrl`, `EMDASH_SITE_URL`, or `SITE_URL`, then the **Site URL** from **Settings > General**, then the address the site was set up on. Previously plugins only saw the setup address, even when `siteUrl` was configured or the site had moved to a new domain. A changed **Site URL** reaches plugins after the server restarts or, on Cloudflare Workers, as new isolates start.

- [#3776](https://github.com/emdash-cms/emdash/pull/3776) [`9f389fb`](https://github.com/emdash-cms/emdash/commit/9f389fb1e95a4c4d24b02ec0deb14c5a65604431) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fixes plugin `ctx.storage.<collection>.getMany()` and `deleteMany()` failing on D1 with `too many SQL variables` when passed more than 98 ids. Both now accept any number of ids, in trusted and sandboxed plugins alike.

- [#3931](https://github.com/emdash-cms/emdash/pull/3931) [`9538600`](https://github.com/emdash-cms/emdash/commit/95386001e4ac5a964fb568fa3d75113fe539e0fe) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes `parseApiResponse` from `emdash/plugin-utils` rejecting with an error message that ends in a bare colon when a plugin route responds with an error page instead of an error message. The message is now the fallback message alone, without the HTTP status text, which browsers leave empty over HTTP/2 and HTTP/3.

- [#3574](https://github.com/emdash-cms/emdash/pull/3574) [`d8c6d64`](https://github.com/emdash-cms/emdash/commit/d8c6d643d64ca762012b3bfc319ab41d6827d92f) Thanks [@swissky](https://github.com/swissky)! - Speeds up the first request on a fresh Cloudflare Worker isolate for sites on D1 or Durable Object SQLite: runtime startup now loads the stored plugin provider selections (such as the active comment moderator) with its other startup reads, saving one database round trip.

- [#3553](https://github.com/emdash-cms/emdash/pull/3553) [`aa7cc95`](https://github.com/emdash-cms/emdash/commit/aa7cc95e2f0037ef6ab80b8beb48704a733368ae) Thanks [@swissky](https://github.com/swissky)! - Stops the datetime normalization migration from printing an error-level `[datetime migration] 0 noncanonical values …` line on new sites and on upgrades with nothing to convert. When stored datetimes are rewritten, the migration still prints its report, now as an informational message.

- [#1899](https://github.com/emdash-cms/emdash/pull/1899) [`e9cf2c3`](https://github.com/emdash-cms/emdash/commit/e9cf2c3ff804b54ccfdceb2fbe93e74e26799833) Thanks [@swissky](https://github.com/swissky)! - Adds an optional `urlTemplate` prop to the `core:recent-posts` widget (e.g. `"/blog/:slug"` or `"/:slug"` for catch-all routes), using the same `:collection`, `:id`, `:slug`, and `:path` tokens as LiveSearch's `routeMap`, with a localized label in the admin widget form. Without a template the widget links exactly as before.

- [#3287](https://github.com/emdash-cms/emdash/pull/3287) [`766aa29`](https://github.com/emdash-cms/emdash/commit/766aa29f25246486c8ba0673db23227cf366c1aa) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes missing redirect hit counts and 404 log entries on Cloudflare Workers. The Worker could stop before these writes finished. It now stays alive until they complete, and a failed write is logged with a `[emdash:redirects]` prefix.

- [#3943](https://github.com/emdash-cms/emdash/pull/3943) [`f223ecd`](https://github.com/emdash-cms/emdash/commit/f223ecdc060038ffb75363a4e10ef341d065e5ca) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes publishing and installing registry plugins attested by a GitHub Actions reusable workflow in the same repository and ref as its calling workflow. These releases previously failed with `PROVENANCE_UNVERIFIABLE` because the caller and signer were treated as the same workflow.

- [#3898](https://github.com/emdash-cms/emdash/pull/3898) [`34f480e`](https://github.com/emdash-cms/emdash/commit/34f480ecc1662d61c4608fc61dfaf606b9e6d7d6) Thanks [@swissky](https://github.com/swissky)! - Fixes Astro route rules caching responses that belong to one visitor. With a cache provider such as `cacheCloudflare()`, a page rendered for a signed-in user (for example a comment form showing their name and email) could be stored and served to anonymous visitors, and a catch-all rule such as `/[...slug]` could store EmDash admin API responses or anonymous `401` responses and serve them to other users.
  
  Responses rendered for a signed-in user, and responses sent with `Cache-Control: private` or `no-store`, are no longer stored in the route cache. This includes EmDash API responses such as `/_emdash/api/search`, so route rules no longer cache them. A page requested by a signed-in user is filled into the cache by the next anonymous visitor instead.

- [#3559](https://github.com/emdash-cms/emdash/pull/3559) [`f6ee57e`](https://github.com/emdash-cms/emdash/commit/f6ee57e92445d7c01df6863968875cb979bfae87) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes Select All inside code blocks in the admin and inline visual editors so it selects only the code instead of the entire document.

- [#3861](https://github.com/emdash-cms/emdash/pull/3861) [`9451267`](https://github.com/emdash-cms/emdash/commit/94512678307b592dbdee9c8715e7a6600827b1dc) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fixes every-minute cron ticks exceeding the Workers Free CPU limit on cold isolates by running system cleanup once per hour instead of on every tick. The scheduled-publish sweep, cron tasks, and heartbeat still run each minute; bookkeeping cleanups now run only on the top of the hour.

- [#3525](https://github.com/emdash-cms/emdash/pull/3525) [`3d5a102`](https://github.com/emdash-cms/emdash/commit/3d5a1024cd7f9266b39bdb8f8d974d586e2bd302) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes `emdash seed --no-content` applying the seed's content entries, bylines, and taxonomy terms anyway. The flag now skips them as documented, so combining it with `--on-conflict update` no longer overwrites existing entries.
  
  #### What should I do?
  
  If a script uses the undocumented `--noContent` spelling, switch it to `--no-content` or `--content=false`. `--noContent` was the only spelling that skipped content before this release. It is now ignored without an error, so the command applies the seed's content.

- [#3857](https://github.com/emdash-cms/emdash/pull/3857) [`0157a63`](https://github.com/emdash-cms/emdash/commit/0157a6300e5351efcdde191bd1f175b1e31ac1aa) Thanks [@swissky](https://github.com/swissky)! - Warns when a seed file's `repeater` field has no `validation.subFields`, or declares its sub-fields under `fields` instead. Such a repeater previously seeded without any warning, and the admin then showed rows labelled "Item 1", "Item 2" with no inputs to edit. `emdash seed` prints the warning naming the field, and `validateSeed()` returns it in `warnings`; the seed still applies as before. The setup wizard does not display seed warnings.

- [#3672](https://github.com/emdash-cms/emdash/pull/3672) [`064f46c`](https://github.com/emdash-cms/emdash/commit/064f46ce298a3dc123fea3638d1edbb8764cdbce) Thanks [@masonjames](https://github.com/masonjames)! - Fixes seed validation accepting reserved collection and field slugs, such as a field named `version`. `emdash seed --validate` and the check that runs before a seed is applied now report the reserved slug, instead of the seed passing validation and then failing while it is applied.

- [#3578](https://github.com/emdash-cms/emdash/pull/3578) [`bafa475`](https://github.com/emdash-cms/emdash/commit/bafa475cc7de266f7bd3ea1486ee286808fc2e0f) Thanks [@swissky](https://github.com/swissky)! - Warns when `emdash seed` (including `--validate`) finds a widget that sets its options under `settings`. Seeding ignores that key; widget options belong in `props`.

- [#3754](https://github.com/emdash-cms/emdash/pull/3754) [`7f3093e`](https://github.com/emdash-cms/emdash/commit/7f3093ef9f4523ba6323c7c5d95ae16e67a7ae41) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes the setup wizard staying on "Loading EmDash..." on sites whose Astro `security.csp` sets `scriptDirective.strictDynamic`. The setup page now gets the same Content-Security-Policy as the rest of the admin.

- [#3749](https://github.com/emdash-cms/emdash/pull/3749) [`3bfd6fc`](https://github.com/emdash-cms/emdash/commit/3bfd6fc1965f21700b23355499866980e90fece4) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes new sites created from a template keeping the template's site title and tagline instead of the ones entered in the setup wizard. Sites set up on 0.39.0 or later keep their stored values after upgrading; change them under Settings → General.

- [#3595](https://github.com/emdash-cms/emdash/pull/3595) [`1bad6d8`](https://github.com/emdash-cms/emdash/commit/1bad6d8414aa98315c9d1ff33e1a1598e8ac45ae) Thanks [@edrpls](https://github.com/edrpls)! - Fixes `/sitemap-{collection}.xml` returning 500 `<!-- EmDash not configured -->` for names that are not valid collection slugs, such as the `/sitemap-0.xml` that crawlers request. These now return 404.

- [#3750](https://github.com/emdash-cms/emdash/pull/3750) [`4f967ae`](https://github.com/emdash-cms/emdash/commit/4f967aed349096c749ac64e16bb03188aa4d5a1e) Thanks [@swissky](https://github.com/swissky)! - Fixes blurry small images, such as avatars and icons, on high-density screens, and stops requesting high-density sizes larger than the original image.
  
  Media-provider images in `Image` from `emdash/ui`, Portable Text images, and galleries now get a `srcset` with the rendered width and, up to 1920 pixels, a high-density candidate: twice the rendered width, or the original width when that is smaller. Before, provider images narrower than 320 pixels had no `srcset` at all, and other provider images could list widths larger than the original. Provider images shown at their original size, as gallery images always are, now also offer that original width, even above 1920 pixels.
  
  `Image` applies the same high-density candidate to media URLs from another origin, such as a public R2 bucket.

- [#3889](https://github.com/emdash-cms/emdash/pull/3889) [`d5b8b38`](https://github.com/emdash-cms/emdash/commit/d5b8b38e422f04fbda02b2c17e4f0d599a6e2ff9) Thanks [@swissky](https://github.com/swissky)! - Fixes assigning more than about 30 categories or tags to an entry on Cloudflare D1, and removing more than about 100 at once. These failed with `too many SQL variables`, whether from the admin, the content terms API, a plugin, or the WordPress import, which left such imported posts without any terms.

- [#3681](https://github.com/emdash-cms/emdash/pull/3681) [`cfc7e7d`](https://github.com/emdash-cms/emdash/commit/cfc7e7d95677caf177f12fa338e2c9599d3633c5) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes stored cross-site scripting through the editor toolbar. EmDash inserted the toolbar before the first `</body>` in a response, but Astro leaves `<` and `>` unescaped in attribute values, so content such as an image's alt text could contain `</body>` and move the toolbar inside that attribute, turning the rest of the text into live markup. The editor toolbar, and the Cloudflare preview and playground toolbars, now go only before the closing body tag of a whole HTML document, never into server island or partial page responses.
  
  Before this fix:
  
  - Unless a site set `toolbar: false`, an Author's published content could run script for any signed-in Author, Editor, or Admin who viewed it, and a Contributor's draft could do the same to a signed-in Author, Editor, or Admin who previewed it.
  - With `toolbar: "client"`, published content could also run script for every visitor.
  - In preview Workers built with `createPreviewMiddleware`, published content could run script for anyone who opened a preview link, whatever the `toolbar` setting.

- [#3823](https://github.com/emdash-cms/emdash/pull/3823) [`f4dc955`](https://github.com/emdash-cms/emdash/commit/f4dc955453d021f1cc2f245f1468677f9302b659) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fixes parameterized redirect patterns so URLs with a trailing slash match the same rule as URLs without one, consistent with exact and catch-all redirects.

- [#3771](https://github.com/emdash-cms/emdash/pull/3771) [`550e59b`](https://github.com/emdash-cms/emdash/commit/550e59b51ab4d0bc3ad3ab13e70d94ca96313863) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes the visual editing toolbar's Publish button switching to English after a save when the toolbar is shown in another language. The button now keeps its translated label, and the toolbar's status badges and image popover can be translated as well.

- [#3756](https://github.com/emdash-cms/emdash/pull/3756) [`ea88e8e`](https://github.com/emdash-cms/emdash/commit/ea88e8e3801ff127c111c85b2872a93d89a3b641) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes Publish in the visual editing toolbar publishing an older version when it is clicked while an inline Portable Text edit is still saving, which left that edit as unpublished changes. Publish now waits until every save on the page has finished.

- [#3894](https://github.com/emdash-cms/emdash/pull/3894) [`740de2b`](https://github.com/emdash-cms/emdash/commit/740de2b1b42f1d871b91195bc3bbfc9e5e869df6) Thanks [@oddharsh](https://github.com/oddharsh)! - Fixes the `WebMcpSearch` component's `search_site` tool so agents can tell a failed search from an empty one. An empty query, an HTTP error or a network failure now fails the tool call, where it previously reached the agent as a successful result. Results now arrive as a JSON array of `{ title, url, collection, excerpt }` objects, without a JSON-encoded string nested inside.

- [#3575](https://github.com/emdash-cms/emdash/pull/3575) [`161ff98`](https://github.com/emdash-cms/emdash/commit/161ff98663cb8b5ade88d16154e2bf8f8ed43516) Thanks [@swissky](https://github.com/swissky)! - Updates `getWidgetAreas()` to return areas in creation order (previously unspecified), and removes a database round trip from logged-out page loads on Cloudflare D1.

- [#3896](https://github.com/emdash-cms/emdash/pull/3896) [`f715431`](https://github.com/emdash-cms/emdash/commit/f7154317cdc5ce26dfee837c391b32a665e846ee) Thanks [@swissky](https://github.com/swissky)! - Fixes WordPress imports leaving links to the old site's uploads in place outside image blocks. After the media import, these URLs now also point to the imported media: cover backgrounds, file blocks, self-hosted audio and video, links in text and tables (for example to a PDF), buttons, and images and links in raw HTML blocks. Content imported before this fix is not changed.

- [#3895](https://github.com/emdash-cms/emdash/pull/3895) [`622a324`](https://github.com/emdash-cms/emdash/commit/622a324788784890377c355acc3c2a5ec65daec5) Thanks [@swissky](https://github.com/swissky)! - Fixes scheduled WordPress posts being imported as plain drafts. The WordPress export file (WXR) import and the WordPress plugin import in the admin now schedule them for their original publish date. Posts whose scheduled date has already passed are still imported as drafts. Posts imported before this fix are skipped on a re-import, so schedule them from the editor or delete and import them again.
  
  The WordPress plugin import also reads post dates as UTC now. On Node servers running in a time zone other than UTC, imported created and modified dates were shifted by the server's offset.
- Updated dependencies [[`5c1ebc3`](https://github.com/emdash-cms/emdash/commit/5c1ebc39200f4945feaa59289ce1de4aee4a8a07), [`b92f2d6`](https://github.com/emdash-cms/emdash/commit/b92f2d653689984b804998633276d1bdd7ccec89), [`5f69896`](https://github.com/emdash-cms/emdash/commit/5f69896ade7567f8af99373ef655046d6b823518), [`90f39e0`](https://github.com/emdash-cms/emdash/commit/90f39e0cd6635d5c4243d1235b0095fe24d6a850), [`a17408f`](https://github.com/emdash-cms/emdash/commit/a17408fe6326999e2acf94949f657621291d54e5), [`f5406f8`](https://github.com/emdash-cms/emdash/commit/f5406f841d80a42b4ec2d9784333705a32551fad), [`1e275ae`](https://github.com/emdash-cms/emdash/commit/1e275ae8b4f1a2766c2f29d2efa8d5a8492233d6), [`f09797c`](https://github.com/emdash-cms/emdash/commit/f09797c847778e29a697f83ae76f9e7f253cbdcf), [`3787eb9`](https://github.com/emdash-cms/emdash/commit/3787eb9aef2ce5f3dfbac98cfdc6073fa95188d5), [`e63cc44`](https://github.com/emdash-cms/emdash/commit/e63cc44a953f4786fa211a8989a6547267635be5), [`c77c6cf`](https://github.com/emdash-cms/emdash/commit/c77c6cfe55611ac9937dbfc23ad48205f324f075), [`395087d`](https://github.com/emdash-cms/emdash/commit/395087d82596489f0cc7207b9cd668d8e73462a6), [`bfd05b0`](https://github.com/emdash-cms/emdash/commit/bfd05b08043017ee45a76fa7bb3fd72969fb3767), [`1e275ae`](https://github.com/emdash-cms/emdash/commit/1e275ae8b4f1a2766c2f29d2efa8d5a8492233d6), [`06a9146`](https://github.com/emdash-cms/emdash/commit/06a9146a069bff01555adf5341e5e4de2b6a22b4), [`373446f`](https://github.com/emdash-cms/emdash/commit/373446f973d33703718f2f0c22322548fad6ab1a), [`1e275ae`](https://github.com/emdash-cms/emdash/commit/1e275ae8b4f1a2766c2f29d2efa8d5a8492233d6), [`24a4327`](https://github.com/emdash-cms/emdash/commit/24a432743bfab219a9231006cc371eb903a988ab), [`9f09f60`](https://github.com/emdash-cms/emdash/commit/9f09f60d61d1efc14ed094a2fa5cf866a74fee04), [`8885267`](https://github.com/emdash-cms/emdash/commit/8885267484f48e93b28a7bcf8f58165b46fb0f3f), [`c07437f`](https://github.com/emdash-cms/emdash/commit/c07437f489f85e5447ae4e5e92951de3a10ade47), [`b3e17f6`](https://github.com/emdash-cms/emdash/commit/b3e17f6a5aae92d7b3353a3c115a4e130910fe9e), [`8450114`](https://github.com/emdash-cms/emdash/commit/845011455d8badcede71d4a2c994b1c492b197be), [`d1065a1`](https://github.com/emdash-cms/emdash/commit/d1065a157eb1009f649c06e6c6b49130f60bbf27), [`595fd15`](https://github.com/emdash-cms/emdash/commit/595fd1566d086b072c450f5958abe592cf043a5a), [`392ade3`](https://github.com/emdash-cms/emdash/commit/392ade3cfbefdf8affdffcbbe8fc99b55aa5e6ae), [`3bcd2cb`](https://github.com/emdash-cms/emdash/commit/3bcd2cbb949b6eb69182446cc6c49a38cf156d7f), [`36aee2d`](https://github.com/emdash-cms/emdash/commit/36aee2d17225a44cd4060f1ae158e723e3730372), [`9538600`](https://github.com/emdash-cms/emdash/commit/95386001e4ac5a964fb568fa3d75113fe539e0fe), [`6d2a3bb`](https://github.com/emdash-cms/emdash/commit/6d2a3bbb8ed3f9fcfedda7a929a2de6659b60b58), [`841a5b3`](https://github.com/emdash-cms/emdash/commit/841a5b3f3bc1c01c35b3e770eeab673b3c5bb870), [`2210c2c`](https://github.com/emdash-cms/emdash/commit/2210c2c7688a8d407143dfe4d565898674470412), [`142da40`](https://github.com/emdash-cms/emdash/commit/142da4056a644a4eef4f79ced5c107aa32be5b89), [`d72b615`](https://github.com/emdash-cms/emdash/commit/d72b6151d772acb6ff16c8ad9063bc7ea22f69d8), [`2f59cc3`](https://github.com/emdash-cms/emdash/commit/2f59cc37872843381d00f810eeb829b9cdba566c), [`e6fe5d4`](https://github.com/emdash-cms/emdash/commit/e6fe5d498a527b5e6bd6cbc80ee5220ce626673c), [`06a9146`](https://github.com/emdash-cms/emdash/commit/06a9146a069bff01555adf5341e5e4de2b6a22b4), [`d0c7384`](https://github.com/emdash-cms/emdash/commit/d0c73843245234ea1230d570b1ed9f586f6698c1), [`e6fe5d4`](https://github.com/emdash-cms/emdash/commit/e6fe5d498a527b5e6bd6cbc80ee5220ce626673c), [`b854616`](https://github.com/emdash-cms/emdash/commit/b85461614b9ceaa071573dce717a2a2799963eb8), [`2c8c12a`](https://github.com/emdash-cms/emdash/commit/2c8c12a6b84d7c790944aebd5e7e090514fccfd6), [`8867aba`](https://github.com/emdash-cms/emdash/commit/8867aba83db09eee7d4d87b4ac6cdea327c6c113), [`2210c2c`](https://github.com/emdash-cms/emdash/commit/2210c2c7688a8d407143dfe4d565898674470412), [`e9cf2c3`](https://github.com/emdash-cms/emdash/commit/e9cf2c3ff804b54ccfdceb2fbe93e74e26799833), [`f223ecd`](https://github.com/emdash-cms/emdash/commit/f223ecdc060038ffb75363a4e10ef341d065e5ca), [`f6ee57e`](https://github.com/emdash-cms/emdash/commit/f6ee57e92445d7c01df6863968875cb979bfae87), [`1e275ae`](https://github.com/emdash-cms/emdash/commit/1e275ae8b4f1a2766c2f29d2efa8d5a8492233d6), [`788a371`](https://github.com/emdash-cms/emdash/commit/788a3715d8d88f865dc30099b9bec36f7d731636), [`2881234`](https://github.com/emdash-cms/emdash/commit/2881234fad52162ea730bba3cd57919526dc5d3e), [`550e59b`](https://github.com/emdash-cms/emdash/commit/550e59b51ab4d0bc3ad3ab13e70d94ca96313863), [`8037f5a`](https://github.com/emdash-cms/emdash/commit/8037f5aa284a65d938d6cb4337c88239bed19a47), [`dea8f58`](https://github.com/emdash-cms/emdash/commit/dea8f589d230220bc81c3b8bd1e8efe3d30f906b), [`c5cef43`](https://github.com/emdash-cms/emdash/commit/c5cef432fe040efa36038420eb26e71c3ce94754)]:
  - @emdash-cms/admin@1.2.0
  - @emdash-cms/gutenberg-to-portable-text@1.2.0
  - @emdash-cms/registry-verification@0.3.4
  - @emdash-cms/plugin-types@0.6.0
  - @emdash-cms/auth@1.2.0
  - @emdash-cms/blocks@1.2.0

## 1.1.0

### Minor Changes

- [#3680](https://github.com/emdash-cms/emdash/pull/3680) [`75de9a4`](https://github.com/emdash-cms/emdash/commit/75de9a4b4bdb3a8298456b4b730aee31c86897fd) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Adds a publishing calendar to the admin. It shows published entries on their publication date, and scheduled entries and scheduled updates on their scheduled date, across every visible collection and locale. Contributors and higher roles open it from **Calendar** in the sidebar, the command palette, or the dashboard's **Scheduled** count.
  
  **Month** shows a grid of days and **Agenda** lists entries by day; phones and other narrow screens open the agenda and show the month as a date picker. Both views place entries in the site's time zone, show browser-zone times when the viewer's zone differs, mark schedules that missed their time as **Overdue**, filter by collection, locale, and state, and keep the view, month, filters, and open entry in the URL. When a month's grid holds more than 1,000 entries, the calendar shows the first 1,000 and marks the days it didn't load.
  
  Selecting an entry opens a side panel with its details, a link to the editor, and a preview or live link. Users who can publish the entry can also reschedule it, remove its schedule, or publish an overdue entry immediately. Ctrl-click or Cmd-click opens the entry in the editor instead.

- [#3566](https://github.com/emdash-cms/emdash/pull/3566) [`3c70ca5`](https://github.com/emdash-cms/emdash/commit/3c70ca524abc3f70fe65a1753dbc4d10114fc816) Thanks [@stephanedemotte](https://github.com/stephanedemotte)! - Adds `locale` and `translationOf` to the `content:beforeSave` and `content:afterSave` hook events, for trusted and sandboxed plugins, so a hook can tell a new entry from a new translation of an existing one.
  
  `locale` is the locale the entry is saved in: the resolved requested locale (or the default locale) on a create, and the stored entry's locale on an update. `translationOf` is the ID of the source entry when a create comes from the translation flow, and is absent otherwise. Both fields are optional; existing hooks are unaffected.

- [#3687](https://github.com/emdash-cms/emdash/pull/3687) [`76b06d4`](https://github.com/emdash-cms/emdash/commit/76b06d4e40a9d37ab44ec7109e75339af7aeef85) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Adds CSS and JavaScript to HTML blocks, and changes how new HTML blocks render on the site.
  
  Previously, every HTML block rendered inline, and the site sanitized its HTML, removing scripts and styles. HTML blocks created in the admin editor, or with `/html` in visual editing, now render in a sandboxed iframe that runs their HTML, CSS and JavaScript. Anyone who can edit content (Contributor and up, and sandboxed plugins with `content:write`) can add JavaScript that runs for visitors once the entry is published. The iframe can't read the site's cookies, storage or pages, and the site's styles don't apply inside it. Relative links in it resolve from the site's root. After a visitor clicks inside the iframe, it can open other pages in the visitor's tab or a new one. There is no site-wide setting for this; to render a block the previous way, choose **Inline** in its menu.
  
  Existing HTML blocks, and blocks created through imports, REST or MCP, keep rendering inline unless they set `isolated: true`.
  
  In the editor, an HTML block has HTML, CSS and JS tabs with a code editor, and a Preview tab that shows the block as the site renders it. A saved block that runs JavaScript waits for **Run preview**. The admin editor no longer nests HTML blocks in quotes, lists or table cells, where saving dropped them. HTML blocks pasted from another website or browser tab render inline.
  
  #### New fields
  
  `htmlBlock` gains optional `css` and `js` strings and an `isolated` flag. They're written only when set, so existing content is unchanged when it's opened and saved.
  
  #### What should I do?
  
  - If your site replaces the `htmlBlock` renderer, pass blocks with `isolated: true` to `HtmlBlock` from `emdash/ui`, or render them in an iframe whose `sandbox` omits `allow-same-origin`. Otherwise isolated blocks render without their CSS and JavaScript.
  - If you render Portable Text outside EmDash's components, handle `isolated` blocks the same way.
  - With Astro's content security policy turned on, the browser blocks the styles and scripts inside isolated blocks, so they render without their CSS, JavaScript or automatic height.

- [#3688](https://github.com/emdash-cms/emdash/pull/3688) [`a880323`](https://github.com/emdash-cms/emdash/commit/a88032398d25a93c8159392e4bad4c495f5cd89a) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Adds an iframe block for embedding pages from other sites. In the editor, type `/iframe` and paste an embed code or a link into the Code tab; YouTube and Vimeo links become their players, and the Preview tab shows the embedded page. When an entry opens, a saved block waits for **Load preview**. Iframe blocks pasted from another website or browser tab arrive empty. On the site, `Iframe` from `emdash/ui` renders the `iframe` block as a responsive, lazy-loading iframe.
  
  The iframe is sandboxed and sends a `strict-origin-when-cross-origin` referrer. Only https sources render, pages on the site's own host lose same-origin access, and only the permissions video and map players need (such as autoplay, fullscreen and picture-in-picture) reach the embedded page.
  
  The admin's content security policy now allows https frames (`frame-src 'self' https:`), so previews can load embedded pages, including frames inside HTML block previews.
  
  #### What should I do?
  
  - If a plugin already defines an `iframe` block, the editor keeps using the plugin's block and doesn't offer the built-in one. On the site, the plugin's renderer still wins; a plugin without one gets `Iframe` for blocks that have only the built-in fields. In TypeScript, narrowing `PortableTextBlock` on `_type === "iframe"` now gives `PortableTextIframeBlock | PortableTextUnknownBlock`, so reading the plugin's own fields needs a check such as `"theme" in block`.
  - With Astro's content security policy turned on, allow the embedded hosts in `frame-src`. Iframe blocks also lose their custom size under that policy.

- [#3254](https://github.com/emdash-cms/emdash/pull/3254) [`5de3bdc`](https://github.com/emdash-cms/emdash/commit/5de3bdc4310f6bcca013f05002f05a61e208b2a4) Thanks [@danielmlr](https://github.com/danielmlr)! - Adds a `microsoft()` login provider, so editors can sign in to the admin with a Microsoft Entra ID work or school account next to passkeys and the other providers.
  
  ```js
  import { microsoft } from "emdash/auth/providers/microsoft";
  
  emdash({ authProviders: [microsoft()] });
  ```
  
  The provider reads `EMDASH_OAUTH_MICROSOFT_CLIENT_ID`, `EMDASH_OAUTH_MICROSOFT_CLIENT_SECRET`, and `EMDASH_OAUTH_MICROSOFT_TENANT_ID` (or the unprefixed names) and stays unconfigured until all three are set. The tenant is a directory (tenant) ID, or `common`, `organizations`, or `consumers`. With a directory ID, an account that signs in through that directory counts as verified when its address is in the domain of its sign-in name, or when the optional `xms_edov` claim confirms the address's domain, so it can link to an existing user, accept an invite, sign up through an allowed domain, and create the first admin account. Accounts that sign in through another directory or identity provider, such as guests, and sign-ins through `common`, `organizations`, or `consumers` do not count as verified. `microsoft({ emailVerified })` overrides this either way.

- [#3632](https://github.com/emdash-cms/emdash/pull/3632) [`728790b`](https://github.com/emdash-cms/emdash/commit/728790b099b4a9322cea94ff72216340d7ebc8f7) Thanks [@swissky](https://github.com/swissky)! - Adds a `WebMcpSearch` component (`emdash/ui/webmcp-search`) that lets AI agents in a visitor's browser search your published content. In browsers that support WebMCP, it registers a read-only `search_site` tool backed by the public search API and returns titles, absolute URLs, and plain-text excerpts. It accepts the same `collections`, `locale`, `limit`, and `routeMap` props as `LiveSearch` and does nothing in other browsers.

### Patch Changes

- [#3526](https://github.com/emdash-cms/emdash/pull/3526) [`2d84db5`](https://github.com/emdash-cms/emdash/commit/2d84db536174436637f3223ef1885653479248a0) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes byline translations dropping the source byline's linked user, which left the user's entries in the translation's locale without an author credit. Translations created with the admin's Translate action now keep the source's user, so those entries show the translated byline.
  
  When `translationOf` is set and the call omits `userId`, the `byline_create` MCP tool now links the source's user instead of creating an unlinked translation. Pass `userId: null` to keep the previous behavior.
  
  A user can have only one byline per locale. Creating a byline with a `userId` that already has a different byline in the target locale fails with `CONFLICT` naming that byline, instead of a server error. Translating a byline whose user already has a different byline in the target locale also fails with `CONFLICT`, where it previously created an unlinked translation.
  
  #### What should I do?
  
  Translations created before this release stay unlinked, and the admin's byline list marks them as unlinked. To restore author credits in a locale, open the translation in the admin and link the user.
  
  If Translate reports that the user is already linked to another byline in that locale, unlink that byline in the admin first, or create the translation with `byline_create` and `userId: null`.

- [#3711](https://github.com/emdash-cms/emdash/pull/3711) [`2436119`](https://github.com/emdash-cms/emdash/commit/24361197b40bdde7aa5efba2ee53165f801ca3d2) Thanks [@swissky](https://github.com/swissky)! - Fixes the setup wizard failing with `SITE_URL_REQUIRED` on Cloudflare Workers since 0.40.1 when `siteUrl`, `EMDASH_SITE_URL`, or `SITE_URL` is not set, which blocked new sites created with the Deploy to Cloudflare button. On Cloudflare's network, setup now records `https://` and the hostname it runs on as the origin for authentication emails, and passkeys created during setup only work on that hostname.
  
  - To use a custom domain, run setup on that domain or set `EMDASH_SITE_URL` first.
  - Node.js deployments still need a configured origin before production setup.
  - A Workers build served outside Cloudflare (`wrangler dev`, `astro preview`, or self-hosted workerd) on a reachable address should set `siteUrl` or `EMDASH_SITE_URL` before setup.

- [#3580](https://github.com/emdash-cms/emdash/pull/3580) [`0cfa989`](https://github.com/emdash-cms/emdash/commit/0cfa989bcfc1914caa4b11e92170154fdaef1ec1) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Adds `image/jxl` (JPEG XL) to the default media upload allowlist, so `.jxl` files can be uploaded without a field-specific MIME list. Upload routes now fall back to the filename extension when the browser reports an empty or generic MIME type, which is the common case for JPEG XL outside Safari.

- [#3652](https://github.com/emdash-cms/emdash/pull/3652) [`2ef2d01`](https://github.com/emdash-cms/emdash/commit/2ef2d0194ea4dee6620eda0eaadcc649bf72def7) Thanks [@danielmlr](https://github.com/danielmlr)! - Speeds up the image endpoint EmDash installs (`/_image` by default): its requests no longer wait for the database setup check and runtime startup that delayed the first images on a fresh server instance, such as a new Cloudflare Worker isolate. Signed-in requests still get `locals.user`, but on D1 with `session` enabled their responses no longer set the D1 bookmark cookie, so an edge-cache route rule for `/_image` now also caches admin media thumbnails.
  
  On these requests `locals.emdash` holds only `storage`, plus `db` for a signed-in user; the page and admin helpers it carried before are not set. Playground requests are unchanged. While `check` or `manual` migration mode answers other requests with the 503 "Database migrations are required" response, image endpoint requests are still served.

- [#3662](https://github.com/emdash-cms/emdash/pull/3662) [`02da2bd`](https://github.com/emdash-cms/emdash/commit/02da2bd4cb6690aa0ffc9ba62404567af164f9ad) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes the MCP `content_list` tool suggesting `created_at` and `updated_at` for `orderBy`, which it rejects with a validation error. The tool description now lists only fields it accepts: `createdAt`, `updatedAt`, `publishedAt`, `scheduledAt`, `slug`, `status`, `locale`, and field slugs that are indexed or set as the collection's `titleField` or `dateField`.

- [#3579](https://github.com/emdash-cms/emdash/pull/3579) [`ea3c927`](https://github.com/emdash-cms/emdash/commit/ea3c927a994e64d43ea718fa38449e3170ac2b90) Thanks [@swissky](https://github.com/swissky)! - Reduces database queries when rendering navigation menus with `getMenu()` and `getMenuWithCacheHint()`: a menu and its items now load in a single query, including when the menu falls back to another locale, saving at least one query per menu that isn't already served from the object cache. With an object cache configured, logged-out HTML page loads on Cloudflare D1 and Durable Object databases also skip one more query per request, and menus created or removed by seeding, WordPress import, or site transfer show up without waiting for the cache to expire.

- [#3662](https://github.com/emdash-cms/emdash/pull/3662) [`02da2bd`](https://github.com/emdash-cms/emdash/commit/02da2bd4cb6690aa0ffc9ba62404567af164f9ad) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes content lists skipping entries when paging with `nextCursor` while sorted by a field that can be empty, such as the publish date, scheduled date, title, slug, or a collection's `dateField` or `titleField`. This affected the admin content list for collections with more than 100 entries, including its default sort when the collection sets a `dateField`. It also affected `GET /_emdash/api/content/{collection}`, the MCP `content_list` tool, and plugin `ctx.content.list` calls that set `orderBy`.
  
  The order of entries is unchanged, and cursors issued before the upgrade are still accepted.

- [#3662](https://github.com/emdash-cms/emdash/pull/3662) [`02da2bd`](https://github.com/emdash-cms/emdash/commit/02da2bd4cb6690aa0ffc9ba62404567af164f9ad) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes `getEmDashCollection` skipping entries when paging with `nextCursor` while sorted by a field that can be empty, such as `published_at`, `title`, `slug`, or a custom date field, including lists filtered by taxonomy terms. Paging by a boolean field or by a system column such as `version` also returns every entry now. The order of entries is unchanged, and cursors issued before the upgrade are still accepted.

- [#3651](https://github.com/emdash-cms/emdash/pull/3651) [`7583f9b`](https://github.com/emdash-cms/emdash/commit/7583f9bba933e50eb783d68d6efb0bf1b048a627) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes sites using `d1()` or `durableObjects()` with `session` enabled, or `hyperdrive()`, reading the preview secret and IP salt from the database on every editor page view, preview link, and comment request. `durableObjects()` without `session` did the same on write requests, such as comment submissions and reactions. Both values are now read once per isolate, as with other database adapters, so rotating one by deleting its `options` row takes effect after a redeploy.

- [#3694](https://github.com/emdash-cms/emdash/pull/3694) [`73304f4`](https://github.com/emdash-cms/emdash/commit/73304f42a1b1b689b3d121b4d9f021eca51c4fb2) Thanks [@ascorbic](https://github.com/ascorbic)! - Speeds up redirect matching on sites with many redirects. Public requests now load the enabled redirect rules in a single query and afterwards check one small row to see whether they changed, instead of reading the whole redirects table every 30 seconds in every Worker isolate. Redirect changes made in the admin, through the API, by automatic slug-change redirects, by seeding or by import take effect as before. A site that has just upgraded, or whose published redirect data is missing or damaged, keeps serving redirects from the redirects table while it rebuilds that data in the background.

- [#3692](https://github.com/emdash-cms/emdash/pull/3692) [`2a0cb93`](https://github.com/emdash-cms/emdash/commit/2a0cb93ebe2c74306762c4116fb2e02d49fdf6b2) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes enabling a disabled redirect that closes a redirect loop. Enabling it from the admin, the API, or a plugin now fails with a loop validation error, as creating or editing the same redirect already did, and the database rejects it for writers that bypass the API. Previously such an enable succeeded and the loop was only flagged with an admin warning, so automation that toggled a loop-closing redirect on will now receive a validation error instead. Loops that already exist on a site are unchanged and can still be disabled.

- [#3693](https://github.com/emdash-cms/emdash/pull/3693) [`d1b4402`](https://github.com/emdash-cms/emdash/commit/d1b4402b0fdafcc49ea603dbc1dffd70ee24e06a) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes redirect pattern precedence when several enabled pattern rules match the same path. The earliest-created rule now always wins. Previously the winner depended on database row order, which could change after a rule was edited or hit, particularly on PostgreSQL.

- [#3665](https://github.com/emdash-cms/emdash/pull/3665) [`1d93e7c`](https://github.com/emdash-cms/emdash/commit/1d93e7c66871a9aa796f9d7e2db144b55b4e1b2d) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes the settings page of a plugin installed from the registry or marketplace showing the plugin's internal ID, such as `r_dsniqezhchh4zone`, as its title instead of its name. The admin endpoint `GET /_emdash/api/admin/plugins/:id` returns these plugins with the same details as the plugin list instead of a 404.

- [#3625](https://github.com/emdash-cms/emdash/pull/3625) [`0a5c604`](https://github.com/emdash-cms/emdash/commit/0a5c604fe419419ed97a72b69272d6d94d13b4dd) Thanks [@swissky](https://github.com/swissky)! - Fixes partial `seo` and `social` settings updates through the MCP `settings_update` tool, `POST /_emdash/api/settings`, `setSiteSettings()`, and seeds applied with `onConflict: "update"` replacing the whole stored object. Sending one field, for example `{ seo: { googleVerification: "…" } }`, used to remove the custom `robots.txt`, title separator, other verification code, and default social image that were not in the request. Fields you leave out now keep their stored values. To clear a text field inside `seo` or `social`, send it as an empty string, for example `{ social: { twitter: "" } }`.

- [#3617](https://github.com/emdash-cms/emdash/pull/3617) [`7d06f5d`](https://github.com/emdash-cms/emdash/commit/7d06f5d4dfb5df8d81e33b6d42a341e61368bafe) Thanks [@enesismail](https://github.com/enesismail)! - Fixes publishing staged content after one of its fields is deleted. Existing drafts now publish against the current collection schema while their historical revision data remains available.

- [#3528](https://github.com/emdash-cms/emdash/pull/3528) [`189c6b3`](https://github.com/emdash-cms/emdash/commit/189c6b31566c5bcf3b2eb48972f1ee346d175503) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes returning visitors seeing a stale page after a content publish until the next deploy. A cached page whose `Astro.cache.set()` hints carry no last-modified time no longer sends the build time as `Last-Modified`, so browsers download the page again instead of receiving a 304. The fix applies to pages that pass no hint and to pages that pass only tag hints, such as those from `getSiteSettingsWithCacheHint()` and `getMenuWithCacheHint()` or from a query that returned no entries. Pages whose hints carry a last-modified time, such as those from `getEmDashEntry()`, still revalidate against both the content and the build.

- [#3402](https://github.com/emdash-cms/emdash/pull/3402) [`f925a89`](https://github.com/emdash-cms/emdash/commit/f925a89feca7dcea4c2026cf840673a4594d2015) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes taxonomy-filtered `getEmDashCollection()` listings sorted by `published_at` or `created_at` (the default) on D1 and SQLite reading up to the whole collection when the term has fewer than 200 entries or the listing filters by several terms. These listings now read only the term's entries. A single term with 200 or more entries is still read in date order and stops once the page is full.

- [#3608](https://github.com/emdash-cms/emdash/pull/3608) [`a40b7ce`](https://github.com/emdash-cms/emdash/commit/a40b7ce52ed205c61624b5c291a0a2388f1b9280) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes image, feed and JSON responses for signed-in editors, such as admin media library thumbnails, waiting on the visual editing toolbar. Only HTML pages show the toolbar, so EmDash no longer renders it for other responses.

- [#3650](https://github.com/emdash-cms/emdash/pull/3650) [`6940899`](https://github.com/emdash-cms/emdash/commit/69408991639957d25b4de3290f131fa43bd0b27e) Thanks [@swissky](https://github.com/swissky)! - Fixes pages that answer a missing entry with `Astro.rewrite("/404")`: the visual editing toolbar (and the client toolbar script) now appears once instead of twice, and the 404 response is kept out of the route cache, so the URL starts working as soon as the entry is published.

- [#3622](https://github.com/emdash-cms/emdash/pull/3622) [`0b9426e`](https://github.com/emdash-cms/emdash/commit/0b9426e1bffa435f40388bb4864acd8d0d5bc989) Thanks [@swissky](https://github.com/swissky)! - Fixes comment Turnstile verification ignoring `EMDASH_TURNSTILE_SECRET_KEY` and `TURNSTILE_SECRET_KEY` when they are set at runtime, for example with `wrangler secret put` or container environment variables. Comment submissions were accepted without a Turnstile check unless the key was also present when the site was built, and a key present at build time was written into the server bundle.
  
  On Node, the key must now be in the server's process environment at runtime. If you only set it in a `.env` file, load it when starting the server (for example `node --env-file=.env ./dist/server/entry.mjs`) or set it in your host's environment; otherwise comments are accepted without a Turnstile check. If your server build output was shared or stored, rotate a key that was present at build time.
- Updated dependencies [[`75de9a4`](https://github.com/emdash-cms/emdash/commit/75de9a4b4bdb3a8298456b4b730aee31c86897fd), [`85ab50c`](https://github.com/emdash-cms/emdash/commit/85ab50c60e325b564b427d2d7ffde7e903c2dbf7), [`3a00448`](https://github.com/emdash-cms/emdash/commit/3a00448c05604eab26c4ad2b851d33b2de8bc605), [`aa2f87e`](https://github.com/emdash-cms/emdash/commit/aa2f87ec16701402561efee529bcf8517f627031), [`76b06d4`](https://github.com/emdash-cms/emdash/commit/76b06d4e40a9d37ab44ec7109e75339af7aeef85), [`a880323`](https://github.com/emdash-cms/emdash/commit/a88032398d25a93c8159392e4bad4c495f5cd89a), [`5346dc8`](https://github.com/emdash-cms/emdash/commit/5346dc80750d8d3e25338e058597890fe79724d6), [`2288fa6`](https://github.com/emdash-cms/emdash/commit/2288fa6715310ea76907a83c6fe33a08eeda1fbf), [`90d71f9`](https://github.com/emdash-cms/emdash/commit/90d71f92f1e9e73e150e555923a1b666b2496980), [`253b6f9`](https://github.com/emdash-cms/emdash/commit/253b6f91b5c6780635fd6bc83f18dc7ecb2f6111), [`fc90e27`](https://github.com/emdash-cms/emdash/commit/fc90e276ead6e35246051e662cd1f9e1401f33c1), [`5de3bdc`](https://github.com/emdash-cms/emdash/commit/5de3bdc4310f6bcca013f05002f05a61e208b2a4), [`e811952`](https://github.com/emdash-cms/emdash/commit/e8119527d3832f5a0fe3c4a74b74226647eaae55), [`7f4064c`](https://github.com/emdash-cms/emdash/commit/7f4064c63d0c4979ca6aa7b499ff533930007cc8), [`998ce63`](https://github.com/emdash-cms/emdash/commit/998ce63d8412ab400f02d0915785aa75b7edfc9d), [`fc019e4`](https://github.com/emdash-cms/emdash/commit/fc019e4ee5ac9ca09418bd97735c0f0890e4813d), [`1942b3a`](https://github.com/emdash-cms/emdash/commit/1942b3aae0ba09d074afc424d738767b676651f8)]:
  - @emdash-cms/admin@1.1.0
  - @emdash-cms/blocks@1.1.0
  - @emdash-cms/auth@1.1.0
  - @emdash-cms/gutenberg-to-portable-text@1.1.0

## 1.0.1

### Patch Changes

- [#3515](https://github.com/emdash-cms/emdash/pull/3515) [`d274172`](https://github.com/emdash-cms/emdash/commit/d27417232e61bf85c1c613fecbe6875e1172af0d) Thanks [@ascorbic](https://github.com/ascorbic)! - Releases EmDash 1.0. This release includes breaking changes, such as removing APIs deprecated during 0.x. Before upgrading from 0.42, read the [upgrade guide](https://docs.emdashcms.com/upgrade-to-v1/), which lists each change and how to migrate.
  
  From this release, breaking changes ship only in a new major version.

- [#3531](https://github.com/emdash-cms/emdash/pull/3531) [`f6674fa`](https://github.com/emdash-cms/emdash/commit/f6674fa346964f78ab329fbce1bc4f3b9f0d05ef) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes recreating a deleted collection failing with `Collection "…" already exists` (`COLLECTION_EXISTS`) on sites with media usage tracking turned on, which new sites turn on automatically. Creating a collection through the admin, the API, MCP or a seed now finishes the deleted collection's media usage cleanup first, so sites already stuck in this state can recreate the collection after upgrading.
  
  Each create attempt does a bounded amount of that cleanup. If it can't finish, for example because the deleted collection referenced media from many entries, the error says the collection is being deleted, and the next attempt continues where the last one stopped. If the cleanup has failed, the error says so and includes the deleted collection's ID in `details.deletedCollectionId`. Both errors keep the `COLLECTION_EXISTS` code. Send that ID as `{ "collectionId": "…" }` to `POST /_emdash/api/admin/media-usage/collection-deletions/retry`, which requires the `schema:manage` permission and, for API tokens, the `admin` scope, then create the collection again.

- [#3537](https://github.com/emdash-cms/emdash/pull/3537) [`02c2ad3`](https://github.com/emdash-cms/emdash/commit/02c2ad3b2e6993ca3fbc19fe51086a4cb8c0bb8a) Thanks [@akapug](https://github.com/akapug)! - Fixes the WordPress media URL rewrite matching a URL map key that carries a query string by its base URL. A key such as an attachment's `?attachment_id=7` shortlink also matched the home page, so the rewrite pointed links to the home page at that file. Such a key now matches that URL only, and inside a text field only where the URL ends with it.

- [#3518](https://github.com/emdash-cms/emdash/pull/3518) [`bc54886`](https://github.com/emdash-cms/emdash/commit/bc5488685c8a886e2375d066d7424ddf4aac9a78) Thanks [@ascorbic](https://github.com/ascorbic)! - Moves the subpaths that only EmDash itself loads under `emdash/internal/`, and the D1 and Hyperdrive migration executors under `@emdash-cms/cloudflare/internal/`. These paths are not public API: their exports can change or be removed in any release.
  
  Sites that use `emdash()` in `astro.config.mjs` need no changes. The integration, the database, cache and media adapter helpers, and the first-party Cloudflare, workerd sandbox and plugin-test packages all load the new paths automatically.
  
  The following subpaths are removed:
  
  | Removed subpath                                   | Now loaded from                                            |
  | ------------------------------------------------- | ---------------------------------------------------------- |
  | `emdash/routes/*`                                 | `emdash/internal/routes/*`                                 |
  | `emdash/middleware/auth`                          | `emdash/internal/middleware/auth`                          |
  | `emdash/middleware/redirect`                      | `emdash/internal/middleware/redirect`                      |
  | `emdash/middleware/request-context`               | `emdash/internal/middleware/request-context`               |
  | `emdash/middleware/setup`                         | `emdash/internal/middleware/setup`                         |
  | `emdash/middleware/media-usage-write-fence`       | `emdash/internal/middleware/media-usage-write-fence`       |
  | `emdash/image-endpoint`                           | `emdash/internal/image-endpoint`                           |
  | `emdash/media/local-runtime`                      | `emdash/internal/media/local-runtime`                      |
  | `emdash/object-cache/memory`                      | `emdash/internal/object-cache/memory`                      |
  | `emdash/db/sqlite-migrations`                     | `emdash/internal/db/sqlite-migrations`                     |
  | `emdash/db/libsql-migrations`                     | `emdash/internal/db/libsql-migrations`                     |
  | `emdash/db/postgres-migrations`                   | `emdash/internal/db/postgres-migrations`                   |
  | `emdash/database/migration-lock`                  | `emdash/internal/database/migration-lock`                  |
  | `emdash/database/pg-migration-lock`               | `emdash/internal/database/pg-migration-lock`               |
  | `emdash/plugins/host`                             | `emdash/internal/plugins/host`                             |
  | `emdash/plugins/http-wire`                        | `emdash/internal/plugins/http-wire`                        |
  | `emdash/plugins/adapt-sandbox-entry`              | `emdash/internal/plugins/adapt-sandbox-entry`              |
  | `emdash/plugin-test-runtime`                      | `emdash/internal/plugin-test-runtime`                      |
  | `emdash/testing/registry`                         | `emdash/internal/testing/registry`                         |
  | `@emdash-cms/cloudflare/db/d1-migrations`         | `@emdash-cms/cloudflare/internal/db/d1-migrations`         |
  | `@emdash-cms/cloudflare/db/hyperdrive-migrations` | `@emdash-cms/cloudflare/internal/db/hyperdrive-migrations` |
  
  #### What should I do?
  
  If your project or package imports one of the removed subpaths directly, replace the import with a public entrypoint:
  
  - To configure a database, object cache or media provider, use `sqlite()`, `libsql()` or `postgres()` from `emdash/db`, `memoryCache()` from `emdash/astro`, or `localMedia()` from `emdash/media`, instead of writing their entrypoints by hand.
  - To test a plugin, use `@emdash-cms/plugin-test` instead of `emdash/plugin-test-runtime`.
  - To run your own middleware before EmDash's, set the `middleware.outer` option of `emdash()`. The internal auth, setup, redirect and request-context middleware have no public replacement.
  
  Rebuild after upgrading. `emdash migrate` rejects a migration manifest written by an earlier EmDash version.

- [#3519](https://github.com/emdash-cms/emdash/pull/3519) [`0b4be2c`](https://github.com/emdash-cms/emdash/commit/0b4be2c8388744153a7a82814bfe91af09a1fcfd) Thanks [@ascorbic](https://github.com/ascorbic)! - Removes the deprecated `Comments` and `CommentForm` exports from `emdash/ui`. Sites that still import either component from `emdash/ui` fail to build after upgrading.
  
  Import them from `emdash/ui/comments` instead:
  
  ```diff
  - import { Comments, CommentForm } from "emdash/ui";
  + import { Comments, CommentForm } from "emdash/ui/comments";
  ```
  
  The components themselves are unchanged. Importing them from `emdash/ui/comments` also keeps comment styles off pages that don't render comments.

- [#3519](https://github.com/emdash-cms/emdash/pull/3519) [`0b4be2c`](https://github.com/emdash-cms/emdash/commit/0b4be2c8388744153a7a82814bfe91af09a1fcfd) Thanks [@ascorbic](https://github.com/ascorbic)! - Removes the deprecated `emdash dev` and `emdash auth secret` CLI commands. Scripts that still call either command now exit with `Unknown command`.
  
  - Replace `emdash dev` with the site's own dev script, such as `pnpm dev`, or run `astro dev` directly. The site then uses its configured database adapter instead of a local `./data.db`, which `emdash dev` created and migrated even on D1 sites. The `url` key under `emdash` in `package.json` was only read by `emdash dev --types` and can be deleted. To generate types from a remote instance, run `emdash types --url <site-url>`, or set `EMDASH_URL`.
  - Remove `emdash auth secret` from scripts. New installations don't need `EMDASH_AUTH_SECRET`. Existing installations should keep the value they already have, since EmDash still reads it to keep commenter-IP hashes stable. To encrypt plugin secrets at rest, generate `EMDASH_ENCRYPTION_KEY` with `emdash secrets generate`.

- [#3519](https://github.com/emdash-cms/emdash/pull/3519) [`0b4be2c`](https://github.com/emdash-cms/emdash/commit/0b4be2c8388744153a7a82814bfe91af09a1fcfd) Thanks [@ascorbic](https://github.com/ascorbic)! - Removes the deprecated `experimental.registry` integration option. Sites that still set it now fail at startup with an error pointing to the top-level `registry` option, including sites that already set `registry` alongside it. The value is not silently ignored, because that would drop the configured aggregator and release-age policy.
  
  Move the value unchanged. The top-level option accepts the same URL string or configuration object:
  
  ```diff
   emdash({
  -	experimental: {
  -		registry: {
  -			aggregatorUrl: "https://registry.example.com",
  -			policy: { minimumReleaseAge: "48h" },
  -		},
  -	},
  +	registry: {
  +		aggregatorUrl: "https://registry.example.com",
  +		policy: { minimumReleaseAge: "48h" },
  +	},
   });
  ```
  
  The `experimental` option is also removed from the `EmDashConfig` type, because it has no remaining settings. An empty `experimental: {}` block is still ignored at runtime, but TypeScript configs should delete it. Registry configuration errors in the admin now always name the top-level `registry.*` setting.

- [#3322](https://github.com/emdash-cms/emdash/pull/3322) [`1cdca21`](https://github.com/emdash-cms/emdash/commit/1cdca21510fa10eec6969fa4f83b20e6f9663870) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes `routeCtx.ui` being undefined for the declared Block Kit pages and dashboard widgets of plugins registered in `plugins: []`. They now receive the administrator's locale, text direction, and surface, as sandboxed plugins do, so a plugin can localize its Block Kit text in both install modes.

- [#3519](https://github.com/emdash-cms/emdash/pull/3519) [`0b4be2c`](https://github.com/emdash-cms/emdash/commit/0b4be2c8388744153a7a82814bfe91af09a1fcfd) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds a startup warning when an installed or configured plugin declares deprecated capability names such as `read:content`, `network:fetch` or `page:inject`. The warning appears once per plugin and lists each current replacement, for example `read:content → content:read`. The deprecated names keep working throughout 1.x. If a plugin you use triggers the warning, update it, or ask its author to publish a version that uses the current names.
  
  `aiSearch()` from `@emdash-cms/cloudflare` now declares `content:read`, so it no longer triggers the warning.
- Updated dependencies [[`6f2ef26`](https://github.com/emdash-cms/emdash/commit/6f2ef26f7dc2bd79e191ba5d361923277b35da68), [`c66b49b`](https://github.com/emdash-cms/emdash/commit/c66b49b8f98226e3fed4e63f25131551e278edbb), [`9e297d6`](https://github.com/emdash-cms/emdash/commit/9e297d6964c3b1875581167484491948f0677fe7), [`d274172`](https://github.com/emdash-cms/emdash/commit/d27417232e61bf85c1c613fecbe6875e1172af0d), [`a3609fb`](https://github.com/emdash-cms/emdash/commit/a3609fb4c2f514d944e693e1f7eded82aeccdb56), [`618591e`](https://github.com/emdash-cms/emdash/commit/618591e94fb87af2bb0086d882f0c2c766635874), [`0b4be2c`](https://github.com/emdash-cms/emdash/commit/0b4be2c8388744153a7a82814bfe91af09a1fcfd)]:
  - @emdash-cms/admin@1.0.1
  - @emdash-cms/auth@1.0.1
  - @emdash-cms/blocks@1.0.1
  - @emdash-cms/gutenberg-to-portable-text@1.0.1

## 1.0.1-rc.1

### Patch Changes

- [#3531](https://github.com/emdash-cms/emdash/pull/3531) [`f6674fa`](https://github.com/emdash-cms/emdash/commit/f6674fa346964f78ab329fbce1bc4f3b9f0d05ef) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes recreating a deleted collection failing with `Collection "…" already exists` (`COLLECTION_EXISTS`) on sites with media usage tracking turned on, which new sites turn on automatically. Creating a collection through the admin, the API, MCP or a seed now finishes the deleted collection's media usage cleanup first, so sites already stuck in this state can recreate the collection after upgrading.
  
  Each create attempt does a bounded amount of that cleanup. If it can't finish, for example because the deleted collection referenced media from many entries, the error says the collection is being deleted, and the next attempt continues where the last one stopped. If the cleanup has failed, the error says so and includes the deleted collection's ID in `details.deletedCollectionId`. Both errors keep the `COLLECTION_EXISTS` code. Send that ID as `{ "collectionId": "…" }` to `POST /_emdash/api/admin/media-usage/collection-deletions/retry`, which requires the `schema:manage` permission and, for API tokens, the `admin` scope, then create the collection again.

- [#3537](https://github.com/emdash-cms/emdash/pull/3537) [`02c2ad3`](https://github.com/emdash-cms/emdash/commit/02c2ad3b2e6993ca3fbc19fe51086a4cb8c0bb8a) Thanks [@akapug](https://github.com/akapug)! - Fixes the WordPress media URL rewrite matching a URL map key that carries a query string by its base URL. A key such as an attachment's `?attachment_id=7` shortlink also matched the home page, so the rewrite pointed links to the home page at that file. Such a key now matches that URL only, and inside a text field only where the URL ends with it.

- [#3322](https://github.com/emdash-cms/emdash/pull/3322) [`1cdca21`](https://github.com/emdash-cms/emdash/commit/1cdca21510fa10eec6969fa4f83b20e6f9663870) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes `routeCtx.ui` being undefined for the declared Block Kit pages and dashboard widgets of plugins registered in `plugins: []`. They now receive the administrator's locale, text direction, and surface, as sandboxed plugins do, so a plugin can localize its Block Kit text in both install modes.
- Updated dependencies [[`c66b49b`](https://github.com/emdash-cms/emdash/commit/c66b49b8f98226e3fed4e63f25131551e278edbb), [`9e297d6`](https://github.com/emdash-cms/emdash/commit/9e297d6964c3b1875581167484491948f0677fe7), [`a3609fb`](https://github.com/emdash-cms/emdash/commit/a3609fb4c2f514d944e693e1f7eded82aeccdb56), [`618591e`](https://github.com/emdash-cms/emdash/commit/618591e94fb87af2bb0086d882f0c2c766635874)]:
  - @emdash-cms/admin@1.0.1-rc.1
  - @emdash-cms/auth@1.0.1-rc.1
  - @emdash-cms/blocks@1.0.1-rc.1
  - @emdash-cms/gutenberg-to-portable-text@1.0.1-rc.1

## 1.0.1-rc.0

### Patch Changes

- [#3515](https://github.com/emdash-cms/emdash/pull/3515) [`d274172`](https://github.com/emdash-cms/emdash/commit/d27417232e61bf85c1c613fecbe6875e1172af0d) Thanks [@ascorbic](https://github.com/ascorbic)! - Releases EmDash 1.0. This release includes breaking changes, such as removing APIs deprecated during 0.x. The other entries for this version describe each one and how to migrate; check them before upgrading from 0.42.
  
  From this release, breaking changes ship only in a new major version.
  
  The first 1.x version is 1.0.1. npm also lists a deprecated `emdash@1.0.0`, published by mistake from 0.7-era code; do not install it.

- [#3518](https://github.com/emdash-cms/emdash/pull/3518) [`bc54886`](https://github.com/emdash-cms/emdash/commit/bc5488685c8a886e2375d066d7424ddf4aac9a78) Thanks [@ascorbic](https://github.com/ascorbic)! - Moves the subpaths that only EmDash itself loads under `emdash/internal/`, and the D1 and Hyperdrive migration executors under `@emdash-cms/cloudflare/internal/`. These paths are not public API: their exports can change or be removed in any release.
  
  Sites that use `emdash()` in `astro.config.mjs` need no changes. The integration, the database, cache and media adapter helpers, and the first-party Cloudflare, workerd sandbox and plugin-test packages all load the new paths automatically.
  
  The following subpaths are removed:
  
  | Removed subpath                                   | Now loaded from                                            |
  | ------------------------------------------------- | ---------------------------------------------------------- |
  | `emdash/routes/*`                                 | `emdash/internal/routes/*`                                 |
  | `emdash/middleware/auth`                          | `emdash/internal/middleware/auth`                          |
  | `emdash/middleware/redirect`                      | `emdash/internal/middleware/redirect`                      |
  | `emdash/middleware/request-context`               | `emdash/internal/middleware/request-context`               |
  | `emdash/middleware/setup`                         | `emdash/internal/middleware/setup`                         |
  | `emdash/middleware/media-usage-write-fence`       | `emdash/internal/middleware/media-usage-write-fence`       |
  | `emdash/image-endpoint`                           | `emdash/internal/image-endpoint`                           |
  | `emdash/media/local-runtime`                      | `emdash/internal/media/local-runtime`                      |
  | `emdash/object-cache/memory`                      | `emdash/internal/object-cache/memory`                      |
  | `emdash/db/sqlite-migrations`                     | `emdash/internal/db/sqlite-migrations`                     |
  | `emdash/db/libsql-migrations`                     | `emdash/internal/db/libsql-migrations`                     |
  | `emdash/db/postgres-migrations`                   | `emdash/internal/db/postgres-migrations`                   |
  | `emdash/database/migration-lock`                  | `emdash/internal/database/migration-lock`                  |
  | `emdash/database/pg-migration-lock`               | `emdash/internal/database/pg-migration-lock`               |
  | `emdash/plugins/host`                             | `emdash/internal/plugins/host`                             |
  | `emdash/plugins/http-wire`                        | `emdash/internal/plugins/http-wire`                        |
  | `emdash/plugins/adapt-sandbox-entry`              | `emdash/internal/plugins/adapt-sandbox-entry`              |
  | `emdash/plugin-test-runtime`                      | `emdash/internal/plugin-test-runtime`                      |
  | `emdash/testing/registry`                         | `emdash/internal/testing/registry`                         |
  | `@emdash-cms/cloudflare/db/d1-migrations`         | `@emdash-cms/cloudflare/internal/db/d1-migrations`         |
  | `@emdash-cms/cloudflare/db/hyperdrive-migrations` | `@emdash-cms/cloudflare/internal/db/hyperdrive-migrations` |
  
  #### What should I do?
  
  If your project or package imports one of the removed subpaths directly, replace the import with a public entrypoint:
  
  - To configure a database, object cache or media provider, use `sqlite()`, `libsql()` or `postgres()` from `emdash/db`, `memoryCache()` from `emdash/astro`, or `localMedia()` from `emdash/media`, instead of writing their entrypoints by hand.
  - To test a plugin, use `@emdash-cms/plugin-test` instead of `emdash/plugin-test-runtime`.
  - To run your own middleware before EmDash's, set the `middleware.outer` option of `emdash()`. The internal auth, setup, redirect and request-context middleware have no public replacement.
  
  Rebuild after upgrading. `emdash migrate` rejects a migration manifest written by an earlier EmDash version.

- [#3519](https://github.com/emdash-cms/emdash/pull/3519) [`0b4be2c`](https://github.com/emdash-cms/emdash/commit/0b4be2c8388744153a7a82814bfe91af09a1fcfd) Thanks [@ascorbic](https://github.com/ascorbic)! - Removes the deprecated `Comments` and `CommentForm` exports from `emdash/ui`. Sites that still import either component from `emdash/ui` fail to build after upgrading.
  
  Import them from `emdash/ui/comments` instead:
  
  ```diff
  - import { Comments, CommentForm } from "emdash/ui";
  + import { Comments, CommentForm } from "emdash/ui/comments";
  ```
  
  The components themselves are unchanged. Importing them from `emdash/ui/comments` also keeps comment styles off pages that don't render comments.

- [#3519](https://github.com/emdash-cms/emdash/pull/3519) [`0b4be2c`](https://github.com/emdash-cms/emdash/commit/0b4be2c8388744153a7a82814bfe91af09a1fcfd) Thanks [@ascorbic](https://github.com/ascorbic)! - Removes the deprecated `emdash dev` and `emdash auth secret` CLI commands. Scripts that still call either command now exit with `Unknown command`.
  
  - Replace `emdash dev` with the site's own dev script, such as `pnpm dev`, or run `astro dev` directly. The site then uses its configured database adapter instead of a local `./data.db`, which `emdash dev` created and migrated even on D1 sites. The `url` key under `emdash` in `package.json` was only read by `emdash dev --types` and can be deleted. To generate types from a remote instance, run `emdash types --url <site-url>`, or set `EMDASH_URL`.
  - Remove `emdash auth secret` from scripts. New installations don't need `EMDASH_AUTH_SECRET`. Existing installations should keep the value they already have, since EmDash still reads it to keep commenter-IP hashes stable. To encrypt plugin secrets at rest, generate `EMDASH_ENCRYPTION_KEY` with `emdash secrets generate`.

- [#3519](https://github.com/emdash-cms/emdash/pull/3519) [`0b4be2c`](https://github.com/emdash-cms/emdash/commit/0b4be2c8388744153a7a82814bfe91af09a1fcfd) Thanks [@ascorbic](https://github.com/ascorbic)! - Removes the deprecated `experimental.registry` integration option. Sites that still set it now fail at startup with an error pointing to the top-level `registry` option, including sites that already set `registry` alongside it. The value is not silently ignored, because that would drop the configured aggregator and release-age policy.
  
  Move the value unchanged. The top-level option accepts the same URL string or configuration object:
  
  ```diff
   emdash({
  -	experimental: {
  -		registry: {
  -			aggregatorUrl: "https://registry.example.com",
  -			policy: { minimumReleaseAge: "48h" },
  -		},
  -	},
  +	registry: {
  +		aggregatorUrl: "https://registry.example.com",
  +		policy: { minimumReleaseAge: "48h" },
  +	},
   });
  ```
  
  The `experimental` option is also removed from the `EmDashConfig` type, because it has no remaining settings. An empty `experimental: {}` block is still ignored at runtime, but TypeScript configs should delete it. Registry configuration errors in the admin now always name the top-level `registry.*` setting.

- [#3519](https://github.com/emdash-cms/emdash/pull/3519) [`0b4be2c`](https://github.com/emdash-cms/emdash/commit/0b4be2c8388744153a7a82814bfe91af09a1fcfd) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds a startup warning when an installed or configured plugin declares deprecated capability names such as `read:content`, `network:fetch` or `page:inject`. The warning appears once per plugin and lists each current replacement, for example `read:content → content:read`. The deprecated names keep working throughout 1.x. If a plugin you use triggers the warning, update it, or ask its author to publish a version that uses the current names.
  
  `aiSearch()` from `@emdash-cms/cloudflare` now declares `content:read`, so it no longer triggers the warning.
- Updated dependencies [[`d274172`](https://github.com/emdash-cms/emdash/commit/d27417232e61bf85c1c613fecbe6875e1172af0d), [`0b4be2c`](https://github.com/emdash-cms/emdash/commit/0b4be2c8388744153a7a82814bfe91af09a1fcfd)]:
  - @emdash-cms/admin@1.0.1-rc.0
  - @emdash-cms/auth@1.0.1-rc.0
  - @emdash-cms/blocks@1.0.1-rc.0
  - @emdash-cms/gutenberg-to-portable-text@1.0.1-rc.0
  - @emdash-cms/auth-atproto@0.2.45-rc.0
