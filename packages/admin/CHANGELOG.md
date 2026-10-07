# @emdash-cms/admin

<!-- emdash-changelog-archive: ./changelog/0.16.0-to-0.38.0.md -->

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

- [#3744](https://github.com/emdash-cms/emdash/pull/3744) [`1e275ae`](https://github.com/emdash-cms/emdash/commit/1e275ae8b4f1a2766c2f29d2efa8d5a8492233d6) Thanks [@swissky](https://github.com/swissky)! - Adds an **Email users** action to **Settings > General** that tells every other active user where the site now lives. Each user gets an email with a button to the sign-in page at the configured `siteUrl`, or the **Site URL** when none is set, and a note that passkeys from the old address don't work there. The email does not sign anyone in. The action needs an email provider, passkey sign-in, and the `users:manage` permission, and shows how many emails were sent and how many the provider rejected.
  
  The emails come from the new `POST /_emdash/api/settings/domain/notify` endpoint. It accepts signed-in sessions only and can be used 3 times per hour per site.

- [#3710](https://github.com/emdash-cms/emdash/pull/3710) [`06a9146`](https://github.com/emdash-cms/emdash/commit/06a9146a069bff01555adf5341e5e4de2b6a22b4) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Redesigns the content editor as a page. The entry's title field is a large heading at the top, the `content` field's Portable Text editor sits under it without a frame, and one bar above the page holds the back link, the entry title, the save status, and **Live View**, **Preview**, and **Publish**. Distraction-free mode uses the same bar and adds **Discard changes** and **Schedule**.
  
  - **Writing:** Enter in the title, or Down Arrow at its end, moves into the body, and Up Arrow on the body's first line moves back. Clicking below the last block continues writing at the end. Select All selects the text of the block holding the caret, and the whole document on a second press. Backspace at the start of a heading or code block turns it into text, and next to an image, divider, or embed selects it before deleting it.
  - **Toolbar:** the formatting toolbar floats above the text and stays in view while you scroll, with the text fading out under it. When it doesn't fit, it scrolls sideways. Its block buttons convert blocks the same way as **Turn into** and the slash menu, and use the same names.
  - **Blocks:** hovering a block shows **+**, which starts a line below it with the slash menu open (Alt-click starts one above) and takes the line away again if the menu closes before anything is typed after the slash, and a handle to drag the block or open its menu: **Turn into**, **Align**, **Continue numbering** and **Restart numbering**, **Duplicate**, **Move up** and **Move down**, and **Delete**. Escape selects the block holding the caret, and the arrow keys then move between blocks. A block inserted or pasted while another is selected goes after it, and a block inserted with the caret in text goes after that block instead of splitting it. Clicking where there's no line for the caret, such as between two embeds or above an embed at the start, leaves the caret where it was; use **+** to add a line there.
  - **Quotes and lists:** quotes hold paragraphs, and list items hold text and nested lists, as Portable Text stores them. A heading, code block, image, or other block typed, pasted, or dropped into a quote or list lands beside it, where it's saved, instead of disappearing on save. A pasted quote or list that holds one is split around it, and a numbered list keeps counting after it. Alignment is offered only outside quotes and lists, where it's kept.
  - **Slash menu:** commands are grouped, show the Markdown that creates each block, and match abbreviated searches such as `/bl` for **Bullet List**, whole titles such as `/heading 2`, and the Markdown itself, such as `/#`. Headings 4 to 6 appear when you search for them.
  - **Selection toolbar:** **Turn into**, link, bold, italic, underline, strikethrough, and inline code, with subscript, superscript, alignment, and **Clear formatting** under **More formatting**. Clicking a link, or otherwise placing the caret in it, shows where it goes, with **Edit link** and **Remove link**, instead of selecting the whole link. A link typed as a bare domain, such as `example.com`, gets `https://`, a relative path such as `../about.html` stays as typed, and a link the editor can't use says so. The selection, link, table, and image toolbars are announced as toolbars, and the Left and Right arrow keys move between their buttons.
  - **Narrow screens:** when the bar is narrow, as on phones and tablets, its secondary buttons, **Unpublish** included, show only their icons, and **Publish now** and **Publish changes** read **Publish**, so the bar stays on one row with the entry title readable. Block handles also show on touch screens wide enough for them.
  
  Other Portable Text fields keep the framed editor. `PortableTextEditor` adds a `variant` prop (`"boxed"` by default, or `"document"`) and an `onArrowUpAtStart` callback.

- [#3827](https://github.com/emdash-cms/emdash/pull/3827) [`373446f`](https://github.com/emdash-cms/emdash/commit/373446f973d33703718f2f0c22322548fad6ab1a) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Adds a video block to the rich text editor. Type `/video` to choose a Media Library video or upload one. Closing the picker leaves an empty video block in place, which you can fill later by clicking it or dropping a video file on it. Video files dropped or pasted anywhere in the text also upload to the Media Library and appear where you dropped them. The video plays in the editor at the width of the text, with a caption field under it and **Replace video** and **Delete video** in its corner. A video's **Used in** tab in the Media Library lists the entries that use it in a video block.
  
  On the site, `Video` from `emdash/ui` renders the `video` block as the browser's own player with its caption. Media Library videos play from your storage's public URL when one is configured, and need the block's `asset.url`: a block without one renders nothing on the site, and the editor shows it as unplayable. A block whose `asset.provider` names a media provider renders from that provider's embed. An empty video block is saved without `asset` and renders nothing.
  
  Uploads follow `maxUploadSize`, 50 MiB by default. The admin's content security policy now allows media from `blob:` and `https:` URLs (`media-src 'self' blob: https:`), as it already did for images. This lets the admin read a video's size before uploading it, and preview a video block whose `asset.url` is on another site. Before, videos uploaded from the admin in production were saved without a width and height.
  
  #### What should I do?
  
  - If a plugin already defines a `video` block, the editor keeps using the plugin's block: it doesn't offer the built-in Video block, and dropped video files aren't uploaded. On the site, the plugin's renderer still wins; a plugin without one gets `Video` for blocks that have only the built-in fields. In TypeScript, narrowing `PortableTextBlock` on `_type === "video"` now gives `PortableTextVideoBlock | PortableTextUnknownBlock`, so reading the plugin's own fields needs a check.
  - If you edit Portable Text with `portableTextToProsemirror` and `prosemirrorToPortableText` from `emdash` in your own TipTap editor, add a `videoBlock` node with the attributes `src`, `mediaId`, `provider`, `caption`, `width` and `height` to its schema. `portableTextToProsemirror` turns every built-in video block into that node, and a schema without it can't load the document.
  - The media usage API and `emdash/client` can now return the reference type `"portable_text_video"` for a video used in a video block. Code that checks every reference type, or validates the list, needs to accept it.
  - With Astro's content security policy turned on and media on another host, allow that host in `media-src`.

- [#3773](https://github.com/emdash-cms/emdash/pull/3773) [`e6fe5d4`](https://github.com/emdash-cms/emdash/commit/e6fe5d498a527b5e6bd6cbc80ee5220ce626673c) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Adds numbered pages to every collection list in the admin. The All and Trash tabs load one page of entries at a time, so a collection opens with 20 entries instead of fetching 100, and both tabs use the Media Library's pagination footer pinned to the bottom of the screen: the entry range, 20, 50, or 100 entries per page, and controls to jump to any page. The Trash badge counts every trashed entry instead of stopping at 50, and every trashed entry is reachable.
  
  Selections persist across pages. Changing the search, a filter, the locale, or the collection clears them.
  
  `GET /_emdash/api/content/{collection}` and `GET /_emdash/api/content/{collection}/trash` accept a 1-based `page` parameter instead of `cursor`. A numbered page returns `total` and no `nextCursor`, and sending both `page` and `cursor` returns a `400` validation error. Cursor pagination is unchanged.
  
  `ContentList` accepts optional `pagination` and `trashPagination` props for numbered pages; without them it behaves as before.

- [#3744](https://github.com/emdash-cms/emdash/pull/3744) [`1e275ae`](https://github.com/emdash-cms/emdash/commit/1e275ae8b4f1a2766c2f29d2efa8d5a8492233d6) Thanks [@swissky](https://github.com/swissky)! - Adds a **Continue on** button to **Settings > General** after a site moves to a new domain. Passkeys only work at the address where they were created, so a user signed in at the old address can select the button to sign in at the new one without email. The single-use link expires after 5 minutes and opens **Settings > Security**, ready to add a passkey for the new address. The button appears when you are signed in at an address other than the **Site URL**, or the configured `siteUrl` when one is set. It is not shown when an external provider such as Cloudflare Access handles sign-in.
  
  The link comes from the new `POST /_emdash/api/auth/handover` endpoint, which accepts signed-in sessions only and allows 5 links per user every 5 minutes. `GET /_emdash/api/settings/domain` now also returns `siteOrigin`, the address the link points to.
  
  `@emdash-cms/auth` exports `createMagicLinkUrl()`, which creates a single-use sign-in link without sending an email.

### Patch Changes

- [#3878](https://github.com/emdash-cms/emdash/pull/3878) [`5c1ebc3`](https://github.com/emdash-cms/emdash/commit/5c1ebc39200f4945feaa59289ce1de4aee4a8a07) Thanks [@swissky](https://github.com/swissky)! - Fixes a blank screen when an entry in the admin content editor fails to open. A missing entry now shows a not-found page, and a subscriber opening an unpublished entry is told that their role can only view published content. Other errors show the error message with a retry button.

- [#3798](https://github.com/emdash-cms/emdash/pull/3798) [`90f39e0`](https://github.com/emdash-cms/emdash/commit/90f39e0cd6635d5c4243d1235b0095fe24d6a850) Thanks [@DiogoDuart3](https://github.com/DiogoDuart3)! - Fixes long block type descriptions in the "Add block" picker of a blocks field running into the next column. Each option now stays within its column and its description wraps.

- [#3925](https://github.com/emdash-cms/emdash/pull/3925) [`a17408f`](https://github.com/emdash-cms/emdash/commit/a17408fe6326999e2acf94949f657621291d54e5) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes the byline editor not scrolling when its fields don't fit in the window, which hid the lower fields, such as the linked user, custom fields and translations, behind the dialog's buttons. The form now scrolls, and the title and buttons stay in place.

- [#3852](https://github.com/emdash-cms/emdash/pull/3852) [`f5406f8`](https://github.com/emdash-cms/emdash/commit/f5406f841d80a42b4ec2d9784333705a32551fad) Thanks [@miljan-aleksic](https://github.com/miljan-aleksic)! - Completes the Catalan admin translations so every admin string is localized, keeping the source's punctuation, ICU placeholders, and rich-text tags verbatim, leaving "Token" and technical terms untranslated, and using `exemple.com` for example domains.

- [#3831](https://github.com/emdash-cms/emdash/pull/3831) [`3787eb9`](https://github.com/emdash-cms/emdash/commit/3787eb9aef2ce5f3dfbac98cfdc6073fa95188d5) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fixes false conflict errors when saving SEO fields, including OG images, after a clean content editor refreshes a cached entry. Background refreshes preserve unsaved edits and their conflict protection, and delayed older reads cannot replace the revision from a successful save.

- [#3728](https://github.com/emdash-cms/emdash/pull/3728) [`e63cc44`](https://github.com/emdash-cms/emdash/commit/e63cc44a953f4786fa211a8989a6547267635be5) Thanks [@huketo](https://github.com/huketo)! - Keeps the WordPress migration-key and site-URL fields inside their cards on narrow screens, while preserving the wider-screen layout. Technical keys and URLs remain left-to-right in RTL locales, and the site-URL input exposes its localized name to assistive technologies.

- [#2791](https://github.com/emdash-cms/emdash/pull/2791) [`c77c6cf`](https://github.com/emdash-cms/emdash/commit/c77c6cfe55611ac9937dbfc23ad48205f324f075) Thanks [@SL33PiNg](https://github.com/SL33PiNg)! - Completes the Thai (`th`) admin translation. Thai admins now see localized text across the publishing calendar, editor image toolbar, site settings, authentication, plugin registry and capability consent dialogs, site transfer, and the media library, which previously fell back to English for 1,725 of 3,188 strings.

- [#3558](https://github.com/emdash-cms/emdash/pull/3558) [`395087d`](https://github.com/emdash-cms/emdash/commit/395087d82596489f0cc7207b9cd668d8e73462a6) Thanks [@kgni](https://github.com/kgni)! - Translates the new admin strings into Danish, including the Bylines page, the bulk tag dialog, sections, menus and the content type editor.

- [#3744](https://github.com/emdash-cms/emdash/pull/3744) [`1e275ae`](https://github.com/emdash-cms/emdash/commit/1e275ae8b4f1a2766c2f29d2efa8d5a8492233d6) Thanks [@swissky](https://github.com/swissky)! - Fixes email links pointing to the address a site was set up on after it moved to a new domain. Sign-in, invitation, self-signup, recovery, and comment notification emails now use the **Site URL** from **Settings > General** when `siteUrl`, `EMDASH_SITE_URL`, or `SITE_URL` is not configured, and fall back to the setup address when the field is empty. Only the origin of the **Site URL** is used, and it must use `https://` unless the host is a loopback address. A configured `siteUrl` still takes precedence. `emdash export-seed` no longer copies the **Site URL** into the seed.
  
  If you don't configure `siteUrl` and the **Site URL** field holds an address that doesn't serve this site's admin, for example an old domain, links in these emails point there after upgrading. Check the field before upgrading; clearing it restores the previous behavior. Seeds that set `settings.url`, including seeds exported by earlier versions, still fill in the **Site URL**, so remove `url` from a seed copied from another site before using it.

- [#3721](https://github.com/emdash-cms/emdash/pull/3721) [`24a4327`](https://github.com/emdash-cms/emdash/commit/24a432743bfab219a9231006cc371eb903a988ab) Thanks [@miljan-aleksic](https://github.com/miljan-aleksic)! - Updates Spanish (Spain) admin translations to add missing strings, remove deprecated ones, correct wrong and inconsistent translations, and switch to the informal "tú" tone.

- [#3796](https://github.com/emdash-cms/emdash/pull/3796) [`9f09f60`](https://github.com/emdash-cms/emdash/commit/9f09f60d61d1efc14ed094a2fa5cf866a74fee04) Thanks [@DiogoDuart3](https://github.com/DiogoDuart3)! - Adds European Portuguese (Português (Portugal), `pt-PT`) translations for the admin UI. The locale is selectable from the language picker and uses Portuguese date formats in the calendar and date settings. Browsers that ask for `pt-PT` now get this locale instead of Brazilian Portuguese, and a site whose language is set to `pt-PT` sends its invite, sign-in and recovery emails in European Portuguese. Other Portuguese variants, and plain `pt`, still resolve to Brazilian Portuguese.

- [#3701](https://github.com/emdash-cms/emdash/pull/3701) [`8885267`](https://github.com/emdash-cms/emdash/commit/8885267484f48e93b28a7bcf8f58165b46fb0f3f) Thanks [@ShaneMuir](https://github.com/ShaneMuir)! - Fixes the field editor silently closing and discarding changes when the server rejects a field update, such as toggling `required` or `unique` on a field that already has content (which needs a manual content migration). The dialog now stays open and shows the server's error message instead of the toggle looking like it reverted on its own.

- [#3813](https://github.com/emdash-cms/emdash/pull/3813) [`c07437f`](https://github.com/emdash-cms/emdash/commit/c07437f489f85e5447ae4e5e92951de3a10ade47) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fixes generated admin identifier slugs for non-ASCII labels in content types, taxonomies, byline fields, relations, and fields.
  
  Labels like `Größe` now produce `groesse` and `Título` becomes `titulo`, including equivalent decomposed Unicode input. Labels that cannot produce a valid ASCII identifier, such as `名前` or `2024年`, require a manually entered slug and show an inline message.
  
  Adds editable slugs for new repeater sub-fields and blocks duplicate sub-field slugs before saving. Existing sub-field slugs stay read-only so relabeling preserves the keys used by saved content.

- [#3835](https://github.com/emdash-cms/emdash/pull/3835) [`b3e17f6`](https://github.com/emdash-cms/emdash/commit/b3e17f6a5aae92d7b3353a3c115a4e130910fe9e) Thanks [@danielmlr](https://github.com/danielmlr)! - Completes the German admin translations so German-speaking editors see localized text for the publishing calendar, domain settings, HTML and iframe blocks, media controls, visual editing, and plugin permissions.

- [#3293](https://github.com/emdash-cms/emdash/pull/3293) [`595fd15`](https://github.com/emdash-cms/emdash/commit/595fd1566d086b072c450f5958abe592cf043a5a) Thanks [@itaides](https://github.com/itaides)! - Adds Hebrew (עברית) to the admin language picker. The admin renders right-to-left in Hebrew, its date pickers use Hebrew month and weekday names, and its strings are translated as of October 2026. Strings added to the admin later appear in English until the catalog is updated.

- [#3872](https://github.com/emdash-cms/emdash/pull/3872) [`392ade3`](https://github.com/emdash-cms/emdash/commit/392ade3cfbefdf8affdffcbbe8fc99b55aa5e6ae) Thanks [@Zahid09987](https://github.com/Zahid09987)! - Adds Indonesian translations for recently introduced admin UI strings, including slug-generation hints, the sub-field slug placeholder, and sub-field validation messages.

- [#3851](https://github.com/emdash-cms/emdash/pull/3851) [`3bcd2cb`](https://github.com/emdash-cms/emdash/commit/3bcd2cbb949b6eb69182446cc6c49a38cf156d7f) Thanks [@Zahid09987](https://github.com/Zahid09987)! - Adds Indonesian translations for the site domain-change flow, general settings screen, marketplace capability labels, and visual-editing toolbar strings.

- [#3795](https://github.com/emdash-cms/emdash/pull/3795) [`36aee2d`](https://github.com/emdash-cms/emdash/commit/36aee2d17225a44cd4060f1ae158e723e3730372) Thanks [@DiogoDuart3](https://github.com/DiogoDuart3)! - Fixes the content editor failing to open any entry with a date field when the site timezone setting is not a valid IANA timezone (for example `Lisboa` instead of `Europe/Lisbon`). The editor now falls back to UTC for such a value instead of crashing, and the settings API and MCP settings tool reject an unrecognized timezone with a validation error. A site that already stores one can still save its other settings, and can fix the timezone in Settings > General.

- [#3931](https://github.com/emdash-cms/emdash/pull/3931) [`9538600`](https://github.com/emdash-cms/emdash/commit/95386001e4ac5a964fb568fa3d75113fe539e0fe) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes the error message on the invite and signup pages ending in a bare colon when the server responds with an error page instead of an error message. The message no longer includes the HTTP status text, which browsers leave empty over HTTP/2 and HTTP/3, and it can now be translated.

- [#3789](https://github.com/emdash-cms/emdash/pull/3789) [`6d2a3bb`](https://github.com/emdash-cms/emdash/commit/6d2a3bbb8ed3f9fcfedda7a929a2de6659b60b58) Thanks [@maikunari](https://github.com/maikunari)! - Aligns the Japanese admin text with the long-vowel spelling used elsewhere in the catalog: ブラウザー and エディター now replace ブラウザ and エディタ in the passkey messages, the rich text editor label, and the WordPress import notice.

- [#3718](https://github.com/emdash-cms/emdash/pull/3718) [`841a5b3`](https://github.com/emdash-cms/emdash/commit/841a5b3f3bc1c01c35b3e770eeab673b3c5bb870) Thanks [@huketo](https://github.com/huketo)! - Expands the Korean admin translations to cover almost every admin screen and corrects terminology in the existing Korean text. Korean remains disabled in the locale selector.
  
  The catalog now covers sign-in, passkeys, invitation and sign-in emails, and device authorization; the dashboard, setup, and shared notifications, error, and loading screens; content lists, editing, publishing, and scheduling; rich-text, image, gallery, and block editing; content types, fields, relationships, and references; media; bylines and taxonomies; menus, widgets, and sections; site settings, users, redirects, backups, and transfer tokens; plugins, themes, and the registry; and site transfer and WordPress imports.
  
  The Korean text distinguishes content authors from public byline profiles, and the permanent-delete confirmation now shows the content title instead of leaving it blank.

- [#3732](https://github.com/emdash-cms/emdash/pull/3732) [`2210c2c`](https://github.com/emdash-cms/emdash/commit/2210c2c7688a8d407143dfe4d565898674470412) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes plugin permissions for sending email, handling outgoing email, and adding page scripts and styles showing as raw capability names in the admin. They now have readable labels in the plugin list, marketplace, and install consent dialog.

- [#3923](https://github.com/emdash-cms/emdash/pull/3923) [`142da40`](https://github.com/emdash-cms/emdash/commit/142da4056a644a4eef4f79ced5c107aa32be5b89) Thanks [@ascorbic](https://github.com/ascorbic)! - Reduces the admin's JavaScript by about 220 KB by loading the date picker and date-format localization for the active language on demand, instead of bundling every language.

- [#3933](https://github.com/emdash-cms/emdash/pull/3933) [`d72b615`](https://github.com/emdash-cms/emdash/commit/d72b6151d772acb6ff16c8ad9063bc7ea22f69d8) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes admin error messages for menus, taxonomies, widgets, users, and other screens that stayed in English when the server answered with an error page instead of an error message, such as a gateway error. They now follow the admin language.

- [#3010](https://github.com/emdash-cms/emdash/pull/3010) [`2f59cc3`](https://github.com/emdash-cms/emdash/commit/2f59cc37872843381d00f810eeb829b9cdba566c) Thanks [@eisenbruch](https://github.com/eisenbruch)! - Fixes the content list showing a "Pending changes" badge on entries that have never been published. A draft or scheduled entry has a draft revision and no live revision, which the list read as a difference between the two. The badge now appears only where there is a published version for the changes to be pending against, matching the state the editor shows for the same entry.

- [#3773](https://github.com/emdash-cms/emdash/pull/3773) [`e6fe5d4`](https://github.com/emdash-cms/emdash/commit/e6fe5d498a527b5e6bd6cbc80ee5220ce626673c) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes keyboard focus in the Media Library pagination controls. Focus no longer jumps to those controls when the library reloads after a search or filter change; it returns to them only after a page they requested finishes loading, and stays wherever you moved it during the load. Picking a page or a page size from a dropdown returns focus to that dropdown, and when the page reached disables the button you pressed, such as Previous on the first page, focus moves to the page picker instead of being lost.

- [#3710](https://github.com/emdash-cms/emdash/pull/3710) [`06a9146`](https://github.com/emdash-cms/emdash/commit/06a9146a069bff01555adf5341e5e4de2b6a22b4) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes newly inserted HTML, iframe, and code blocks in the content editor. HTML and iframe blocks now highlight the selected tab, and their arrow keys move between tabs. Tab now reaches a code block's language and copy buttons, and the arrow keys move between them. Until now, these worked only for blocks that were there when the page loaded.

- [#3758](https://github.com/emdash-cms/emdash/pull/3758) [`d0c7384`](https://github.com/emdash-cms/emdash/commit/d0c73843245234ea1230d570b1ed9f586f6698c1) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes the admin's new-entry form ignoring field default values: a boolean field with `defaultValue: true` started switched off, and saving the entry untouched could store no value. New entries in the admin now start with each field's default value.
  
  Manifest field descriptors now include stored field defaults as `defaultValue`, except for relation-bound reference fields.

- [#3369](https://github.com/emdash-cms/emdash/pull/3369) [`b854616`](https://github.com/emdash-cms/emdash/commit/b85461614b9ceaa071573dce717a2a2799963eb8) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes plugin admin pages and dashboard widgets showing no feedback after a Block Kit button click or other action. Until the plugin responds, the content now dims under a loading indicator, and screen readers announce that it is updating.

- [#3546](https://github.com/emdash-cms/emdash/pull/3546) [`2c8c12a`](https://github.com/emdash-cms/emdash/commit/2c8c12a6b84d7c790944aebd5e7e090514fccfd6) Thanks [@swissky](https://github.com/swissky)! - Adds `group` to plugin admin pages, in native plugin descriptors and in `admin.pages` of `emdash-plugin.jsonc`, to place them in collapsible admin sidebar folders. A page whose group matches the group of a collection shown in the sidebar appears inside that folder, after its collections and taxonomies. Pages that share any other group, from one plugin or several, fold into one folder in the Plugins section. Pages without a group stay where they are.

- [#3737](https://github.com/emdash-cms/emdash/pull/3737) [`8867aba`](https://github.com/emdash-cms/emdash/commit/8867aba83db09eee7d4d87b4ac6cdea327c6c113) Thanks [@ryofukutani](https://github.com/ryofukutani)! - Fixes plugin block cards in the content editor dropping `number_input` values from their summary line, so a block whose only identifying field is a number (such as an episode or video number) no longer shows just the block type.

- [#1899](https://github.com/emdash-cms/emdash/pull/1899) [`e9cf2c3`](https://github.com/emdash-cms/emdash/commit/e9cf2c3ff804b54ccfdceb2fbe93e74e26799833) Thanks [@swissky](https://github.com/swissky)! - Adds an optional `urlTemplate` prop to the `core:recent-posts` widget (e.g. `"/blog/:slug"` or `"/:slug"` for catch-all routes), using the same `:collection`, `:id`, `:slug`, and `:path` tokens as LiveSearch's `routeMap`, with a localized label in the admin widget form. Without a template the widget links exactly as before.

- [#3559](https://github.com/emdash-cms/emdash/pull/3559) [`f6ee57e`](https://github.com/emdash-cms/emdash/commit/f6ee57e92445d7c01df6863968875cb979bfae87) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes Select All inside code blocks in the admin and inline visual editors so it selects only the code instead of the entire document.

- [#3810](https://github.com/emdash-cms/emdash/pull/3810) [`788a371`](https://github.com/emdash-cms/emdash/commit/788a3715d8d88f865dc30099b9bec36f7d731636) Thanks [@miljan-aleksic](https://github.com/miljan-aleksic)! - Updates the Serbian (Latin) admin translations to address the user informally ("ti") throughout. Singular imperatives and second-person wording replace the previous mix of formal and plural forms, passive constructions become active, and redundant possessive pronouns are dropped. A mixed-script character, a misspelling, and a few English calques are also corrected.

- [#3771](https://github.com/emdash-cms/emdash/pull/3771) [`550e59b`](https://github.com/emdash-cms/emdash/commit/550e59b51ab4d0bc3ad3ab13e70d94ca96313863) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes the visual editing toolbar's Publish button switching to English after a save when the toolbar is shown in another language. The button now keeps its translated label, and the toolbar's status badges and image popover can be translated as well.

- [#3786](https://github.com/emdash-cms/emdash/pull/3786) [`8037f5a`](https://github.com/emdash-cms/emdash/commit/8037f5aa284a65d938d6cb4337c88239bed19a47) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fixes plugin dashboard widget titles so they translate through the same shared Lingui catalog as admin page labels. Widgets without a `title` still fall back to the raw widget id.

- [#3751](https://github.com/emdash-cms/emdash/pull/3751) [`dea8f58`](https://github.com/emdash-cms/emdash/commit/dea8f589d230220bc81c3b8bd1e8efe3d30f906b) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes the WordPress import's media step stopping partway with "No result received from media import" on Cloudflare Workers Paid, where a batch of large photos could exceed the default 30-second CPU limit. The admin now imports media in smaller batches to stay within that limit.

- [#3860](https://github.com/emdash-cms/emdash/pull/3860) [`c5cef43`](https://github.com/emdash-cms/emdash/commit/c5cef432fe040efa36038420eb26e71c3ce94754) Thanks [@leevincent](https://github.com/leevincent)! - Completes the Traditional Chinese (Taiwan, `zh-TW`) admin translations so editors see localized text in the publishing calendar, media library, site transfer tools, plugin permission dialogs, and visual editing toolbar.
- Updated dependencies [[`2c8c12a`](https://github.com/emdash-cms/emdash/commit/2c8c12a6b84d7c790944aebd5e7e090514fccfd6), [`2210c2c`](https://github.com/emdash-cms/emdash/commit/2210c2c7688a8d407143dfe4d565898674470412)]:
  - @emdash-cms/plugin-types@0.6.0
  - @emdash-cms/blocks@1.2.0

## 1.1.0

### Minor Changes

- [#3680](https://github.com/emdash-cms/emdash/pull/3680) [`75de9a4`](https://github.com/emdash-cms/emdash/commit/75de9a4b4bdb3a8298456b4b730aee31c86897fd) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Adds a publishing calendar to the admin. It shows published entries on their publication date, and scheduled entries and scheduled updates on their scheduled date, across every visible collection and locale. Contributors and higher roles open it from **Calendar** in the sidebar, the command palette, or the dashboard's **Scheduled** count.
  
  **Month** shows a grid of days and **Agenda** lists entries by day; phones and other narrow screens open the agenda and show the month as a date picker. Both views place entries in the site's time zone, show browser-zone times when the viewer's zone differs, mark schedules that missed their time as **Overdue**, filter by collection, locale, and state, and keep the view, month, filters, and open entry in the URL. When a month's grid holds more than 1,000 entries, the calendar shows the first 1,000 and marks the days it didn't load.
  
  Selecting an entry opens a side panel with its details, a link to the editor, and a preview or live link. Users who can publish the entry can also reschedule it, remove its schedule, or publish an overdue entry immediately. Ctrl-click or Cmd-click opens the entry in the editor instead.

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

- [#3594](https://github.com/emdash-cms/emdash/pull/3594) [`5346dc8`](https://github.com/emdash-cms/emdash/commit/5346dc80750d8d3e25338e058597890fe79724d6) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Adds image drag-and-drop and paste to the Portable Text editor. Dropped image files and pasted images or screenshots upload to the Media Library and are inserted between blocks, with a preview shown while each upload runs and the upload error shown in place if it fails. Pasting rich content from apps such as Word is unchanged.

- [#3657](https://github.com/emdash-cms/emdash/pull/3657) [`2288fa6`](https://github.com/emdash-cms/emdash/commit/2288fa6715310ea76907a83c6fe33a08eeda1fbf) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Adds a toolbar above a selected image in the Portable Text editor, replacing the buttons in the image's corner.
  
  - **Toolbar:** Replace, Alt text, alignment (None, Left, Center, Right), Link, Image settings, and Delete.
  - **Captions:** typed directly under the image. An empty caption shows a placeholder, and Enter starts a new paragraph after the image.
  - **Alt text:** the button is highlighted once an image has a description, and hovering it shows the description. Alt text that is only a Media Library image's file name doesn't count.
  - **Image settings:** the panel now closes when the image is changed outside it, discarding edits that weren't applied, so **Apply** no longer overwrites those changes.

### Patch Changes

- [#3655](https://github.com/emdash-cms/emdash/pull/3655) [`aa2f87e`](https://github.com/emdash-cms/emdash/commit/aa2f87ec16701402561efee529bcf8517f627031) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes admin date pickers showing English month and day names and a Sunday week start when the admin language is Danish or Georgian. The publish scheduling and publication date dialogs and the content list's date range filter now display the calendar in the admin language, with weeks starting on Monday.

- [#3676](https://github.com/emdash-cms/emdash/pull/3676) [`90d71f9`](https://github.com/emdash-cms/emdash/commit/90d71f92f1e9e73e150e555923a1b666b2496980) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fixes mobile layout overflow on the Widgets and hierarchical taxonomy management screens.

- [#3581](https://github.com/emdash-cms/emdash/pull/3581) [`253b6f9`](https://github.com/emdash-cms/emdash/commit/253b6f91b5c6780635fd6bc83f18dc7ecb2f6111) Thanks [@danielmlr](https://github.com/danielmlr)! - Completes the German admin translations so German-speaking editors see localized text on the Sections page, in the content type navigation settings (icon, hiding from navigation and the dashboard quick action) and in the plugin permission for reading bylines. The full-width image alignment now reads "Volle Breite" instead of "Voll".

- [#3704](https://github.com/emdash-cms/emdash/pull/3704) [`fc90e27`](https://github.com/emdash-cms/emdash/commit/fc90e276ead6e35246051e662cd1f9e1401f33c1) Thanks [@CacheMeOwside](https://github.com/CacheMeOwside)! - Adds missing Hindi translations for validation messages, media uploads, imports, publishing notices, and editing locks in the admin UI.

- [#3630](https://github.com/emdash-cms/emdash/pull/3630) [`e811952`](https://github.com/emdash-cms/emdash/commit/e8119527d3832f5a0fe3c4a74b74226647eaae55) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes the Portable Text editor so text typed after a newly applied link remains plain instead of extending the link.

- [#3583](https://github.com/emdash-cms/emdash/pull/3583) [`7f4064c`](https://github.com/emdash-cms/emdash/commit/7f4064c63d0c4979ca6aa7b499ff533930007cc8) Thanks [@leostera](https://github.com/leostera)! - Fixes Reading settings so the date format example updates as you type and displays month names in the admin language. Formats the preview cannot render can still be saved for use by themes. Adds searchable timezone suggestions and rejects newly entered unrecognized values while allowing unchanged existing timezone settings to be saved.

- [#3624](https://github.com/emdash-cms/emdash/pull/3624) [`998ce63`](https://github.com/emdash-cms/emdash/commit/998ce63d8412ab400f02d0915785aa75b7edfc9d) Thanks [@kegren](https://github.com/kegren)! - Updates the Swedish admin translation to cover every string and renames "Bylines" to "Skribenter" in the Swedish admin.

- [#3609](https://github.com/emdash-cms/emdash/pull/3609) [`fc019e4`](https://github.com/emdash-cms/emdash/commit/fc019e4ee5ac9ca09418bd97735c0f0890e4813d) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes a broken preview while uploading images the browser can't display, such as HEIC or TIFF files, dropped or pasted into the Portable Text editor. The editor now follows the Media Library upload list: files over 8 MB, or in formats other than JPEG, PNG, GIF, WebP and AVIF, upload with a plain placeholder instead of a preview. The featured and Open Graph image fields now use the same "Only image files can be uploaded here." message as the editor. Screen readers no longer hear an extra "Loading" announcement while an image uploads into those fields.

- [#3685](https://github.com/emdash-cms/emdash/pull/3685) [`1942b3a`](https://github.com/emdash-cms/emdash/commit/1942b3aae0ba09d074afc424d738767b676651f8) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fixes media uploads so supported video files (.mp4, .webm, .mov) report width and height, and prevents the Media Library details panel from truncating the Uploaded date when dimensions are absent.
  
  Videos now have their display dimensions extracted via the browser's `<video>` element and sent through both the direct upload form and the signed-URL confirmation payload, so the detail panel can show a Dimensions row for them just like images. Audio and other non-dimensional files continue to omit dimensions cleanly.
  
  The details grid also keeps the Uploaded row in the wider left column when no dimensions row is present, so the full upload date remains readable.
- Updated dependencies [[`85ab50c`](https://github.com/emdash-cms/emdash/commit/85ab50c60e325b564b427d2d7ffde7e903c2dbf7), [`3a00448`](https://github.com/emdash-cms/emdash/commit/3a00448c05604eab26c4ad2b851d33b2de8bc605)]:
  - @emdash-cms/blocks@1.1.0

## 1.0.1

### Patch Changes

- [#3534](https://github.com/emdash-cms/emdash/pull/3534) [`6f2ef26`](https://github.com/emdash-cms/emdash/commit/6f2ef26f7dc2bd79e191ba5d361923277b35da68) Thanks [@MA2153](https://github.com/MA2153)! - Completes the Arabic (العربية) translation of the admin UI. Every admin string now has an Arabic translation, so Arabic users no longer see English fallback text.

- [#3545](https://github.com/emdash-cms/emdash/pull/3545) [`c66b49b`](https://github.com/emdash-cms/emdash/commit/c66b49b8f98226e3fed4e63f25131551e278edbb) Thanks [@palockocz](https://github.com/palockocz)! - Adds the missing Czech translations for media to the admin UI.

- [#3533](https://github.com/emdash-cms/emdash/pull/3533) [`9e297d6`](https://github.com/emdash-cms/emdash/commit/9e297d6964c3b1875581167484491948f0677fe7) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes the byline editor discarding changes typed right after it opened. On slower sites the full byline record could finish loading after you started typing and replace your edits, so Save stored the original values. Reopening a byline straight after saving it now also shows the saved values.

- [#3515](https://github.com/emdash-cms/emdash/pull/3515) [`d274172`](https://github.com/emdash-cms/emdash/commit/d27417232e61bf85c1c613fecbe6875e1172af0d) Thanks [@ascorbic](https://github.com/ascorbic)! - Releases EmDash 1.0. This release includes breaking changes, such as removing APIs deprecated during 0.x. Before upgrading from 0.42, read the [upgrade guide](https://docs.emdashcms.com/upgrade-to-v1/), which lists each change and how to migrate.
  
  From this release, breaking changes ship only in a new major version.

- [#3522](https://github.com/emdash-cms/emdash/pull/3522) [`a3609fb`](https://github.com/emdash-cms/emdash/commit/a3609fb4c2f514d944e693e1f7eded82aeccdb56) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes collection and taxonomy names appearing in lowercase inside sentences of the German admin, such as "Noch keine kategorien vorhanden." on a taxonomy page or "beiträge durchsuchen..." in a content list's search field. German capitalizes nouns, so the German admin now shows these names as the site defines them. Other admin languages still lowercase them.
  
  In admin languages other than English, the dialogs for creating, editing and deleting terms now show the translated word for "term" instead of the English one when the taxonomy has no singular name, such as a taxonomy created in the admin.

- [#3324](https://github.com/emdash-cms/emdash/pull/3324) [`618591e`](https://github.com/emdash-cms/emdash/commit/618591e94fb87af2bb0086d882f0c2c766635874) Thanks [@danielmlr](https://github.com/danielmlr)! - Completes the German admin translations so German-speaking editors see localized text in site transfer (export, import review and approvals), content relations and reference fields, bulk term assignment, the bylines directory, block types, invitation and sign-in emails, CLI device sign-in, the menu dialog, API token scopes and the dashboard's core update notice, as well as in the taxonomy picker, the link and code block pickers, save errors and plugin registry notices. The code block language button now reads "Sprache festlegen" instead of "Sprache speichern".
  
  Makes the German terminology consistent across the admin. Some words German-speaking editors already know change: plugins are now "Plugins" instead of "Erweiterungen", collections "Sammlungen" instead of "Kollektionen", bylines "Autorenangaben" instead of "Autorenzeilen", "Website" replaces "Webseite", publishing is "veröffentlichen" instead of "publizieren" and unpublishing "zurückziehen" instead of "depublizieren", and delete actions say "löschen" while remove actions keep "entfernen". Progress messages, button labels and quotation marks follow one style throughout, and strings whose German said something different from the English now match it.

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
- Updated dependencies [[`d274172`](https://github.com/emdash-cms/emdash/commit/d27417232e61bf85c1c613fecbe6875e1172af0d)]:
  - @emdash-cms/blocks@1.0.1

## 1.0.1-rc.1

### Patch Changes

- [#3545](https://github.com/emdash-cms/emdash/pull/3545) [`c66b49b`](https://github.com/emdash-cms/emdash/commit/c66b49b8f98226e3fed4e63f25131551e278edbb) Thanks [@palockocz](https://github.com/palockocz)! - Adds the missing Czech translations for media to the admin UI.

- [#3533](https://github.com/emdash-cms/emdash/pull/3533) [`9e297d6`](https://github.com/emdash-cms/emdash/commit/9e297d6964c3b1875581167484491948f0677fe7) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes the byline editor discarding changes typed right after it opened. On slower sites the full byline record could finish loading after you started typing and replace your edits, so Save stored the original values. Reopening a byline straight after saving it now also shows the saved values.

- [#3522](https://github.com/emdash-cms/emdash/pull/3522) [`a3609fb`](https://github.com/emdash-cms/emdash/commit/a3609fb4c2f514d944e693e1f7eded82aeccdb56) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes collection and taxonomy names appearing in lowercase inside sentences of the German admin, such as "Noch keine kategorien vorhanden." on a taxonomy page or "beiträge durchsuchen..." in a content list's search field. German capitalizes nouns, so the German admin now shows these names as the site defines them. Other admin languages still lowercase them.
  
  In admin languages other than English, the dialogs for creating, editing and deleting terms now show the translated word for "term" instead of the English one when the taxonomy has no singular name, such as a taxonomy created in the admin.

- [#3324](https://github.com/emdash-cms/emdash/pull/3324) [`618591e`](https://github.com/emdash-cms/emdash/commit/618591e94fb87af2bb0086d882f0c2c766635874) Thanks [@danielmlr](https://github.com/danielmlr)! - Completes the German admin translations so German-speaking editors see localized text in site transfer (export, import review and approvals), content relations and reference fields, bulk term assignment, the bylines directory, block types, invitation and sign-in emails, CLI device sign-in, the menu dialog, API token scopes and the dashboard's core update notice, as well as in the taxonomy picker, the link and code block pickers, save errors and plugin registry notices. The code block language button now reads "Sprache festlegen" instead of "Sprache speichern".
  
  Makes the German terminology consistent across the admin. Some words German-speaking editors already know change: plugins are now "Plugins" instead of "Erweiterungen", collections "Sammlungen" instead of "Kollektionen", bylines "Autorenangaben" instead of "Autorenzeilen", "Website" replaces "Webseite", publishing is "veröffentlichen" instead of "publizieren" and unpublishing "zurückziehen" instead of "depublizieren", and delete actions say "löschen" while remove actions keep "entfernen". Progress messages, button labels and quotation marks follow one style throughout, and strings whose German said something different from the English now match it.
- Updated dependencies []:
  - @emdash-cms/blocks@1.0.1-rc.1

## 1.0.1-rc.0

### Patch Changes

- [#3515](https://github.com/emdash-cms/emdash/pull/3515) [`d274172`](https://github.com/emdash-cms/emdash/commit/d27417232e61bf85c1c613fecbe6875e1172af0d) Thanks [@ascorbic](https://github.com/ascorbic)! - Releases EmDash 1.0. This release includes breaking changes, such as removing APIs deprecated during 0.x. The other entries for this version describe each one and how to migrate; check them before upgrading from 0.42.
  
  From this release, breaking changes ship only in a new major version.
  
  The first 1.x version is 1.0.1. npm also lists a deprecated `emdash@1.0.0`, published by mistake from 0.7-era code; do not install it.

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
- Updated dependencies [[`d274172`](https://github.com/emdash-cms/emdash/commit/d27417232e61bf85c1c613fecbe6875e1172af0d)]:
  - @emdash-cms/blocks@1.0.1-rc.0

## 0.42.0

### Minor Changes

- [#3440](https://github.com/emdash-cms/emdash/pull/3440) [`03b6b3b`](https://github.com/emdash-cms/emdash/commit/03b6b3b441f624bd4ec376a23ce8789d4bf9e212) Thanks [@swissky](https://github.com/swissky)! - Adds two settings to the Navigation section of the content type editor:
  
  - **Icon**: the Phosphor icon name shown for the collection in the admin sidebar and in command palette navigation, such as `calendar-blank`. A sidebar folder shows the icon of the first collection in it that declares one. A name that does not resolve falls back to the collection's default icon.
  - **Hide from navigation**: removes the collection's sidebar entry, its command palette link, and its dashboard quick action. The collection stays reachable by URL, the API, and plugins. Collections that were already hidden now also drop out of the command palette.
  
  #### API and seed files
  
  The manifest now publishes each collection's `icon`. Collection icon names are now trimmed and limited to 64 characters in the schema API and the MCP collection tools, and limited to 64 characters in seed files, so longer values are rejected. Sending an empty `icon` clears the stored icon.

- [#3440](https://github.com/emdash-cms/emdash/pull/3440) [`03b6b3b`](https://github.com/emdash-cms/emdash/commit/03b6b3b441f624bd4ec376a23ce8789d4bf9e212) Thanks [@swissky](https://github.com/swissky)! - Adds an `admin.quickCreate` collection setting that removes the collection's "new entry" quick action from the admin dashboard. Set it to `false` in a seed file or through the schema API, or turn off "Quick action on the dashboard" in the content type editor's Navigation section. Collections without the setting keep their quick action. A schema API update replaces the whole `admin` object, so include any existing `admin.listColumns` in the same request.

- [#1939](https://github.com/emdash-cms/emdash/pull/1939) [`2410395`](https://github.com/emdash-cms/emdash/commit/24103953cc5873f76c36625b11251ac5864dca78) Thanks [@swissky](https://github.com/swissky)! - Adds a core update notice to the admin dashboard. When a newer EmDash version is available, admins see a dismissible banner with a link to the release notes. The banner names the newest release that has been public on npm for at least 24 hours.
  
  The check is on by default: the server sends a GET request to `https://registry.npmjs.org/emdash` at most once a day, in the background, with no site data. To wait longer before a release is announced, for example to match pnpm's `minimumReleaseAge`, or to turn the check off:
  
  ```js
  emdash({ updateCheck: { minimumReleaseAge: "7d" } }); // a duration string or seconds
  emdash({ updateCheck: false });
  ```
  
  The banner reads `GET /_emdash/api/admin/core-update`, which requires the new `updates:read` permission (admins only).

- [#3394](https://github.com/emdash-cms/emdash/pull/3394) [`38d200d`](https://github.com/emdash-cms/emdash/commit/38d200d7033149f09725efb53c23534bbb35e811) Thanks [@ttmx](https://github.com/ttmx)! - Adds the `bylines:read` plugin capability, which lets plugins read public byline profiles and the bylines credited on content entries through `ctx.bylines`.
  
  `ctx.bylines` provides `get()` and cursor-paginated `list()` for profiles, plus `getEntriesBylines()` for credits. `getEntriesBylines()` resolves up to 100 entries of one collection in a single call, so a search indexer or feed plugin can attach author names to a page of `ctx.content.list()` results:
  
  ```ts
  const page = await ctx.content.list("posts", { limit: 100 });
  const credits = await ctx.bylines.getEntriesBylines(
  	"posts",
  	page.items.map((entry) => entry.id),
  );
  ```
  
  Credits match what the site renders: the credits assigned in the editor, or the author's linked byline, marked `source: "inferred"`, when an entry has none. They resolve at the entry's own locale. Profiles omit the linked user account, guest flag, and byline custom field values.
  
  The capability is independent of `content:read` and `users:read`. It is available to native plugins and to sandboxed plugins on Cloudflare Worker Loader and Node.js workerd. Installation and update consent list it as a new permission.

- [#3495](https://github.com/emdash-cms/emdash/pull/3495) [`9358ede`](https://github.com/emdash-cms/emdash/commit/9358ede608670f3734be4e616f674bdf9a046dfe) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `admin.footerLabel` for customizing or hiding the label beside the version in the admin sidebar. The label defaults to `"EmDash"` instead of reusing the configured site name. Set it to a string to use another label, or set it to `false` to show the version alone.

### Patch Changes

- [#3513](https://github.com/emdash-cms/emdash/pull/3513) [`f465247`](https://github.com/emdash-cms/emdash/commit/f46524757512fa32293b7a38829b61d8be17d30a) Thanks [@swissky](https://github.com/swissky)! - Shows the language's name next to its code under "Content language" in the content editor sidebar, for example "Italiano IT", when the admin itself is not translated into that language. It showed the code twice before, as in "IT IT".

- [#3512](https://github.com/emdash-cms/emdash/pull/3512) [`70589bc`](https://github.com/emdash-cms/emdash/commit/70589bc8f35951bb40ec202416ad518ade6ffdc0) Thanks [@swissky](https://github.com/swissky)! - Shows relative times in the admin's language, such as "vor 5 Minuten" in German, in the dashboard's recent activity and the revision history. They were in English for every admin language before. English wording changes slightly: "5 mins ago" is now "5 minutes ago" and "1 day ago" is now "yesterday".

- [#3466](https://github.com/emdash-cms/emdash/pull/3466) [`6e58b48`](https://github.com/emdash-cms/emdash/commit/6e58b48e6cb6db096daa5ed729b29f105e622a9a) Thanks [@solaymanhaider](https://github.com/solaymanhaider)! - Adds Bengali (বাংলা) to the admin UI with a complete translation catalog. The locale is selectable from the language picker, and the date picker shows Bengali month and day names.

- [#3493](https://github.com/emdash-cms/emdash/pull/3493) [`148ff3e`](https://github.com/emdash-cms/emdash/commit/148ff3ee3e7bb86e30e88284bfff54eb286598ed) Thanks [@MA2153](https://github.com/MA2153)! - Fixes bulk term assignment only working with the built-in `tag` taxonomy. Editors can now add a term from any taxonomy, such as a category or a custom taxonomy, to up to 50 posts from a collection's bulk-actions bar or from that taxonomy's page. When several taxonomies apply to a collection, the dialog asks which one to use. The `POST /_emdash/api/taxonomies/bulk-tag` endpoint now accepts a term from any taxonomy, and matches only entries in the collections that use that taxonomy.

- [#3467](https://github.com/emdash-cms/emdash/pull/3467) [`1ba8fcb`](https://github.com/emdash-cms/emdash/commit/1ba8fcbb6d4236e96556b5486f4c89bd4fa16d18) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Updates the Bylines admin page with a full-width profile list and a focused create/edit dialog. Editors can see guest and account-link status at a glance while keeping search, custom fields, translations, and deletion in the same workflow.

- [#3441](https://github.com/emdash-cms/emdash/pull/3441) [`cc91805`](https://github.com/emdash-cms/emdash/commit/cc9180504251425429f4b41cc0d68028f834072f) Thanks [@swissky](https://github.com/swissky)! - Fixes the Features column on the Content Types list so the `seo` badge matches the collection's SEO setting. Collections with SEO turned on in the editor now show the badge, and collections with SEO turned off no longer show one.

- [#3492](https://github.com/emdash-cms/emdash/pull/3492) [`d583dfd`](https://github.com/emdash-cms/emdash/commit/d583dfd8d837850493174a1c76fb9de9aef7cbf5) Thanks [@kgni](https://github.com/kgni)! - Adds Danish (Dansk) translations for the admin UI. The locale is selectable from the language picker.

- [#3450](https://github.com/emdash-cms/emdash/pull/3450) [`db76eae`](https://github.com/emdash-cms/emdash/commit/db76eaee4dcd313e7f7e37c11b4bdd319ae33624) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fixes content type icons in the admin Content Types list so they keep a 1:1 aspect ratio when a collection description forces the Name cell to wrap.

- [#2898](https://github.com/emdash-cms/emdash/pull/2898) [`8b1b585`](https://github.com/emdash-cms/emdash/commit/8b1b585eed4d4a542ee24f449b5992e7aeb72380) Thanks [@scottbuscemi](https://github.com/scottbuscemi)! - Fixes rich text image settings so caption, alt text, tooltip, size, and alignment edits persist when authors click back into the post. Captions and tooltip titles also round-trip independently, so clearing a caption no longer restores it from the tooltip text.

- [#3439](https://github.com/emdash-cms/emdash/pull/3439) [`ff61df9`](https://github.com/emdash-cms/emdash/commit/ff61df9a518d12e57f5e134382413e4acccce3a9) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fixes WordPress WXR imports failing partway through large exports. The admin now imports taxonomy terms, content, and reusable blocks in bounded requests while preserving translation links and the complete import summary.
  
  Direct API clients can continue using a single request for small exports. Larger exports return `WXR_IMPORT_TOO_LARGE` and must use the chunked `taxonomy`, `content`, and `finalize` phases.

- [#3470](https://github.com/emdash-cms/emdash/pull/3470) [`ccd80cb`](https://github.com/emdash-cms/emdash/commit/ccd80cb34d6ae031abd06c6665a21eba01be2cab) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Updates the admin Menus pages with scannable navigation cards, a clearer create-menu dialog, and a menu editor with a labeled back link and matching add-action buttons.

- [#3509](https://github.com/emdash-cms/emdash/pull/3509) [`b84ea22`](https://github.com/emdash-cms/emdash/commit/b84ea2295d2402d5f6042c8cc1e9731e88ec50fc) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes the Portable Text editor saving dotted filenames and identifiers such as `README.md` and `setup.sh` as external links when authors type or paste them.

- [#3431](https://github.com/emdash-cms/emdash/pull/3431) [`72f10bd`](https://github.com/emdash-cms/emdash/commit/72f10bd493650d7e503966f8c74ce2bedc480308) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes the header of Block Kit plugin panels in the content editor sidebar so it lines up with the Revisions and Outline sections. The section's reorder handle no longer covers the panel's content or, while the panel is collapsed, the section below it.

- [#3491](https://github.com/emdash-cms/emdash/pull/3491) [`bf1aa14`](https://github.com/emdash-cms/emdash/commit/bf1aa14e79f08e46961fc804fb1c36be4f0d51e7) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes the publication-date dialog so editors can retry a date-only change after another writer updates the entry, without overwriting content fields.

- [#2966](https://github.com/emdash-cms/emdash/pull/2966) [`bc32000`](https://github.com/emdash-cms/emdash/commit/bc3200026fc31aa45d325807d89e551fb3d7822b) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes an entry's publication date saving without a warning when someone else changed the entry after the editor loaded it. The date change is now refused like any other save based on a stale read, and the editor shows its conflict notice with the option to save over the newer version.

- [#3325](https://github.com/emdash-cms/emdash/pull/3325) [`c23009d`](https://github.com/emdash-cms/emdash/commit/c23009d61d9366d4edd9b1dca8023708ed3b0b0a) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes an open redirect in the admin login page and the logout, magic-link sign-in, and dev-bypass routes: a `?redirect=` value containing a tab, carriage return, or line feed (for example `/%09/evil.example`) could send the browser to another site. Redirect values that contain control characters are now ignored.

- [#3475](https://github.com/emdash-cms/emdash/pull/3475) [`42bf9f5`](https://github.com/emdash-cms/emdash/commit/42bf9f5d59125782cb688164a4d31cc91c93aefa) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes reference fields showing "No references selected." when an entry is reopened in the admin within a minute of an autosave, publish, or schedule change. Adding a reference after such a reopen no longer removes the entries that were already saved.

- [#3471](https://github.com/emdash-cms/emdash/pull/3471) [`d96f039`](https://github.com/emdash-cms/emdash/commit/d96f039f4d5ebadfa46d304f77c6adb5a1db3958) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Updates the Sections library to use compact thumbnails for reusable sections, showing a supplied preview image when available and a section icon otherwise. Search, source filtering, creation, and actions now follow the other admin pages. At narrower widths, the section editor places details beneath the content so form fields stay within their panel.

- [#3327](https://github.com/emdash-cms/emdash/pull/3327) [`f796444`](https://github.com/emdash-cms/emdash/commit/f79644435efa642ad4bca5d8735efe07cc7aee71) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes stored cross-site scripting through `url` content fields. EmDash previously accepted `javascript:` and `data:` values, so a theme rendering `<a href={entry.data.website}>` could run an attacker's script on the site origin. A `url` field, including one inside a repeater or block, now accepts only these values:
  
  - `http:` and `https:` URLs
  - `mailto:` and `tel:` links
  - site-relative paths such as `/about`, and fragments such as `#contact`
  
  The REST API, MCP tools, site transfers, WordPress imports, and the admin editor reject any other value with a validation error. Seeds and plugin content updates also reject unsafe schemes and path forms that browsers resolve to another site, including `//example.com` and `/\\example.com`. The admin editor now accepts relative paths, fragments, `mailto:`, and `tel:` and keeps URL input left-to-right in every locale.
  
  Existing entries are not changed. An unsafe stored value is still returned by queries, and saving or duplicating that entry fails until the field is corrected. `sanitizeHref()` and `isSafeHref()` now reject unsafe protocol-relative, backslash-prefixed, and control-character forms when rendering older content.

- [#3303](https://github.com/emdash-cms/emdash/pull/3303) [`d8ea3fc`](https://github.com/emdash-cms/emdash/commit/d8ea3fc6538fe14fdefa553ae771bb2fa583e7ee) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes a denial-of-service in public URL routing: a collection URL pattern with several placeholders in one path segment, such as `/{a}{b}{c}{d}{e}x`, let a single crafted request tie up the server for seconds while `resolveEmDashPath()` matched it.
  
  Collection URL patterns now allow at most one placeholder per path segment. `/{year}/{month}/{slug}.html` and `/p-{id}/{slug}` are still valid, but `/{year}{month}/{slug}` and `/{slug}-{id}` are rejected when a collection is created or its pattern is changed through the admin, the REST API, the MCP `schema_update_collection` tool, or a seed. Seed files with such a pattern fail validation before anything is applied. The admin's collection editor shows the problem next to the URL Pattern field.
  
  If a collection already has a pattern that breaks this rule, it keeps working for generating links in menus, sitemaps and redirects, but `resolveEmDashPath()` no longer matches it, and the site logs a warning naming the collection. REST, MCP and admin updates that send the stored pattern back unchanged still succeed. Give each placeholder its own segment (for example, change `/{slug}-{id}` to `/{id}/{slug}`) to route those entries again.

- [#3445](https://github.com/emdash-cms/emdash/pull/3445) [`b2ce32c`](https://github.com/emdash-cms/emdash/commit/b2ce32c31fb448da4a5b0eb2a817982d7613f3e3) Thanks [@swissky](https://github.com/swissky)! - Fixes admin sign-in silently returning to the login page when no Astro session driver is configured. Signing in with a passkey, magic link, invite link, or signup link now fails with a `SESSION_UNAVAILABLE` error explaining that a session driver is required, and OAuth sign-in returns to the login page with the same explanation, instead of reporting success without keeping the user signed in. Magic links, invite links, and signup links stay usable for a retry. `astro dev` and `astro build` also warn when the driver is missing or sessions are disabled with `session: false`. The Node, Cloudflare, and Netlify adapters configure a driver automatically; on other adapters, such as Vercel, configure `session.driver` in `astro.config.mjs`.
- Updated dependencies [[`f2f9119`](https://github.com/emdash-cms/emdash/commit/f2f9119738ba360d02e3fd00e1cf7d1d49b52fda), [`2e943ff`](https://github.com/emdash-cms/emdash/commit/2e943ff35fcffc5a4e35dd658ef73cf098030e3b), [`38d200d`](https://github.com/emdash-cms/emdash/commit/38d200d7033149f09725efb53c23534bbb35e811), [`38d200d`](https://github.com/emdash-cms/emdash/commit/38d200d7033149f09725efb53c23534bbb35e811), [`895fb69`](https://github.com/emdash-cms/emdash/commit/895fb699223f27a26a1556c9d009e71019cece13)]:
  - @emdash-cms/blocks@0.42.0
  - @emdash-cms/plugin-types@0.5.0
  - @emdash-cms/registry-lexicons@0.7.0
  - @emdash-cms/registry-client@0.7.0

## 0.41.0

### Minor Changes

- [#1928](https://github.com/emdash-cms/emdash/pull/1928) [`a5b4504`](https://github.com/emdash-cms/emdash/commit/a5b450497443ca4b2e236675ab1ba59d15845900) Thanks [@MA2153](https://github.com/MA2153)! - Adds a working reference field, and a screen for the relationships behind it. A reference field is an entry picker: search for, pick and reorder linked entries in the entry editor, saved with the entry in one request. To answer "what points at this entry", bind a field to the other end of the same relationship — it lists the entries pointing here and can edit that list.
  
  Content Types links to a new Relations page listing every relationship on the site — the content types it joins, the fields bound to each end and which end they pick from, and how many links it holds — and each content type repeats the ones it is an end of in a panel under its fields. A new reference field starts from its relationship: pick one, and the label, slug and the rest of the field follow from the side the field views. Deletion dialogs name what goes with a deletion, including the field on the other content type. A reference field created before this release keeps rendering as the text box it has always been, and its dialog offers the collection picker that converts it. The [Relations guide](https://docs.emdashcms.com/guides/relations/) walks through the screens.

### Patch Changes

- [#3479](https://github.com/emdash-cms/emdash/pull/3479) [`35a55a4`](https://github.com/emdash-cms/emdash/commit/35a55a48e5bb5c06f03a2a180f58a6ca3eb6ebad) Thanks [@ascorbic](https://github.com/ascorbic)! - Updates the empty Plugins screen to open the registry when sandboxed plugin installation is available, or link to the plugin installation guide when it is not.

- [#3295](https://github.com/emdash-cms/emdash/pull/3295) [`078f167`](https://github.com/emdash-cms/emdash/commit/078f1673456690fe33c7407d8691fa896b296135) Thanks [@ascorbic](https://github.com/ascorbic)! - Shows the permissions a CLI or agent is requesting on the admin device authorization page (`/_emdash/admin/device`) before you approve its code. The page lists the permissions that approval will grant, and separately lists any requested permissions your role does not allow. The Authorize button stays disabled until the code is confirmed valid and at least one requested permission can be granted.
  
  A new authenticated `GET /_emdash/api/oauth/device/authorize?user_code=XXXX-XXXX` endpoint returns a pending code's `requestedScopes` and the `grantedScopes` an approval by the current user would receive. Unknown, already-used and expired codes return `INVALID_CODE` or `EXPIRED_CODE`.
- Updated dependencies []:
  - @emdash-cms/blocks@0.41.0

## 0.40.1

### Patch Changes

- [#3448](https://github.com/emdash-cms/emdash/pull/3448) [`7b431fe`](https://github.com/emdash-cms/emdash/commit/7b431fe008c2512249b0d27fc93c9b57638edcf8) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes the setup wizard failing with "Failed to apply seed" on Cloudflare Workers when its sample content needs more database queries than one request allows. The wizard now adds sample content over as many requests as it needs and shows the progress. When a request fails, the content added so far is kept, and **Continue** adds the rest.
- Updated dependencies []:
  - @emdash-cms/blocks@0.40.1

## 0.40.0

### Minor Changes

- [#3364](https://github.com/emdash-cms/emdash/pull/3364) [`c99bcd3`](https://github.com/emdash-cms/emdash/commit/c99bcd3e11dd3f20bd0a4c240a8f73378c02de34) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Adds bulk tagging for editors. Select posts from a collection's bulk-actions bar or paste up to 50 public links from the Tags page, review their exact titles and languages, and apply one existing or new tag. Assignments take effect immediately without publishing other draft edits, preserve existing tags, and report unmatched links or failed writes for retry.

- [#3320](https://github.com/emdash-cms/emdash/pull/3320) [`840a9d3`](https://github.com/emdash-cms/emdash/commit/840a9d363470fed2535665117587f353f8bff698) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds first-class `blocks` fields for ordered, typed page compositions. Define retained block-type versions through the schema API, MCP, or seed files; edit block cards in the admin; and render stored compositions with `<Blocks value components fallback>` from `emdash/ui`.
  
  Generated collection types include each retained block version, and `defineBlockComponents<T>()` type-checks that a component map covers every generated `_type`. Image, file, repeater-image, and Portable Text media inside blocks participate in normalization, MIME validation, usage tracking, and cleanup protection.
  
  Deploy renderer support before activating a breaking block-type version. Existing versions remain available for drafts, revisions, and stored content, and migrating a stored block to a new version requires explicit `migrateBlocks: true` intent.
  
  Sites upgrading from a release older than 0.39 must deploy 0.39 first and upgrade every runtime before creating a blocks field. The 0.39 unknown-field protection prevents an older runtime in a rolling deployment or rollback from overwriting block JSON.

- [#3167](https://github.com/emdash-cms/emdash/pull/3167) [`ed51c68`](https://github.com/emdash-cms/emdash/commit/ed51c685bec26ba745624a7c54e9cf96e5e0c927) Thanks [@kwmr](https://github.com/kwmr)! - Adds optional `link` on portable-text image blocks: editor link buttons work on image selection, and `Image.astro` wraps images in a sanitized `<a>` when `link.href` is set. Legacy `link: "https://…"` strings written by WordPress/Gutenberg imports are normalised on read, so already-imported linked images keep their link and are upgraded to the object shape on their next edit.

- [#1944](https://github.com/emdash-cms/emdash/pull/1944) [`bf6b0a9`](https://github.com/emdash-cms/emdash/commit/bf6b0a9623076a5fbe2368602bca42317f96ad03) Thanks [@swissky](https://github.com/swissky)! - Localizes invite, magic-link, and account-recovery emails: they now follow the site locale (falling back to the requesting user's admin language) instead of always being sent in English. Email HTML sets `lang` and `dir` on the root element, so right-to-left languages render correctly. A non-canonical site locale (`pt-br`) is normalized to its catalog (`pt-BR`); an unsupported value falls back to the requesting user's admin language.
  
  `@emdash-cms/auth`'s invite and magic-link builders (`buildInviteEmail`, `buildMagicLinkEmail`, now exported) accept optional injected copy and locale via new `emailStrings`/`emailLocale` config options (`InviteEmailStrings`/`MagicLinkEmailStrings`). `@emdash-cms/admin/locales` exports the copy resolvers `getInviteEmailStrings`/`getMagicLinkEmailStrings` and the BCP 47 matcher `matchLocale`.

- [#3346](https://github.com/emdash-cms/emdash/pull/3346) [`1796cd5`](https://github.com/emdash-cms/emdash/commit/1796cd508c2bd6456abe77b458f7d177093df754) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds **Settings → Transfer** for moving a site between EmDash installations.
  
  - **Export**: admins export the site as a `.emdash` package, optionally without comments, and download it. The browser fetches and checks the export file by file, so large sites download on Cloudflare Workers too; small sites can also be downloaded as one archive.
  - **Import**: on a site with no content of its own, admins choose a package file. The browser checks and uploads it in parts, then shows what will be imported and what the import changes, which user on this site should own each author's content (matched by email where possible), whether to keep this site's title and tagline, which starter content will be removed, and any warnings or blockers. After confirmation the import runs and ends with a verified receipt that can be copied. Leaving the page does not lose an unfinished import; an interrupted upload needs the same file chosen again. On a site that already has content, the page lists what prevents an import.
  - **Approvals**: the page lists requests from MCP clients to start an export or import, so an admin can approve or deny them.
  
  The setup wizard now asks how to start the site: with the template's sample content, as an empty site, or by importing an existing EmDash site, which replaces the "Include sample content" checkbox. Choosing import skips the sample content and opens Transfer at the import step once your account is created. While a site has no content, the dashboard shows a dismissible suggestion that links to the import, and Backups settings link to Transfer.
  
  When creating an API token, admins can select the `transfer:export`, `transfer:analyze`, and `transfer:execute` scopes to give a token, such as an agent's, narrower access than Admin, which includes them. The OAuth consent screen lists them when a client requests them.

### Patch Changes

- [#3241](https://github.com/emdash-cms/emdash/pull/3241) [`b8fae35`](https://github.com/emdash-cms/emdash/commit/b8fae350afd7dfcc6dcb668b48cd90791e49bd61) Thanks [@swissky](https://github.com/swissky)! - Fixes the General and SEO settings screens so removing the site logo, favicon, or default social image remains cleared after saving. REST, MCP, and `setSiteSettings()` callers can remove these media references by setting them to `null`; omitted settings remain unchanged.

- [#3296](https://github.com/emdash-cms/emdash/pull/3296) [`1f193b2`](https://github.com/emdash-cms/emdash/commit/1f193b21dead327f29a448b6fbd2aadcd67f4cc4) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Updates the Comments moderation page with a compact header that groups status views with search and collection filters. Status tabs use Phosphor icons with a filled active state, and empty views use a responsive standalone state instead of retaining the table shell.

- [#3348](https://github.com/emdash-cms/emdash/pull/3348) [`6f1b046`](https://github.com/emdash-cms/emdash/commit/6f1b046eca49184c8cc3e004375abcb43acb06ec) Thanks [@swissky](https://github.com/swissky)! - Fixes gallery blocks seeded with `$media` showing empty images and losing their media on first edit. The `Gallery` component now renders these images, including galleries seeded with earlier versions, and the content editor previews them and keeps their media references, alt text, and dimensions when it saves. Seeding a gallery now stores each `$media` image as a regular gallery media reference. Galleries whose references an earlier autosave already stripped are not restored.

- [#3398](https://github.com/emdash-cms/emdash/pull/3398) [`7df822b`](https://github.com/emdash-cms/emdash/commit/7df822ba7cefbe1497518c462b05e57a18df5149) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes Portable Text image blocks seeded with `$media`, including those seeded with earlier versions, rendering with an empty `src` and losing their media reference when first edited in the admin or through visual editing. Seeding now stores the image as a regular media reference with its alt text and dimensions on the block, the same shape the editor saves. Blocks whose media reference an earlier edit already removed need their image selected again.

- [#3350](https://github.com/emdash-cms/emdash/pull/3350) [`21ee693`](https://github.com/emdash-cms/emdash/commit/21ee6930fd0f86f449005bae2ab6ee089705cf02) Thanks [@swissky](https://github.com/swissky)! - Fixes saving from visual editing changing custom blocks identified by `url`, such as embeds imported from WordPress, to use `id`, which dropped their `url`. Blocks now keep the identity field they were stored with: blocks with both `id` and `url` keep both, and blocks with neither no longer gain an empty `id`. Custom blocks inserted in the content editor no longer gain an empty `id` when no ID is entered.

- [#3411](https://github.com/emdash-cms/emdash/pull/3411) [`28dec10`](https://github.com/emdash-cms/emdash/commit/28dec1059b6033ddf6596916bda7a888c5d233cb) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes the admin silently replacing a stored value that is not a list on the first edit to a repeater, rich text, multi-select, or blocks field, or to a repeater in a plugin block. Such values come from imports, direct database writes, or a plugin that changed a block field from a text input to a repeater. The field now shows the stored value read-only with a warning and keeps it unchanged until the editor chooses to replace it with an empty list.

- [#3284](https://github.com/emdash-cms/emdash/pull/3284) [`1217386`](https://github.com/emdash-cms/emdash/commit/121738651904b250a55b7e8c96fec46002487385) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes the editor's light-mode menu highlights so slash commands, heading choices, and block transforms use a quieter neutral tint instead of the heavy interaction gray. Dark mode remains unchanged.

- [#3338](https://github.com/emdash-cms/emdash/pull/3338) [`ecef5a9`](https://github.com/emdash-cms/emdash/commit/ecef5a9afcc6d75fe92bf014c20e4d1bf6d75084) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes cached published pages remaining stale when tag or category assignments change. Assignments still save immediately, and the editor clarifies that term changes do not wait for **Publish changes**.

- [#3337](https://github.com/emdash-cms/emdash/pull/3337) [`ad1465d`](https://github.com/emdash-cms/emdash/commit/ad1465d9d4a0e90972b846a4eeb04fb605e1fd1f) Thanks [@swissky](https://github.com/swissky)! - Fixes magic link and account recovery emails failing for recipients whose mail is scanned (for example by Microsoft 365 Safe Links). Opening the link now shows a confirmation page in the admin, and the one-time link is only used when the recipient presses Continue, so a scanner that fetches the link no longer uses it up or receives the session. Links in emails sent before the upgrade keep working.
  
  `GET /_emdash/api/auth/magic-link/verify` no longer signs in; it redirects to the confirmation page. Scripts that signed in by requesting that URL must now send `POST /_emdash/api/auth/magic-link/verify` with a JSON body `{ "token": "..." }` and the `X-EmDash-Request: 1` header, then keep the returned session cookie.

- [#3413](https://github.com/emdash-cms/emdash/pull/3413) [`e9b70ec`](https://github.com/emdash-cms/emdash/commit/e9b70ec4ead0ca15dc0bcf981e0ca058cd57a5af) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes the Media Library **Used in** tab reporting no usage for a file selected as the site logo, favicon, or default social image. Those settings appear as a **Site Settings** result, `GET /_emdash/api/media/{id}/usage` lists them in a new `siteSettings` array, and `usage.count` includes them. An empty **Used in** tab now says "No tracked references found" and names what is not checked, such as custom rich text blocks, instead of stating that the file is not used in any content.

- [#3386](https://github.com/emdash-cms/emdash/pull/3386) [`931b40d`](https://github.com/emdash-cms/emdash/commit/931b40d1e33d7edf8792ff13d1d970e4c14dd515) Thanks [@swissky](https://github.com/swissky)! - Fixes passkey sign-in options revealing whether an email address has an account. `POST /_emdash/api/auth/passkey/options` now ignores the optional `email` field and returns the same options for every request, so the browser offers any passkey saved for the site. The default admin login is unaffected. Clients that posted `email` to this endpoint to sign in with passkeys not stored on the authenticator (non-discoverable credentials, such as some older security keys) can no longer sign in with those keys. Register a passkey on an authenticator that supports discoverable credentials (most platform authenticators and current security keys), or sign in with a magic link or a configured OAuth provider. The `@emdash-cms/admin` `PasskeyLogin` component's `showEmailInput` prop is deprecated and no longer shows an email field; existing callers still type-check and can drop the prop. The previous email-scoped behavior cannot be restored.

- [#3323](https://github.com/emdash-cms/emdash/pull/3323) [`a30b110`](https://github.com/emdash-cms/emdash/commit/a30b1109fec5ab4ca716da2655741635e7ab30a1) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fixes the default LocaleSwitcher size so its select control matches the height, corner radius, font size, and horizontal padding of adjacent Kumo Buttons. Replaces the native select chevron with an inset indicator so the right gutter is visible.

- [#3291](https://github.com/emdash-cms/emdash/pull/3291) [`7a4e1fd`](https://github.com/emdash-cms/emdash/commit/7a4e1fd39132fa496fcd31fde5d57a11af73a336) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Updates the Redirects page with a compact, accessible header that groups its title and primary action, then keeps segmented views beside their search and filter controls. The views use Phosphor icons with a filled active state. On narrow screens, the action stays beside the title, the tabs span the available width, and the two filters share one row. The layout also mirrors for right-to-left locales.

- [#3399](https://github.com/emdash-cms/emdash/pull/3399) [`e4b0d81`](https://github.com/emdash-cms/emdash/commit/e4b0d81497a21684f541eaeb32a49dcbb19fce2e) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes the admin plugin registry showing "Handle unavailable" for every publisher and scrolling sideways, so verified publisher handles now appear and unresolved publisher identifiers stay inside their cards.
  
  A publisher whose handle no longer resolves back to its account now shows **INVALID HANDLE**, and installing its plugins from the registry detail page is disabled until the publisher fixes the handle. Plugins that are already installed keep running.

- [#3379](https://github.com/emdash-cms/emdash/pull/3379) [`a733b90`](https://github.com/emdash-cms/emdash/commit/a733b90ef68c9001bfa75cb086c96f4951f97370) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Updates the Tags page with a searchable list, matching Add tag and Add to posts actions, and less crowded row controls. Taxonomy creation remains available from the More menu. Term forms show slug guidance on demand; term and taxonomy creation dialogs share a bordered header, scrollable body, and fixed action footer.
- Updated dependencies []:
  - @emdash-cms/blocks@0.40.0

## 0.39.1

### Patch Changes

- [#3286](https://github.com/emdash-cms/emdash/pull/3286) [`4ffc631`](https://github.com/emdash-cms/emdash/commit/4ffc631c71a4df1f0f8c4d8c22335dfad4bbccf6) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Refines content editor typography so headings, field labels, input values, and supporting text use a clearer, consistent hierarchy across the editing and settings panels.
- Updated dependencies []:
  - @emdash-cms/blocks@0.39.1

## 0.39.0

### Minor Changes

- [#3188](https://github.com/emdash-cms/emdash/pull/3188) [`4fef109`](https://github.com/emdash-cms/emdash/commit/4fef1090732a181f718c2398fbf04c05d40cf5f5) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds saved-entry panels and actions for sandboxed plugins. Declare collection-filtered `admin.editorPanels` and `admin.editorActions` entries that point to private plugin routes.
  
  Panels load Block Kit only when an editor opens them. Actions support confirmation and can return a toast, request an entry refresh, or navigate through a structured link target. EmDash reloads and ownership-authorizes the saved entry before invocation, then exposes only its canonical identity, locale, and version through `routeCtx.ui`; unsaved editor values never cross the sandbox boundary.
  
  `createPluginRuntimeTestHost()` includes panel and action helpers that exercise the production authorization, response-validation, and Worker Loader path.

- [#3171](https://github.com/emdash-cms/emdash/pull/3171) [`80ccfaf`](https://github.com/emdash-cms/emdash/commit/80ccfaf198307e7f1760f3406db60f41851a40f2) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds capability-gated schema, translation, public URL, and content revision discovery for plugins.
  
  Declare `schema:read` to list collection and field definitions through `ctx.schema`. Existing `content:read` access can inspect safe content identity, discover locale siblings with `getTranslations()`, and resolve published routes with `getPublicUrl()`. Public URL resolution follows the site's collection pattern, locale routing, and trailing-slash policy and returns `null` for content without a public route.
  
  Revision snapshots require the separate `content:revisions:read` capability because retained history can contain field values that an administrator removed later. This capability implies ordinary `content:read` access. Installation and plugin updates show both new authorities for consent, and the native, Cloudflare Worker Loader, and Node.js workerd runtimes expose the same methods.

- [#3184](https://github.com/emdash-cms/emdash/pull/3184) [`46784e1`](https://github.com/emdash-cms/emdash/commit/46784e10d9bef7f4e3dd3e41c0d78232691d0870) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds capability-gated redirect access for sandboxed plugins. Declare `redirects:read` to list redirect rules with cursor pagination and read a rule with an opaque `_rev`. Declare `redirects:write` to create, update, and delete redirect rules; write access implies read access and installation consent states that the plugin can change where visitors are sent.
  
  Redirect mutations use EmDash's redirect validation and cache invalidation path. Writes are serialized across runtimes so duplicate-source and loop validation use a consistent rule graph. The expanded redirect schema remains compatible with writes from previous host processes during rolling deployments. Loop validation runs when a rule is created or its source or destination changes; enabled-only updates retain the host API's existing behavior. Updates and deletes require the latest `_rev`, reject concurrent changes with `CONFLICT`, and do not let plugins set the host-owned automatic redirect marker. The Cloudflare Worker Loader and Node.js workerd runners expose the same API, and `createPluginRuntimeTestHost()` includes redirect fixtures and inspection for production-boundary tests.

- [#3145](https://github.com/emdash-cms/emdash/pull/3145) [`f6bf82f`](https://github.com/emdash-cms/emdash/commit/f6bf82fe23a783ac9932f4a913b6873349222899) Thanks [@ascorbic](https://github.com/ascorbic)! - Updates plugin discovery to show only the registry. Sites with an enabled `sandboxRunner` use the hosted aggregator at `https://registry.emdashcms.com` by default. The new top-level `registry` option accepts a registry URL or configuration object, while `registry: false` disables registry discovery and registry-installed plugins without disabling the sandbox runner.
  
  The former `experimental.registry` location is deprecated but remains supported when the top-level option is omitted. A top-level value takes precedence.
  
  The `marketplace` integration option is deprecated but remains supported for plugins already installed from Marketplace. Those plugins continue to run and can still be updated or uninstalled from **Plugins**. Marketplace browse and install pages are hidden, and configured sites display a migration guide banner.
  
  #### What should I do?
  
  Move an existing `experimental.registry` value to the top-level `registry` option. The deprecated location continues to work during the pre-1.0 compatibility period.
  
  Set `registry: false` if the site needs its sandbox runner but should not load registry-installed plugins or expose registry discovery.
  
  Keep `marketplace` configured while any installed Marketplace plugin still needs updates. Replace or uninstall those plugins, then remove the option by following the [Marketplace migration guide](https://docs.emdashcms.com/plugins/migrate-from-marketplace/).

- [#3170](https://github.com/emdash-cms/emdash/pull/3170) [`3538bb8`](https://github.com/emdash-cms/emdash/commit/3538bb86c7801edf8634af2656cbe3dd194bca50) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `comments:read` and `comments:moderate` for sandboxed plugins. `ctx.comments` can get, count, and cursor-page through non-trashed comments, and can change a comment between `approved`, `pending`, and `spam` when the caller supplies the status it previously observed.
  
  `comments:read` exposes comment bodies, author names and email addresses, pseudonymous IP hashes, user agents, and moderation metadata. It does not expose the linked EmDash user-account ID. `comments:moderate` implies that read access, and installation or an update that requests either capability requires operator consent.
  
  Status changes use the core moderation path. A stale expected status rejects with `COMMENT_STATUS_CONFLICT`, and an overlapping transition can reject with `COMMENT_MODERATION_IN_PROGRESS`; a successful transition runs `comment:afterModerate` once with the calling plugin's origin and preserves approval notifications. Hard deletion and bulk status replacement are not included.

- [#3251](https://github.com/emdash-cms/emdash/pull/3251) [`dbd77ef`](https://github.com/emdash-cms/emdash/commit/dbd77ef387cf1b0ea22018e442d88450578c8f0c) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds explicit, consented access to selected unsaved content for sandboxed editor panels and actions.
  
  Plugins can request `admin.editor-draft:read` to receive extension-selected field values after an editor invokes them, and `admin.editor-draft:patch` to propose atomic whole-field `set` or `clear` operations. Patch access does not imply read access. Each extension must declare explicit collection scope and narrow its access to field slugs, translatable fields, or both.
  
  EmDash authenticates and authorizes the saved entry, reloads its schema and revision, validates snapshot and patch limits, and rejects stale or invalid responses. The admin shows a host-rendered before-and-after preview, applies accepted changes to the visible form, marks it dirty, and leaves saving to the editor. Panel load and ordinary typing do not expose draft data or invoke the plugin.
  
  `createPluginRuntimeTestHost()` now provides draft capture and host-validated patch application helpers for production-boundary plugin tests.

- [#3172](https://github.com/emdash-cms/emdash/pull/3172) [`2818e66`](https://github.com/emdash-cms/emdash/commit/2818e669e1f51f4a3314165eb9b4360b707a67ba) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds separate sandboxed-plugin capabilities for reading media bytes and editing media metadata.
  
  Declare `media:bytes:read` to use `ctx.media.readBytes()`. Reads are available only for ready media, default to a 10 MiB limit, enforce the caller's limit while consuming the storage stream, and cannot request more than 16 MiB. The result includes the content hash; ordinary `media:read` metadata excludes content hashes, storage keys, and author identity.
  
  Ready-media metadata URLs use an authenticated media ID route. Authenticated callers with the `media:read` permission can fetch the asset without receiving its storage key; logged-out requests are rejected before the route queries media.
  
  Declare `media:metadata:write` to use `ctx.media.updateMetadata()` for alt text, captions, and focal points. This capability cannot upload, replace, move, or delete media. It does not imply `media:read` or `media:bytes:read`.
  
  `@emdash-cms/plugin-test` also provides binary media fixtures and inspection through the runtime-backed host so plugin tests can exercise the production Worker Loader bridge.

- [#2880](https://github.com/emdash-cms/emdash/pull/2880) [`ad1dee2`](https://github.com/emdash-cms/emdash/commit/ad1dee288aedda3242a2f456708b53cd2e0b23cd) Thanks [@danielmlr](https://github.com/danielmlr)! - Adds the field constraints declared in a collection schema to the content editor, so authors see a limit before a save can fail on it.
  
  Text fields with `maxLength` show a live character count below the input and stop accepting input at the limit; a `minLength` is shown as a hint. Number fields with `min` or `max` show the allowed range and set it on the input. Content that is outside its bounds, such as text saved before a limit was lowered, is marked in the editor before a save is attempted.
  
  The admin manifest now carries a field's `validation` object for every field type. Previously only repeater, file and image fields exposed it, so length and range rules never reached the editor. Plugin field widgets for trusted plugins receive the same `validation` object as a prop, so a custom widget can enforce the limits without hardcoding them.

- [#3235](https://github.com/emdash-cms/emdash/pull/3235) [`808f473`](https://github.com/emdash-cms/emdash/commit/808f473a76141dc048bd527f07749564b445bd12) Thanks [@swissky](https://github.com/swissky)! - The rich text editor's link input now searches existing content by title as you type, so authors can link to pages and posts without copying URLs. Results include drafts (marked as such) when the signed-in user may read them, and picking a result inserts the entry's public URL. Entries whose URL pattern needs a publish date can't be picked until they are published. Typing or pasting a URL works as before.

- [#3194](https://github.com/emdash-cms/emdash/pull/3194) [`1e13daa`](https://github.com/emdash-cms/emdash/commit/1e13daa3d0987a57da0a84f87cebda3a0a6461a4) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds separately consented publication and restore actions to native and sandboxed plugin contexts.
  
  Plugins with `content:publish` can read an entry with an opaque revision and publish, unpublish, schedule, or unschedule it through the same runtime behavior as REST and MCP. Each mutation requires the revision returned by the read or preceding action, and a plugin cannot recursively run the same action for the same entry. The capability implies `content:read` but not `content:write`.
  
  Plugins with `content:restore` can read and restore trashed entries without receiving ordinary content-read or write authority. Restore is revision-fenced and returns the next revision. Existing plugin installations receive neither capability unless a new version declares it and the administrator approves the expanded access.

- [#3185](https://github.com/emdash-cms/emdash/pull/3185) [`c029134`](https://github.com/emdash-cms/emdash/commit/c029134b8c9e3fb4d19791c1f5d9450089d12f74) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `hooks.content-policy:register` for sandboxed and native plugins that need to inspect and reject publication, scheduling, or unpublication without receiving content read, write, or publication-action access.
  
  Policy plugins can register `content:beforePublish`, `content:beforeSchedule`, and `content:beforeUnpublish`. Each event identifies the API, MCP, visual editor, plugin, scheduler, or system origin and includes the authenticated actor when one exists. Return `{ cancel: true, reason }` to reject the action with a stable error code. EmDash validates the reason as 1–500 plain-text characters. For allowed actions, the revision read before policy evaluation becomes the mutation precondition.
  
  Scheduled content runs `content:beforePublish` again when it becomes due. A policy rejection unschedules the entry, lists its public-safe reason and entry link on the dashboard, and avoids retrying the same permanent rejection on every scheduler tick. Successful rescheduling, publication, or deletion clears the record; administrators can dismiss stale records. `@emdash-cms/plugin-test` exposes stored scheduler rejections through `inspect.scheduledPolicyRejections()`.

- [#3190](https://github.com/emdash-cms/emdash/pull/3190) [`6daffea`](https://github.com/emdash-cms/emdash/commit/6daffea679d3104fd94781f0cd706756c4da6289) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds declared request and raw response contracts for sandboxed plugin routes across the native,
  Cloudflare Worker Loader, and Node/workerd runtimes.
  
  Use `methods` to have the host reject other HTTP methods with `405 Method Not Allowed`. Use
  `request.body` with `json`, `text`, `bytes`, `form-data`, or `none` for bounded buffered parsing, and
  list the safe request headers the handler needs. Undeclared routes retain their existing
  method-agnostic JSON and query-string behavior.
  
  Routes with `response: "raw"` return `pluginResponse()` with an unwrapped text or byte body, status,
  and allowlisted representation, download, or redirect headers. Raw responses are limited to 8 MiB.
  The host removes all other plugin-supplied headers, applies the route's cache and browser security
  policy, and rejects active same-origin content types.
  
  `pluginRoute()` infers a sandboxed handler's input from its declared body mode.
  `definePluginRoute()` provides the equivalent inference for trusted native routes.
  `createPluginRuntimeTestHost()` accepts `rawBody` for testing the production request parser with
  text, bytes, URL-encoded data, and multipart form data.

- [#3174](https://github.com/emdash-cms/emdash/pull/3174) [`06bad83`](https://github.com/emdash-cms/emdash/commit/06bad83f5f466a32ab52f0c59fab7c2f9a8a76ea) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds structured Block Kit navigation and host-attested administrator locale context for sandboxed plugin pages and dashboard widgets.
  
  Plugins can return `link` elements that target saved content, another page declared by the same plugin, generated plugin settings, or an external HTTP, HTTPS, or `mailto:` URL. EmDash constructs internal admin URLs and opens external links with `noopener noreferrer`. Links never dispatch block actions and cannot appear as form fields.
  
  Block Kit route handlers receive `routeCtx.ui` with the validated surface, administrator locale, and text direction. The host validates every sandboxed page and widget response before rendering it, rejects undeclared plugin-page targets and active URL protocols, and permits external images only over HTTPS to hosts declared in `allowedHosts` under `network:request` consent or under `network:request:unrestricted` consent. Responses are limited to 256 KiB, 20 levels, 2,000 nodes, 1,000 items per array, and 64 KiB per string.
  
  `createPluginRuntimeTestHost()` adds `admin.loadPage()`, `loadWidget()`, `act()`, and `submit()` helpers that exercise the private production route, Worker Loader isolate, host UI context, and response validation.
  
  This is a breaking security tightening for sandboxed plugins that return an external Block Kit image without matching network authority. EmDash rejects the complete page or widget response instead of allowing the administrator's browser to contact an unapproved host.
  
  #### What should I do?
  
  If a plugin returns external Block Kit images, add `network:request` and every image hostname to `allowedHosts`, or add `network:request:unrestricted` when the plugin genuinely requires any hostname. Publish a plugin update so administrators can review and approve the expanded authority. Root-relative images need no manifest change.

- [#3169](https://github.com/emdash-cms/emdash/pull/3169) [`8ad06e9`](https://github.com/emdash-cms/emdash/commit/8ad06e9c3317f97a6c8c553b310325c229c0986d) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds the `taxonomies:write` sandboxed-plugin capability for creating taxonomy terms and adding or removing term assignments through `ctx.taxonomies`.
  
  Assignment methods accept term row IDs or translation-group IDs and apply idempotent deltas, so they do not replace existing assignments and concurrent additions are preserved. EmDash validates collection attachment, entry existence, term ownership, configured locales, translation identity, and hierarchy before changing taxonomy state. Sandboxed `createTerm()` rejects `parentId` for a non-hierarchical taxonomy instead of ignoring it. The capability implies `taxonomies:read` and requires renewed consent when an installed plugin first declares it.
  
  Existing REST and MCP term mutations also reject creating or updating a term with a parent in a non-hierarchical taxonomy. Callers that assign parents must mark the taxonomy as hierarchical before creating or reparenting terms.
  
  This release includes migration `082_taxonomy_translation_locale_unique`, which enforces one term per translation group and locale. If an existing database contains duplicate rows, the migration preserves them as independent term groups and copies their assignments before adding the unique index. It can restart safely after any completed statement.
  
  `@emdash-cms/plugin-test` adds taxonomy fixtures and an assignment inspector for production-boundary tests. Taxonomy definition management, assignment replacement, term updates, and term deletion remain unavailable to sandboxed plugins.

### Patch Changes

- [#3289](https://github.com/emdash-cms/emdash/pull/3289) [`bdbe41c`](https://github.com/emdash-cms/emdash/commit/bdbe41c4af96bbfd0d5d81d3e9e6ea1bec0edb61) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes unreadable warning and info text in the light admin theme, including the marketplace migration banner on the dashboard. Info, success, warning, and danger colours now use the Kumo design system defaults.

- [#3146](https://github.com/emdash-cms/emdash/pull/3146) [`4ebd2a8`](https://github.com/emdash-cms/emdash/commit/4ebd2a8da46ae144714cef7b776aa6d790f92815) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes datetime sorting and range queries by storing every content datetime as a UTC ISO string with fixed milliseconds. The admin converts date-and-time fields through the site's configured timezone, while API, MCP, and CLI writes now require `Z` or an explicit UTC offset.
  
  The core migration reports noncanonical values before changing them, then normalizes content columns and revision snapshots in bounded batches. Legacy values without an offset use the site timezone. If a value falls in a repeated or skipped daylight-saving hour, the migration stops before writing and reports the content row or revision that needs an explicit offset.

- [#3228](https://github.com/emdash-cms/emdash/pull/3228) [`9bffbfa`](https://github.com/emdash-cms/emdash/commit/9bffbfa89797524ff8fbb93919707cb752334a32) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes content writes when a database schema contains a field type that the running EmDash version does not support. Entries remain readable, but the admin makes them read-only and content create or update requests return `UNSUPPORTED_FIELD_TYPE` instead of treating the unknown field as text and risking data loss.
  
  Deploy this release to every runtime before enabling a later EmDash feature that adds a new field type. Sites whose schemas use only supported field types require no action.

- [#3200](https://github.com/emdash-cms/emdash/pull/3200) [`4ebcb07`](https://github.com/emdash-cms/emdash/commit/4ebcb0767653731d9e93e1a2d2dd2942ab3a69b2) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Separates scheduling from immediate publishing in the content editor. Schedule controls now sit below the publishing summary, scheduled entries show change and remove actions side by side, and publishing requires confirmation. Slug and content language settings move into a dedicated **URL & language** section.

- [#3229](https://github.com/emdash-cms/emdash/pull/3229) [`89bd85b`](https://github.com/emdash-cms/emdash/commit/89bd85b02a92094ccce897b416ae0479a035850c) Thanks [@danielmlr](https://github.com/danielmlr)! - Completes the German admin translations so German-speaking editors see localized text in the plugin consent dialog's capability list and public-route warning, the marketplace deprecation and plugin registry configuration banners, plugin editor panels and actions, the field length and range hints in the content editor, the scheduled-publication policy notices on the dashboard, the notices for field types this EmDash version does not support, and the visual editing toolbar.

- [#3247](https://github.com/emdash-cms/emdash/pull/3247) [`3ad2b50`](https://github.com/emdash-cms/emdash/commit/3ad2b5079c09bf7f226bc9457c1a43e3feb3450d) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes the taxonomy screen offering no way to remove a taxonomy. **Delete taxonomy**, in the screen's actions menu, deletes the taxonomy together with its terms in every language and removes those terms from the content filed under them; the content entries themselves are kept. Removing a taxonomy previously meant a direct `DELETE /_emdash/api/taxonomies/{name}` call or the `taxonomy_delete` MCP tool, so a taxonomy created by mistake stayed in the admin sidebar.
  
  The action requires the `taxonomies:manage` permission that the route already enforced, so editors and administrators can perform it.

- [#3243](https://github.com/emdash-cms/emdash/pull/3243) [`dc685eb`](https://github.com/emdash-cms/emdash/commit/dc685eb7ea0cb270060bbb25d30ad079d72e5328) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes the code block language selector so typing keeps a scrollable suggestion list open and selecting a language applies its highlighting immediately.

- [#3248](https://github.com/emdash-cms/emdash/pull/3248) [`3cec6f9`](https://github.com/emdash-cms/emdash/commit/3cec6f94bba0293f84488c3dab9d2584e27812f2) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes registry plugins appearing in discovery but failing installation when their signed profiles predated repository metadata.
  
  Profiles without the optional repository extension permit releases without provenance. Manual publishing adds an available canonical HTTPS repository with optional provenance, preserves explicit profile policies on later releases, and refuses manual releases when the publisher requires provenance. EmDash routes installation verification correctly and shows site administrators actionable publisher guidance when signed records fail verification.

- [#3267](https://github.com/emdash-cms/emdash/pull/3267) [`2375b4a`](https://github.com/emdash-cms/emdash/commit/2375b4a7329a201e7c30f73638bae0a7d8d51be7) Thanks [@sitechfromgeorgia](https://github.com/sitechfromgeorgia)! - Adds Georgian (ქართული) to the admin UI with a complete translation catalog: labels, descriptions, dialogs, and form fields. The locale is selectable from the language picker.

- [#3094](https://github.com/emdash-cms/emdash/pull/3094) [`6c23ff3`](https://github.com/emdash-cms/emdash/commit/6c23ff3f8b8550276c2c8e1ed07aa796c3c9c9c5) Thanks [@dchaudhari7177](https://github.com/dchaudhari7177)! - Fixes the admin editor showing "Image not found" for local media whose storage key contains a folder, such as `2026/08/photo.jpg`. Image fields, featured images, galleries and the asset editor now request `/_emdash/api/media/file/2026/08/photo.jpg` instead of `2026%2F08%2Fphoto.jpg`, which the file route answered with 404. Query and fragment characters in a key are still encoded.

- [#3118](https://github.com/emdash-cms/emdash/pull/3118) [`667f62e`](https://github.com/emdash-cms/emdash/commit/667f62e96fc6de6b2128c47685372bf3ea9c7531) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes the content editor saving the writer's copy over a newer version of an entry while the notice that the entry changed somewhere else is shown. Publishing, scheduling, removing a schedule, unpublishing, and changing the publication date each saved that copy first, and publishing then made it live.
  
  During the conflict, the publishing controls are disabled, a publication date change is refused in its dialog, and a save that was already waiting when the conflict arrived is not sent. Changing the author or the SEO fields still writes, and still replaces what it sends on the newer version, but it no longer clears the notice, and what the writer typed stays in the form instead of being replaced by the newer version. **Save anyway** still saves the writer's copy.

- [#3285](https://github.com/emdash-cms/emdash/pull/3285) [`71572ba`](https://github.com/emdash-cms/emdash/commit/71572bafdace8051d685e1f4e96c2463eb6eeccb) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes registry and marketplace installation failing after the plugin bundle and state were written because the request runtime did not expose plugin lifecycle hooks. Failed plugin updates now restore the previous state, remove the failed bundle, and reactivate the previous version after resynchronizing the runtime. Registry update and uninstall requests are also registered in generated Astro sites instead of returning `404 Not Found`.
  
  Registry consent now uses a neutral summary when a release has no build provenance, keeps record identifiers and publisher-policy mechanics under collapsed technical details, and shows the requested permission count with a scroll cue for longer lists.

- [#3245](https://github.com/emdash-cms/emdash/pull/3245) [`563aa73`](https://github.com/emdash-cms/emdash/commit/563aa73ef5d80aca49e34fc4c5db0be2935f64c4) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fixes the Repeater field editor dialog so the configuration form scrolls when many sub-fields are added, keeping the Save/Confirm actions reachable.

- [#3252](https://github.com/emdash-cms/emdash/pull/3252) [`fc32ebf`](https://github.com/emdash-cms/emdash/commit/fc32ebff4b43495e3908cd48eb2a7acc00a6b51d) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes native plugin pages declared at `/` disappearing from the admin sidebar and command palette.

- [#3125](https://github.com/emdash-cms/emdash/pull/3125) [`c783951`](https://github.com/emdash-cms/emdash/commit/c7839517c10562f6d422c838f3903c8c6085e737) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fixes the content editor's distraction-free mode shortcut so `⌘⇧\` (or `Ctrl+Shift+\`) toggles the mode both in and out, keeps the exit button visible without hovering, and no longer treats `Escape` as an exit trigger.

- [#3233](https://github.com/emdash-cms/emdash/pull/3233) [`801a7ca`](https://github.com/emdash-cms/emdash/commit/801a7ca16cbfb08db6712515783b5f5ea65158bd) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Updates the content editor with a compact, searchable picker for categories and tags that supports keyboard controls, term creation, and comma- or newline-separated tag entry.

- [#3205](https://github.com/emdash-cms/emdash/pull/3205) [`93df4e8`](https://github.com/emdash-cms/emdash/commit/93df4e892ba2b737d53ef716755798185db8a142) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes the content editor reporting a failed save with the field's slug and the validator's wording, such as `excerpt: Too big: expected string to have <=160 characters`. When a save, autosave, new entry or new translation fails field validation, the error toast now names each field by the label the editor shows and says what the field needs, for example "Summary can have at most 160 characters."

- [#3109](https://github.com/emdash-cms/emdash/pull/3109) [`ce1659c`](https://github.com/emdash-cms/emdash/commit/ce1659c9e66fff78c3f36956011a913779d5f8af) Thanks [@dandaka](https://github.com/dandaka)! - Fixes images stretching in the rich-text editor when their custom display size has a different aspect ratio from the original image. Images crop to the display size, matching published images from the local media library.
- Updated dependencies [[`71901fc`](https://github.com/emdash-cms/emdash/commit/71901fc92b5a09bd5c1321759b2db1aaa9b0e730), [`4fef109`](https://github.com/emdash-cms/emdash/commit/4fef1090732a181f718c2398fbf04c05d40cf5f5), [`80ccfaf`](https://github.com/emdash-cms/emdash/commit/80ccfaf198307e7f1760f3406db60f41851a40f2), [`46784e1`](https://github.com/emdash-cms/emdash/commit/46784e10d9bef7f4e3dd3e41c0d78232691d0870), [`3538bb8`](https://github.com/emdash-cms/emdash/commit/3538bb86c7801edf8634af2656cbe3dd194bca50), [`dbd77ef`](https://github.com/emdash-cms/emdash/commit/dbd77ef387cf1b0ea22018e442d88450578c8f0c), [`2818e66`](https://github.com/emdash-cms/emdash/commit/2818e669e1f51f4a3314165eb9b4360b707a67ba), [`1e13daa`](https://github.com/emdash-cms/emdash/commit/1e13daa3d0987a57da0a84f87cebda3a0a6461a4), [`c029134`](https://github.com/emdash-cms/emdash/commit/c029134b8c9e3fb4d19791c1f5d9450089d12f74), [`a823276`](https://github.com/emdash-cms/emdash/commit/a823276384cdd3fbf60f01fac5ffb22de6e73dba), [`6daffea`](https://github.com/emdash-cms/emdash/commit/6daffea679d3104fd94781f0cd706756c4da6289), [`fc32ebf`](https://github.com/emdash-cms/emdash/commit/fc32ebff4b43495e3908cd48eb2a7acc00a6b51d), [`06bad83`](https://github.com/emdash-cms/emdash/commit/06bad83f5f466a32ab52f0c59fab7c2f9a8a76ea), [`8ad06e9`](https://github.com/emdash-cms/emdash/commit/8ad06e9c3317f97a6c8c553b310325c229c0986d)]:
  - @emdash-cms/registry-lexicons@0.6.0
  - @emdash-cms/blocks@0.39.0
  - @emdash-cms/plugin-types@0.4.0
  - @emdash-cms/registry-client@0.6.1
