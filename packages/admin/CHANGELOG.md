# @emdash-cms/admin

## 0.21.0

### Minor Changes

- [#1508](https://github.com/emdash-cms/emdash/pull/1508) [`e9cd7b7`](https://github.com/emdash-cms/emdash/commit/e9cd7b7821c5a081257cb56bb857b7950e2b1527) Thanks [@swissky](https://github.com/swissky)! - Add a "Gone (410)" rule type. Redirect rules now support `410` (Content Deleted) and `451` (Unavailable For Legal Reasons) as terminal statuses — served directly with no destination — and the 404 log offers a one-click "Mark as Gone (410)" action next to "Create redirect". A 410 tells search engines a URL was intentionally and permanently removed, so it is deindexed faster than a 404.

### Patch Changes

- [#1521](https://github.com/emdash-cms/emdash/pull/1521) [`1b10c1d`](https://github.com/emdash-cms/emdash/commit/1b10c1d64d5975c5fef94e61e8cbff251260184c) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes the byline search box still blanking the page while you type. Searching now keeps the current results on screen as the new query loads, instead of collapsing into a full-page loader and dropping the input's focus on each settled keystroke.

- Updated dependencies []:
  - @emdash-cms/blocks@0.21.0

## 0.20.0

### Minor Changes

- [#1427](https://github.com/emdash-cms/emdash/pull/1427) [`acfeb89`](https://github.com/emdash-cms/emdash/commit/acfeb89060eec29b50cd076b9099bb20d40e7380) Thanks [@swissky](https://github.com/swissky)! - Media details show the file URL with a Copy URL action

  The media library previously exposed no way to obtain a file's URL — the
  detail panel now shows the absolute file URL (relative local-storage paths
  are resolved against the current origin) with a one-click copy button, so
  editors can paste media URLs wherever a URL field is needed.

- [#1425](https://github.com/emdash-cms/emdash/pull/1425) [`3e344af`](https://github.com/emdash-cms/emdash/commit/3e344af2c162e37dfa389b9cb88c2c826590b678) Thanks [@swissky](https://github.com/swissky)! - Repeater fields support `image` sub-fields with the media picker ([#1424](https://github.com/emdash-cms/emdash/issues/1424))

  Repeater rows previously rendered every non-scalar sub-field as a plain text
  input, so galleries had to be built from hand-pasted URLs. Image sub-fields
  now render the same media-picker UI as top-level image fields (select,
  preview, change, remove) and store the same MediaValue shape — legacy string
  URLs keep working.

  Includes: `image` in the schema-builder sub-field type select, the shared
  `ImageFieldRenderer` extracted out of `ContentEditor` for reuse, and the
  sub-field type whitelists in core (`REPEATER_SUB_FIELD_TYPES` + the API Zod
  enum) extended — the Zod enum also gains the previously missing `url` entry
  that the builder already offered.

### Patch Changes

- [#1447](https://github.com/emdash-cms/emdash/pull/1447) [`141aa11`](https://github.com/emdash-cms/emdash/commit/141aa11213206d9ea5e14d1f1cd75c07cfacae7b) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes `@atcute` peer dependency warnings on install ([#1435](https://github.com/emdash-cms/emdash/issues/1435))

  Installing EmDash pulled in mismatched `@atcute` package versions, so `pnpm install` / `npm install` reported unmet peer warnings for `@atcute/identity` and `@atcute/lexicons`. The bundled `@atcute` dependencies are now aligned on v2 and installs are clean. If your project also depends on `@atcute` packages directly, note they have moved to v2 (`@atcute/client` 5, `@atcute/lexicons` 2, `@atcute/atproto` 4, `@atcute/oauth-node-client` 2).

- [#1478](https://github.com/emdash-cms/emdash/pull/1478) [`ddf8f0d`](https://github.com/emdash-cms/emdash/commit/ddf8f0d40fdc4d9138c00cc6bc718cff9e5a4ed3) Thanks [@pitscher](https://github.com/pitscher)! - Fixes localization for sections API fallback error messages in the admin UI

- [#1473](https://github.com/emdash-cms/emdash/pull/1473) [`68840a9`](https://github.com/emdash-cms/emdash/commit/68840a9326ff275519eafea9dfe0cebaebaf664a) Thanks [@pitscher](https://github.com/pitscher)! - Fixes localization for the dashboard API fallback error message in the admin UI

- [#1468](https://github.com/emdash-cms/emdash/pull/1468) [`eaedec0`](https://github.com/emdash-cms/emdash/commit/eaedec0cac0780da13d0184534364f5c3291ba8a) Thanks [@pitscher](https://github.com/pitscher)! - Fixes localization for the generic dialog error fallback in the admin UI

- [#1465](https://github.com/emdash-cms/emdash/pull/1465) [`8bb20c4`](https://github.com/emdash-cms/emdash/commit/8bb20c4a48b6f1137c6d9e05d60603c2f6db1091) Thanks [@pitscher](https://github.com/pitscher)! - Fixes untranslated MediaPickerModal references for the library

- [#1486](https://github.com/emdash-cms/emdash/pull/1486) [`fb31240`](https://github.com/emdash-cms/emdash/commit/fb31240d649e874e5148d468b857da0598edc487) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds an avatar image picker to the byline editor. The `avatarMediaId` field was already part of the byline model and API but had no admin control, so byline avatars could only be set programmatically, and editing a byline through the UI cleared any avatar that had been set. You can now choose, change, and remove a byline's avatar from the editor.

- [#1476](https://github.com/emdash-cms/emdash/pull/1476) [`022fd66`](https://github.com/emdash-cms/emdash/commit/022fd66e27396cace47032153acb2d8024ca472e) Thanks [@pitscher](https://github.com/pitscher)! - Fixes localization for search API fallback error messages in the admin UI

- [#1454](https://github.com/emdash-cms/emdash/pull/1454) [`5d8358b`](https://github.com/emdash-cms/emdash/commit/5d8358b408ac4a85fb7156963a15de3862ffe28f) Thanks [@pitscher](https://github.com/pitscher)! - Fixes untranslated ContentTypeEditor form text to let it be translatable

- [#1499](https://github.com/emdash-cms/emdash/pull/1499) [`ce96271`](https://github.com/emdash-cms/emdash/commit/ce9627190e84f2f4df4c1c405dc60a790bae38d0) Thanks [@swissky](https://github.com/swissky)! - Capitalize German status labels (`published`, `scheduled`, `archived`, `pending`) in the admin UI. As standalone badge labels these are nouns and should follow German capitalization (e.g. "publiziert" → "Publiziert"), matching the already-capitalized "Entwurf".

- [#1470](https://github.com/emdash-cms/emdash/pull/1470) [`b2e65ac`](https://github.com/emdash-cms/emdash/commit/b2e65acc7e11294dede51b2d2642db6c00654141) Thanks [@pitscher](https://github.com/pitscher)! - Fixes localization for media API fallback error messages in the admin UI

- [#1475](https://github.com/emdash-cms/emdash/pull/1475) [`589d07f`](https://github.com/emdash-cms/emdash/commit/589d07fc620e41a14d4aa2bdecf4db9d82f118eb) Thanks [@pitscher](https://github.com/pitscher)! - Fixes localization for the current-user API fallback error message in the admin UI

- [#1411](https://github.com/emdash-cms/emdash/pull/1411) [`d6269e7`](https://github.com/emdash-cms/emdash/commit/d6269e7eb69af3390dae302641e03d7687df19d4) Thanks [@memdigital](https://github.com/memdigital)! - Adds an en-GB (British English) locale to the admin UI. British spelling and morphology only - terminology is unchanged. en-GB browsers are auto-selected via the existing Accept-Language resolution.

- [#1477](https://github.com/emdash-cms/emdash/pull/1477) [`325c673`](https://github.com/emdash-cms/emdash/commit/325c6737bf59913d2a50b7f5add306c5cd57d1f0) Thanks [@pitscher](https://github.com/pitscher)! - Fixes localization for shared API fallback messages in the admin UI

- [#1496](https://github.com/emdash-cms/emdash/pull/1496) [`af4af50`](https://github.com/emdash-cms/emdash/commit/af4af50ff7d22c057063a436f3e7a408e33a3d7b) Thanks [@ahliweb](https://github.com/ahliweb)! - Fixes the remaining untranslated Indonesian admin strings.

- [#1472](https://github.com/emdash-cms/emdash/pull/1472) [`c48604b`](https://github.com/emdash-cms/emdash/commit/c48604bb71e20cef58eb2d12bcb5a8e49575477d) Thanks [@pitscher](https://github.com/pitscher)! - Fixes localization for settings API fallback error messages in the admin UI

- [#1455](https://github.com/emdash-cms/emdash/pull/1455) [`52ea731`](https://github.com/emdash-cms/emdash/commit/52ea731ace97cb4e429365f0ec844d0e9286130c) Thanks [@pitscher](https://github.com/pitscher)! - Fixes untranslated PluginFieldErrorBoundary strings

- [#1507](https://github.com/emdash-cms/emdash/pull/1507) [`6c1fe5c`](https://github.com/emdash-cms/emdash/commit/6c1fe5ccb9ebe530d6c30defaeaec8f260b5b386) Thanks [@ascorbic](https://github.com/ascorbic)! - Speeds up browsing and searching large media libraries. The media library and the media picker now load small resized thumbnails through Astro's image endpoint instead of fetching every grid item's full-size original, so opening the library and searching for older items no longer waits on full-resolution downloads ([#1488](https://github.com/emdash-cms/emdash/issues/1488)). Where no runtime image service is available the original is served as before, so nothing renders worse than it did.

- [#1500](https://github.com/emdash-cms/emdash/pull/1500) [`6246774`](https://github.com/emdash-cms/emdash/commit/624677408362e1c9e8153b1d742e93667e42511a) Thanks [@swissky](https://github.com/swissky)! - Fix unreadable "Published" status badge in dark mode. The content editor rendered the published badge as `<Badge variant="primary" className="text-white">`, which produces white text on a light inverted background in dark mode. Use the semantic `variant="success"` (green) instead, which is dark-mode aware and matches the green "published" badge used on the content overview list.

- [#1461](https://github.com/emdash-cms/emdash/pull/1461) [`b01aa9b`](https://github.com/emdash-cms/emdash/commit/b01aa9bbb436bcec07516b499eb0516cfbe414b4) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes registry installs failing with "Plugin manifest has changed since you consented" for plugins that declare hook-registration capabilities (email transport, email events, page fragments) or read user records. Plugin bundles now declare their access as a structured `declaredAccess` contract that the registry record, the install-consent dialog, and the sandbox all read consistently, so every capability a plugin declares is shown for consent and enforced — no capability is silently dropped. Re-publish affected plugins to adopt the new bundle format; existing installs are unaffected.

- [#1471](https://github.com/emdash-cms/emdash/pull/1471) [`5f7cd11`](https://github.com/emdash-cms/emdash/commit/5f7cd11a06791dcb25e02a962429ca3dcf66fb1e) Thanks [@pitscher](https://github.com/pitscher)! - Fixes localization for email settings API fallback error messages in the admin UI

- [#1469](https://github.com/emdash-cms/emdash/pull/1469) [`263392f`](https://github.com/emdash-cms/emdash/commit/263392fc08cd91013e406d014e69fe44b5ffdf00) Thanks [@pitscher](https://github.com/pitscher)! - Fixes localization for plugin API fallback error messages in the admin UI

- [#1466](https://github.com/emdash-cms/emdash/pull/1466) [`eddadf8`](https://github.com/emdash-cms/emdash/commit/eddadf86bce4dad713a605f5ec7df1922b9affe1) Thanks [@pitscher](https://github.com/pitscher)! - Fixes localization for code block language labels in the admin editor

- Updated dependencies [[`141aa11`](https://github.com/emdash-cms/emdash/commit/141aa11213206d9ea5e14d1f1cd75c07cfacae7b), [`b01aa9b`](https://github.com/emdash-cms/emdash/commit/b01aa9bbb436bcec07516b499eb0516cfbe414b4)]:
  - @emdash-cms/registry-client@0.3.2
  - @emdash-cms/registry-lexicons@0.1.1
  - @emdash-cms/plugin-types@0.1.0
  - @emdash-cms/blocks@0.20.0

## 0.19.0

### Minor Changes

- [#1442](https://github.com/emdash-cms/emdash/pull/1442) [`e96587f`](https://github.com/emdash-cms/emdash/commit/e96587f8ff393939355d3d643a322fe7b2c07c86) Thanks [@ascorbic](https://github.com/ascorbic)! - Add status, author, and date-range filtering to the admin content list ([#1288](https://github.com/emdash-cms/emdash/issues/1288)). The content list API gains `authorId`, `dateField`, `dateFrom`, and `dateTo` query params (all additive and optional), and a new `GET /_emdash/api/content/{collection}/authors` endpoint lists the distinct authors of a collection's content (gated on `content:read`). Filtering runs server-side, so it works across the whole collection rather than only the loaded page.

### Patch Changes

- [#1307](https://github.com/emdash-cms/emdash/pull/1307) [`cedfcc5`](https://github.com/emdash-cms/emdash/commit/cedfcc527d47131baaa5dcfb29fb7b4a966265d5) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Forward `locale` query param through admin content edit route, content list navigation links, and API client to resolve correct i18n variant for slug-based lookups ([#1242](https://github.com/emdash-cms/emdash/issues/1242))

- [#1417](https://github.com/emdash-cms/emdash/pull/1417) [`7e70abc`](https://github.com/emdash-cms/emdash/commit/7e70abcc1434dc2fd94c1f51c8c8c76acc9aa536) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fix taxonomy term edit dialog overflow with many locales ([#1269](https://github.com/emdash-cms/emdash/issues/1269))

  Adds `max-h-[85vh] flex flex-col` to the `TermFormDialog` and makes its body
  scrollable with `flex-1 overflow-y-auto`, keeping the header and footer pinned.
  This prevents the Cancel/Update buttons from falling off-screen when the
  Translations panel lists a large number of locales.

- [#1440](https://github.com/emdash-cms/emdash/pull/1440) [`783e663`](https://github.com/emdash-cms/emdash/commit/783e66365d5800e01ab445cbb411237240ff2ab4) Thanks [@diogoascarneiro](https://github.com/diogoascarneiro)! - Add a visible WYSIWYG toolbar button for inserting HTML blocks, matching the existing `/html` shortcut.

- [#1142](https://github.com/emdash-cms/emdash/pull/1142) [`157237d`](https://github.com/emdash-cms/emdash/commit/157237d6b3db0301f059534c9390bdef0a02b0cf) Thanks [@OrangeManLi](https://github.com/OrangeManLi)! - Fixes nested-list serialization in the Portable Text editor. `convertList` now recurses into nested `bulletList`/`orderedList` children and emits each block with the correct `level` value, so Tab-indented list items in the editor round-trip through `onChange` as real nested portable-text blocks instead of being flattened to a single top-level list with every item at `level: 1`.

- Updated dependencies []:
  - @emdash-cms/blocks@0.19.0

## 0.18.0

### Patch Changes

- [#1384](https://github.com/emdash-cms/emdash/pull/1384) [`d2829e3`](https://github.com/emdash-cms/emdash/commit/d2829e36c0e568db4ec92f500b166e03f0c36973) Thanks [@ahliweb](https://github.com/ahliweb)! - Updates the Indonesian admin catalog for the byline schema and custom-field management UI with formal, complete translations.

- Updated dependencies []:
  - @emdash-cms/blocks@0.18.0

## 0.17.2

### Patch Changes

- [#1305](https://github.com/emdash-cms/emdash/pull/1305) [`4ee75f8`](https://github.com/emdash-cms/emdash/commit/4ee75f851da4461a599f892c820152377625ef70) Thanks [@eyupcanakman](https://github.com/eyupcanakman)! - Fixes plugin admin pages showing a Plugin Error when opened from the Plugin Manager. The Settings gear opens a plugin at its root (`/plugins/<id>/`), but a plugin that registers its page at `/settings` rather than `/` had no page there, so the admin fell through to a 404. Plugin page resolution now resolves the plugin root to the first registered page and treats `/settings` and `/settings/` as the same path, so a single registration works from the Plugin Manager gear and the sidebar regardless of trailing slash.

- Updated dependencies []:
  - @emdash-cms/blocks@0.17.2

## 0.17.1

### Patch Changes

- [#1342](https://github.com/emdash-cms/emdash/pull/1342) [`83daa41`](https://github.com/emdash-cms/emdash/commit/83daa4149ed0d1ccf23d9f90304ef6ba3545d46f) Thanks [@bergaaberg](https://github.com/bergaaberg)! - Adds Norwegian Bokmål (nb) locale to the admin UI.

- [#1334](https://github.com/emdash-cms/emdash/pull/1334) [`dfabafe`](https://github.com/emdash-cms/emdash/commit/dfabafeb5db9c27c861015e7d426eb40d6ed940a) Thanks [@theobaidur](https://github.com/theobaidur)! - Honor the `icon` field on plugin `adminPages` in the sidebar nav.

  Plugin admin pages declared via `adminPages: [{ path, label, icon }]` previously rendered with a hardcoded `PuzzlePiece` glyph — the `icon` field was accepted in the types but never read at runtime. The sidebar now resolves the icon name to its `@phosphor-icons/react` component: common documented names (`settings`, `chart`, `history`, `image`, `trophy`, …) are statically mapped so they resolve synchronously, and any other name is matched against the full Phosphor set by converting it to PascalCase (e.g. `chart-bar` → `ChartBar`) and lazy-loading it from a code-split chunk. The full set is therefore reachable without bundling it into the admin's main chunk. Unknown or omitted names fall back to `PuzzlePiece`, so the change is purely additive.

- Updated dependencies []:
  - @emdash-cms/blocks@0.17.1

## 0.17.0

### Minor Changes

- [#1258](https://github.com/emdash-cms/emdash/pull/1258) [`28432b9`](https://github.com/emdash-cms/emdash/commit/28432b9b5a045c9227d59f7762bf9cb37067a950) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Adds custom fields to bylines. Sites can define site-specific byline metadata (Twitter handle, pronouns, company, localised job title, etc.) via the new `/byline-schema` admin screen, accessed from the **Byline schema** link button at the top of the Bylines admin page (admin-only).

  Per-field `translatable` flag picks whether values are stored per-locale (one value per locale row in a `translation_group`) or shared across every locale variant of the same byline identity. Schema management is gated by `schema:manage`; value editing by `bylines:manage`.

  Custom-field values can be set at both create and update time. `POST` and `PUT` on `/_emdash/api/admin/bylines` accept the same `customFields` map; the row write and the custom-field writes share a single transaction on Node/PG so a partial failure rolls both back. On D1 (no transactions), a retry POST is treated as completing an abandoned create iff three checks all pass: (a) every fixed column on the existing row matches the new payload (`displayName`, `bio`, `avatarMediaId`, `websiteUrl`, `userId`, `isGuest`, effective locale — null-vs-undefined normalised); (b) the existing row's `translationGroup` matches what a fresh create with the same input would produce (`sourceGroup` when `translationOf` is present, `existing.id` when it isn't); (c) every custom-field value already stored on the row appears in the input payload with an equal value (subset-match, so partial mid-loop crashes can be completed). The recovery branch is conservative on every axis: any fixed-column mismatch, any translation-group mismatch, any overlapping custom-field value mismatch, an input that omits a key the existing row stores, or an input with no custom fields at all → standard `CONFLICT`. Validation runs before any DB write so a bad value (unknown slug, type mismatch, select-choice miss, non-URL or non-http(s) URL for a `url` field) returns 400 `VALIDATION_ERROR` without leaving partial state behind. In the admin, registered fields render inline with Name, Bio, etc. — no separate section header — and are available in the **New byline** dialog as well as edit.

  `BylineSummary` gains an optional `customFields: Record<string, CustomFieldValue>` property. Existing object-literal consumers stay source-compatible because the property is optional and runtime always returns `{}` when no fields are registered.

  Hydration is symmetric with writes: rows are only applied to a byline when they live in the table matching the field's current `translatable` flag, so stale rows from a `translatable` flip can't leak into hydrated output. Schema mutations on `/byline-schema` invalidate the same `byline-fields` query the byline form reads, so newly-registered fields appear in the editor without a page reload. `url` field values are parsed with `new URL(...)` AND restricted to `http:` / `https:` schemes at write time so they can't ship `javascript:` / `data:` / `mailto:` payloads to link rendering. The `BylineFieldEditor` "Save" button stays disabled until a `select` field has at least one option; and select-option lists are accumulated on a null-prototype object so option values that collide with `Object.prototype` keys render correctly.

  The field-definitions cache uses parity on `options.byline_fields_version` as a dirty bit: schema mutations flip the counter to odd before the write lands and to a **new even** value after, with the cache treating any odd version as "bypass the global holder, read fresh from the DB". `markVersionDirty` is parity-aware (ensures odd, no-op if already odd) so a crashed prior attempt's leftover dirty state can't get inverted. `markVersionClean` is **always-advance** (`+2` when starting even, `+1` when starting odd) so two concurrent mutators can't collapse on the same even key and pin the cache on a partial-set snapshot — every committed mutation produces an observable counter change for cache readers. Idempotent-retry exits (`FIELD_EXISTS` on create, `FIELD_NOT_FOUND` on update/delete, no-op input on update) call `markVersionClean` too, which doubles as both the dirty-crash recovery and the false-clean recovery. All version writes use `INSERT … ON CONFLICT DO UPDATE` so a missing options row can't silently turn invalidation into a no-op.

  Implements [#1174](https://github.com/emdash-cms/emdash/discussions/1174). Builds on the bylines-i18n foundation from [#1146](https://github.com/emdash-cms/emdash/pull/1146).

- [#1215](https://github.com/emdash-cms/emdash/pull/1215) [`590b2f9`](https://github.com/emdash-cms/emdash/commit/590b2f97367d6881d8c59e5f0a88e7ad69138acb) Thanks [@scottbuscemi](https://github.com/scottbuscemi)! - First-class HTML block in the admin editor. The existing `htmlBlock` Portable Text type (produced by the WordPress and Contentful importers) is now a fully editable block in the rich-text editor. Authors can insert an HTML block via the `/html` slash command and edit raw HTML in a textarea. Imported `htmlBlock` content that previously fell through to an opaque `pluginBlock` placeholder is now rendered in the same editable UI. The inline (visual-editing) editor preserves HTML blocks as read-only placeholders to prevent data loss.

### Patch Changes

- [#1297](https://github.com/emdash-cms/emdash/pull/1297) [`cccf4f2`](https://github.com/emdash-cms/emdash/commit/cccf4f2b40451efa724136e815158ebca189a135) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fix content entity editor block menu actions (Duplicate / Delete) not working when the drag handle sets a NodeSelection ([#1261](https://github.com/emdash-cms/emdash/issues/1261)).

- [#1225](https://github.com/emdash-cms/emdash/pull/1225) [`886f2d1`](https://github.com/emdash-cms/emdash/commit/886f2d1e4969403787cc39dfbda6dcdfe034372c) Thanks [@scottbuscemi](https://github.com/scottbuscemi)! - Add search to the byline picker on content entities and remove the effective 100-byline cap. The picker now performs a debounced server-side search via the bylines API instead of rendering a fixed dropdown of the first 100 results, so bylines beyond the first page can be found and credited. Credited bylines from the saved entry are also resolved from the entry itself, so a credit that falls outside the initial list still renders its name instead of disappearing.

- [#1222](https://github.com/emdash-cms/emdash/pull/1222) [`a5dafb3`](https://github.com/emdash-cms/emdash/commit/a5dafb32b75358c96be5f2a2487bf323a0045bb8) Thanks [@scottbuscemi](https://github.com/scottbuscemi)! - Fixes the byline search box reloading the whole page on every keystroke. The search term is now debounced (300ms) before it feeds the bylines query, and the full-page loader only takes over when there is no data yet (`isLoading && !data`) instead of on every new query key. Typing now stays responsive and keeps the input focused, matching the behaviour of the users page. The load-more snapshot and its filter-match check both use the debounced search value so appended pages are no longer discarded.

- [#1226](https://github.com/emdash-cms/emdash/pull/1226) [`9422d6a`](https://github.com/emdash-cms/emdash/commit/9422d6a744b17f477a3966c3c7e07a087a3345e6) Thanks [@scottbuscemi](https://github.com/scottbuscemi)! - Make content list search work on large collections ([#1219](https://github.com/emdash-cms/emdash/issues/1219)). The admin content list previously filtered only the rows already loaded on the current page, so an entry far back in a big collection could not be found until you navigated near it. The list endpoint now accepts a `q` parameter and performs a case-insensitive substring search across the collection's title/name/slug columns server-side (LIKE wildcards in the query are escaped), and the admin search box drives that query (debounced) instead of filtering in memory. Also adds locale-aware composite indexes (`idx_{table}_loc_upd` / `idx_{table}_loc_crt`) so locale-filtered content lists stay index-served on large, i18n-enabled tables.

- [#1224](https://github.com/emdash-cms/emdash/pull/1224) [`67f5992`](https://github.com/emdash-cms/emdash/commit/67f5992aec23d02c724505632ce951e5b7af9cdb) Thanks [@scottbuscemi](https://github.com/scottbuscemi)! - Fix taxonomy terms not being locale-aware in the content editor ([#1218](https://github.com/emdash-cms/emdash/issues/1218)). Term assignments are stored against the per-locale content row while the term's `translation_group` spans every locale, so resolving terms for an entry must scope to the entry's locale. The content terms endpoint (`/content/:collection/:id/terms/:taxonomy`) now derives the entry's locale server-side and passes it to `getTermsForEntry`, and the admin `TaxonomySidebar` threads the entry locale through its fetch/save calls (and into its React Query keys, so switching translations refetches). Previously a localized post showed and applied every locale variant of a tag instead of just the variant for its own locale.

- [#1227](https://github.com/emdash-cms/emdash/pull/1227) [`a40e455`](https://github.com/emdash-cms/emdash/commit/a40e455a8de730a61291798a3fe0ee32dde24ed0) Thanks [@scottbuscemi](https://github.com/scottbuscemi)! - Add search and filtering to the media library ([#1221](https://github.com/emdash-cms/emdash/issues/1221)). The media list endpoint now accepts a `q` parameter for a case-insensitive filename substring search (which also matches extensions, with LIKE wildcards escaped), alongside the existing `mimeType` filter. The Media Library page gains a filename search box and a type filter (images / video / audio / documents), and the media picker in the content editor now searches the local library by filename too. Previously neither surface could search or filter local media, which made large libraries hard to navigate.

- [#1223](https://github.com/emdash-cms/emdash/pull/1223) [`34afc14`](https://github.com/emdash-cms/emdash/commit/34afc1448440f8ffab956f096322d67ec42127cb) Thanks [@scottbuscemi](https://github.com/scottbuscemi)! - The rich-text editor formatting toolbar now stays pinned to the top of the editing area while scrolling through long posts, instead of scrolling out of view. The toolbar uses `position: sticky` and the editor wrapper switched from `overflow-hidden` to `overflow-clip` so corners stay clipped without creating a nested scroll container that would break sticky positioning. Distraction-free / minimal editors (e.g. Widgets) are unaffected since they don't render the toolbar.

- [#1309](https://github.com/emdash-cms/emdash/pull/1309) [`019d9e4`](https://github.com/emdash-cms/emdash/commit/019d9e44c5331d92abad78d7f9abfe2aefa4d1fe) Thanks [@ahliweb](https://github.com/ahliweb)! - Fix the remaining Indonesian admin translations.

- [#1310](https://github.com/emdash-cms/emdash/pull/1310) [`ba0f3d4`](https://github.com/emdash-cms/emdash/commit/ba0f3d4f1d13d30d540895225556560bee176026) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fix "Add Content" in the menu editor: the admin was sending the raw collection slug (e.g. `pages`) as the menu item `type`, which the API's `menuItemTypeEnum` rejects with a 400. Map the picker's collection to the correct enum value (`pages` → `page`, `posts` → `post`, everything else → `collection`) so picking a page or post actually adds it to the menu. ([#1173](https://github.com/emdash-cms/emdash/issues/1173))

- [#1290](https://github.com/emdash-cms/emdash/pull/1290) [`aacdf20`](https://github.com/emdash-cms/emdash/commit/aacdf207b6e31b98debacf12d52138d74371869f) Thanks [@SL33PiNg](https://github.com/SL33PiNg)! - i18n(th): translate remaining untranslated Thai (ไทย) admin UI strings, including the newly-added plugin registry and Portable Text HTML-block strings

- [#1245](https://github.com/emdash-cms/emdash/pull/1245) [`7d55db6`](https://github.com/emdash-cms/emdash/commit/7d55db6ca3291eac1c2cfda865e1b0e507fdece5) Thanks [@SL33PiNg](https://github.com/SL33PiNg)! - Adds Thai (ไทย) locale to the admin UI.

- Updated dependencies [[`69bdc97`](https://github.com/emdash-cms/emdash/commit/69bdc97e3e4b69a111b3e5210900e23f35134f8d)]:
  - @emdash-cms/registry-client@0.3.1
  - @emdash-cms/blocks@0.17.0

## 0.16.1

### Patch Changes

- [#1277](https://github.com/emdash-cms/emdash/pull/1277) [`2c36d55`](https://github.com/emdash-cms/emdash/commit/2c36d5514f317d5c01a19def93956922d3b0557c) Thanks [@ahliweb](https://github.com/ahliweb)! - Completes the Indonesian translations for the admin UI and keeps `id` as the canonical locale code.

- [#1278](https://github.com/emdash-cms/emdash/pull/1278) [`930d23b`](https://github.com/emdash-cms/emdash/commit/930d23bb0e3c3a860904996ef7ddd6c239572203) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix admin sidebar rendering white text on a light background in light mode. Kumo 2.4 moved the sidebar surface to an inner container painted with `bg-(--sidebar-bg)`, where `--sidebar-bg` is resolved from the wrapper's default (light) `--color-kumo-base`. The sidebar's dark-chrome override only set `--color-kumo-base`, which no longer reaches that surface, so the dark background was lost while the white text remained. The override now sets `--sidebar-bg` directly.

- Updated dependencies []:
  - @emdash-cms/blocks@0.16.1

## 0.16.0

### Minor Changes

- [#1238](https://github.com/emdash-cms/emdash/pull/1238) [`60c0b2e`](https://github.com/emdash-cms/emdash/commit/60c0b2eeab7726471b313d0c453de82df1e08558) Thanks [@ascorbic](https://github.com/ascorbic)! - Registry plugins can now declare environment requirements. A plugin's manifest may set a release-level `requires` block (e.g. `{ "env:emdash": ">=1.0.0", "env:astro": ">=4.16" }`), which is published into the release record. When browsing a registry plugin, the admin compares those constraints against the running EmDash and Astro versions: if the host doesn't satisfy them, it shows a compatibility warning and disables the Install button. The server enforces the same check on install and update, refusing an incompatible release with `ENV_INCOMPATIBLE` so the gate can't be bypassed.

- [#1239](https://github.com/emdash-cms/emdash/pull/1239) [`1a4918f`](https://github.com/emdash-cms/emdash/commit/1a4918ff989d57b4f12e44b647542e406dce7cb9) Thanks [@ascorbic](https://github.com/ascorbic)! - Plugins published to the experimental registry can now ship icon, screenshot, and banner images. Declare them in `emdash-plugin.jsonc` under `release.artifacts` as file refs; `emdash-plugin publish --artifact-base-url <url>` measures each image's dimensions, uploads it, and records it in the release. The admin plugin detail page renders the icon, banner, and a screenshot gallery, fetched through a server-side image proxy. The proxy resolves each artifact's URL server-side from the validated release record (the client sends only the artifact's coordinates, never a URL), then applies SSRF defences and an image content-type allowlist before serving the bytes. Supported image types are PNG, JPEG, WebP, GIF, and AVIF; SVG is rejected at both publish and proxy because it is active content.

- [#1253](https://github.com/emdash-cms/emdash/pull/1253) [`d2f2679`](https://github.com/emdash-cms/emdash/commit/d2f26792bc8f053693bfb0a6a9d65a7403753f0a) Thanks [@ascorbic](https://github.com/ascorbic)! - The registry plugin detail page now surfaces a plugin's long-form profile sections. Publishers' `description`, `installation`, `faq`, `changelog`, and `security` sections render as sanitized Markdown (the shared audited `renderMarkdown` — raw HTML, scripts, and images stripped, https-only links) in a tabbed view below the install action, with one tab per non-empty section. The page also shows an SBOM badge with the document format and a guarded direct download link (rendered only for safe http(s) URLs), the publisher-asserted `lastUpdated` time labelled distinctly from the aggregator's `indexedAt`, and an accessible tooltip on the verified-publisher shield naming the labeller DID that issued the verification.

### Patch Changes

- [#1257](https://github.com/emdash-cms/emdash/pull/1257) [`62619c2`](https://github.com/emdash-cms/emdash/commit/62619c2d7eeb0ea1ff4178ec4090c2872df51073) Thanks [@Rimander](https://github.com/Rimander)! - Completes the Spanish (Spain) admin translation, filling the 54 remaining untranslated strings across the plugin registry, SEO/social-image settings, the code-block editor, byline/content strings, and the capability-consent dialog. The `es-ES` catalog is now fully translated.

- [#1255](https://github.com/emdash-cms/emdash/pull/1255) [`3d540da`](https://github.com/emdash-cms/emdash/commit/3d540daf4b2c89c408038ae55799e2513c1ef9c9) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix admin crash on authenticated load with @cloudflare/kumo 2.4.x ([#1240](https://github.com/emdash-cms/emdash/issues/1240)). The
  sidebar was using `Sidebar.GroupContent` and group-level `collapsible`/
  `defaultOpen` props, which were removed in kumo 2.4.0. The four nav sections
  (Content, Manage, Admin, Plugins) now render as plain `Sidebar.Group` blocks.
  The workspace catalog range for `@cloudflare/kumo` is bumped from `^2.3.0` to
  `^2.4.0` to match.

- [#1248](https://github.com/emdash-cms/emdash/pull/1248) [`b89e988`](https://github.com/emdash-cms/emdash/commit/b89e988da2a930450ae237ae55b2594bbf395770) Thanks [@mvanhorn](https://github.com/mvanhorn)! - Fixes the flat taxonomy tag picker so focusing an empty input shows available existing terms for the collection.

- [#1244](https://github.com/emdash-cms/emdash/pull/1244) [`4612749`](https://github.com/emdash-cms/emdash/commit/4612749770dba13ac6e01e8953854f318b9913dd) Thanks [@pitscher](https://github.com/pitscher)! - Fixes admin UI translations for permission counts and action labels so languages can use their correct plural forms and word order

- Updated dependencies [[`60c0b2e`](https://github.com/emdash-cms/emdash/commit/60c0b2eeab7726471b313d0c453de82df1e08558)]:
  - @emdash-cms/registry-client@0.3.0
  - @emdash-cms/blocks@0.16.0

## 0.15.0

### Minor Changes

- [#1146](https://github.com/emdash-cms/emdash/pull/1146) [`11b3001`](https://github.com/emdash-cms/emdash/commit/11b300100e066c6b3463070a9b65fba868f37e9b) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Adds first-class i18n support for bylines, mirroring the row-per-locale model already used by menus and taxonomies (PR #916, migrations 036).

  ## Schema (migration 040)

  `_emdash_bylines` gains two columns:
  - `locale` — `TEXT NOT NULL DEFAULT 'en'`. Every row now belongs to exactly one locale.
  - `translation_group` — `TEXT NOT NULL`. Shared across every locale variant of a single byline identity. The anchor row's `translation_group` equals its `id`; siblings inherit it.

  A partial unique index `idx_bylines_group_locale_unique` enforces one row per `(translation_group, locale)`. The pre-existing `(slug)` unique index becomes `(slug, locale)` to allow the same slug across locales.

  Existing rows are backfilled to the configured `defaultLocale` (or `'en'` if i18n isn't configured) with `translation_group = id`. Monolingual sites see no functional change; multilingual sites continue rendering the same byline data at the default locale until editors create translations.

  ## Credit hydration: strict per-locale

  `_emdash_content_bylines.byline_id` now stores the byline's `translation_group`, not its row id. When an entry is rendered, credits are filtered by joining the junction against the byline sibling whose `locale` matches the entry's `locale`. If no sibling exists at the entry's locale, the credit hydrates as empty — there is **no fallback** to other locales' bios.

  Author-inferred bylines (where an entry has no explicit credits but its author is linked to a byline) still fall back per-locale and respect the strictness gate: an entry with explicit credits at any locale will not infer from the author even if the explicit credits don't resolve at the rendering locale.

  This is a deliberate behavior change for multilingual sites. The motivation is correctness: chain-walking credits across locales renders the wrong-language bio on translated entries.

  The "explicit credit suppresses author fallback" check reads `primary_byline_id` directly from the content row — set by `setContentBylines` iff junction rows exist, backfilled by migration 040 for pre-existing rows. No separate probe against `_emdash_content_bylines` is needed at hydration time; the column is folded into the single per-entry context fetch (`author_id` + `primary_byline_id` in one query). Both monolingual and multilingual sites get the same query count.

  ## Identity lookups: chain-walk

  `getBylineBySlug(slug, { locale })` walks the configured fallback chain (`resolveLocaleChain`), like `getMenu` and `getTerm`. Author pages for un-translated bylines still render an identity rather than 404'ing. This is conceptually distinct from credit hydration and runs through `requestCached` for per-render dedupe.

  ## Admin
  - **TranslationsPanel** in the bylines editor lists every configured locale with Edit / Translate buttons. The Translate action POSTs to the new `POST /_emdash/api/admin/bylines/:id/translations` endpoint.
  - **LocaleSwitcher** on `/bylines` filters the list strictly to one locale. Cross-locale navigation via TranslationsPanel routes through `/bylines?locale=…`.
  - The **byline picker** on the content editor is locale-pinned to the entry's locale. Editors only see bylines that will actually hydrate at the entry's locale.
  - The **byline credit empty state** on a locale with no bylines yet shows a CTA linking to `/bylines?locale=…` for inline creation.
  - Translating an entry (`POST /content/:collection` with `translationOf`) calls `copyContentBylines` to inherit the source's credits — these resolve at the new entry's locale via the strict-hydration model, so credits "follow" the content across translations once sibling bylines exist.

  ## API additions
  - `GET /_emdash/api/admin/bylines/:id/translations` — list every sibling row sharing a translation_group.
  - `POST /_emdash/api/admin/bylines/:id/translations` — create a sibling at a target locale. Body defaults (slug, displayName, websiteUrl, avatar) inherit from the source.
  - `POST /_emdash/api/admin/bylines` accepts `translationOf` + `locale` to create a sibling in one call.
  - `GET /_emdash/api/admin/bylines?locale=…` filters strictly.
  - `BylineSummary` gains `locale: string` and `translationGroup: string | null` (additive — existing consumers ignore the new fields).

  ## Permissions

  Two new entries on `@emdash-cms/auth`:
  - `bylines:read` — minimum `SUBSCRIBER`.
  - `bylines:manage` — minimum `EDITOR`.

  All byline routes (list, get, update, delete, translations) now check these instead of `content:read` / `Role.EDITOR`. Role thresholds are unchanged, so existing users see no permission differences. Custom RBAC configurations that bind to the old strings should add the new permission names.

  ## Repository
  - `BylineRepository` is strict per-locale: `findMany`, `findBySlug`, `findById` accept an optional `locale` and return rows matching that locale (or all locales when omitted, for the manager view).
  - New methods: `listTranslations(id)`, `findByTranslationGroup(group)`, `copyContentBylines(collection, fromId, toId)`.
  - `setContentBylines` deduplicates by `translation_group` after resolving wire row ids, so passing two sibling row ids of the same identity collapses to one credit row.
  - `delete` is sibling-aware: removing one locale variant leaves siblings standing.

  ## Notable trade-offs
  - **Strict hydration over chain-walking** for credits. Chain-walking would render mismatched-language bios on translated content. The honest answer is to show nothing rather than the wrong thing; the picker tells editors which bylines will resolve at the entry's locale, and the empty-state CTA makes creating a sibling a one-click flow.
  - **Schema is row-per-locale**, not a separate `byline_translations` side-table. Matches the existing content / menu / taxonomy convention so query patterns and indexes are consistent across the codebase.

- [#1176](https://github.com/emdash-cms/emdash/pull/1176) [`fae97ee`](https://github.com/emdash-cms/emdash/commit/fae97ee5465934365864557e9fa3ee8754cfd49c) Thanks [@ascorbic](https://github.com/ascorbic)! - Code blocks in the rich text editor now have an inline language picker. Hover over any code block to reveal a chip in the corner; click it to enter a language (free-form input with curated suggestions for ~30 common languages including TypeScript, Python, Bash, Rust, Astro, SQL, and more). Aliases resolve automatically -- typing `ts` stores `typescript`, `c++` stores `cpp`, etc. The existing markdown shortcut (typing ` ```html ` followed by a space or Enter) continues to pre-populate the language. The chosen language persists on the Portable Text `language` field and is emitted as a `language-{id}` class on the rendered `<pre>` so frontend syntax highlighters can pick it up. The visual (in-place) editor gets the same picker UI.

- [#1114](https://github.com/emdash-cms/emdash/pull/1114) [`9a30607`](https://github.com/emdash-cms/emdash/commit/9a30607791a2f27473b1d2fe7700291e0be1ea1c) Thanks [@ascorbic](https://github.com/ascorbic)! - Plugins installed from the experimental registry can now be uninstalled and updated from the admin, the same way marketplace plugins always could. The "uninstall is not yet available for registry plugins" placeholder is gone — registry plugin rows now show the same Uninstall and Update buttons.

  The Plugins page's "updates available" indicator now covers registry plugins too. If the registry aggregator is unreachable, marketplace updates still load (and vice versa).

  Updates that need newly-declared permissions, or that newly expose a public (unauthenticated) route, prompt for re-consent before installing the new version — matching the gate that marketplace updates already have.

- [#1125](https://github.com/emdash-cms/emdash/pull/1125) [`d0ff94b`](https://github.com/emdash-cms/emdash/commit/d0ff94bd476e7fd4b5d18c94904cfb5c071fea92) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds a version picker to the registry plugin detail page. Older releases of a registry-hosted plugin are now selectable from a dropdown next to the Install button, and the displayed version, indexed date, permissions, and source link swap to match the selected release. Pre-release versions (e.g. `1.0.0-alpha.1`) are flagged with a "Pre-release" badge so admins can spot them before installing. Versions still inside the configured minimum-release-age holdback remain visible in the dropdown but stay non-installable until they age into the window.

### Patch Changes

- [#1177](https://github.com/emdash-cms/emdash/pull/1177) [`b9cc08e`](https://github.com/emdash-cms/emdash/commit/b9cc08e7556ccdbcbbcea6d3c06cae6abef18766) Thanks [@ascorbic](https://github.com/ascorbic)! - Bumps `@cloudflare/kumo` from 1.16 to 2.3. Two internal call sites picked up breaking API changes from Kumo 2.0: `Collapsible` is now a compound component (`Collapsible.Root` / `.DefaultTrigger` / `.DefaultPanel` instead of `<Collapsible label=...>`), used by the accordion block; and `ChartPalette.color()` was renamed to `ChartPalette.categorical()` in the chart block. No public API changes -- consumers see identical behaviour. Tests in `@emdash-cms/admin` that asserted on `Button`'s native `title` attribute now read `aria-label` instead, because Kumo 2 wraps `<Button title>` in a Tooltip popup rather than setting the DOM attribute.

- [#1119](https://github.com/emdash-cms/emdash/pull/1119) [`393dd26`](https://github.com/emdash-cms/emdash/commit/393dd26fd4e6fc38ed2584cbb5f29d5f69fb1dad) Thanks [@adentdk](https://github.com/adentdk)! - Fixes auto-save not detecting plugin block field changes. When editing an existing block's attributes via the Block Kit modal, the change now correctly triggers TipTap's `onUpdate` callback, propagating through to the auto-save dirty detection.

- Updated dependencies [[`cf3c706`](https://github.com/emdash-cms/emdash/commit/cf3c706a65087696eb6cca5844b7668a50e4a090), [`b9cc08e`](https://github.com/emdash-cms/emdash/commit/b9cc08e7556ccdbcbbcea6d3c06cae6abef18766)]:
  - @emdash-cms/registry-client@0.2.0
  - @emdash-cms/blocks@0.15.0

## 0.14.0

### Minor Changes

- [#1112](https://github.com/emdash-cms/emdash/pull/1112) [`3756168`](https://github.com/emdash-cms/emdash/commit/37561682224447c7280648dc770ab408afc4186a) Thanks [@ascorbic](https://github.com/ascorbic)! - Renders the full registry package profile in the admin. The plugin detail page now shows the license (linked to spdx.org for single SPDX identifiers), keywords, all authors, all security contacts, and a link to the source repository. The browse cards show the license alongside the description.

### Patch Changes

- [#1101](https://github.com/emdash-cms/emdash/pull/1101) [`e539731`](https://github.com/emdash-cms/emdash/commit/e539731451994206bf60824a31815a8a925c7252) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes experimental registry navigation and allows the configured registry aggregator through the admin CSP.

- Updated dependencies [[`3756168`](https://github.com/emdash-cms/emdash/commit/37561682224447c7280648dc770ab408afc4186a)]:
  - @emdash-cms/registry-client@0.1.0
  - @emdash-cms/blocks@0.14.0

## 0.13.0

### Minor Changes

- [#1052](https://github.com/emdash-cms/emdash/pull/1052) [`0d5843f`](https://github.com/emdash-cms/emdash/commit/0d5843fc3378936667ab81c56001349198028ebb) Thanks [@Rimander](https://github.com/Rimander)! - Fixes menu REST API consistency:
  - **`POST /menus/:name/items` no longer accepts unknown keys silently.** Sending `custom_url` (snake_case) or `url` used to return 201 with `custom_url: null` because Zod's default `.strip()` quietly dropped them. The schemas now use `.strict()` and return **400 `VALIDATION_ERROR`** with `Unrecognized key: "custom_url"`. The documented camelCase keys (`customUrl`, `sortOrder`, `referenceCollection`, etc.) are unchanged and persist as before. The `type` field is now validated against the canonical enum (`"custom" | "page" | "post" | "taxonomy" | "collection"`); previously any string passed.
  - **Moves per-item writes to `PUT` and `DELETE /menus/:name/items/:id` (path-style).** Every other EmDash resource (`content`, `taxonomies`, `redirects`, `sections`, `widget-areas`) addresses items by URL path; menus were the lone outlier requiring `?id=<id>` in the query string. The legacy query-string form is **removed** (it was undocumented and only used by the admin, which is updated in this PR). Callers should use `PUT /menus/:name/items/:id` / `DELETE /menus/:name/items/:id`.
  - **Menu and menu-item API responses are now camelCase**, aligning with the rest of EmDash's REST surface (`content`, `taxonomies`, `redirects`, …). `created_at` → `createdAt`, `updated_at` → `updatedAt`, `menu_id` → `menuId`, `parent_id` → `parentId`, `sort_order` → `sortOrder`, `reference_collection` → `referenceCollection`, `reference_id` → `referenceId`, `custom_url` → `customUrl`, `title_attr` → `titleAttr`, `css_classes` → `cssClasses`, `translation_group` → `translationGroup`. **Breaking** for direct REST consumers that depend on snake_case keys in the response body. The admin UI is already updated.
  - **Refactors menus to the standard repository pattern.** Adds `MenuRepository` next to `ContentRepository`, `TaxonomyRepository`, `RedirectRepository`, `MediaRepository`, `CommentRepository`. Handlers become thin orchestrators; the repository is now the single place where snake_case rows become camelCase entities.

  These changes do not touch any database schema or migration. Existing data is preserved.

- [#1011](https://github.com/emdash-cms/emdash/pull/1011) [`dbaea9c`](https://github.com/emdash-cms/emdash/commit/dbaea9ccaef6ac48dda14b77c6b2adbe0dc0ff38) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds experimental support for the decentralized plugin registry (see RFC #694). Configure with `experimental.registry.aggregatorUrl` in `astro.config.mjs`; the admin UI then uses the registry instead of the centralized marketplace for browse and install. Marketplace behavior is unchanged when the option is not set.

  The experimental config accepts a `policy.minimumReleaseAge` duration (e.g. `"48h"`) that holds back releases below that age from install and update prompts, with a `policy.minimumReleaseAgeExclude` allowlist for trusted publishers or specific packages. The minimum-release-age check is enforced both client-side (for UX) and server-side (in the install endpoint), so stale browser tabs and deep links still hit the gate.

### Patch Changes

- [#751](https://github.com/emdash-cms/emdash/pull/751) [`05440b1`](https://github.com/emdash-cms/emdash/commit/05440b11ef5df609ad7f800143fa96019da22101) Thanks [@edrpls](https://github.com/edrpls)! - Fix the admin collection list pagination denominator so it no longer grows in increments of 5 as the user pages forward.

  The `GET /_emdash/api/content/{collection}` response now includes a `total` field with the full filtered row count (independent of `limit`). The admin uses it as the pagination denominator, so a 143-entry collection reads `1/8` on page 1 instead of `1/5 → 5/10 → 10/15 → …` as successive API pages load.

  The `total` field is optional; pre-upgrade clients that ignore it still work, and the admin falls back to the loaded-item count when an older server doesn't return it.

  Also handles the edge case where the current page exceeds `totalPages` after filtering or deletion — the admin clamps the active page so the table doesn't render empty while waiting for a refetch.

- [#1050](https://github.com/emdash-cms/emdash/pull/1050) [`484e7ab`](https://github.com/emdash-cms/emdash/commit/484e7ab66a9d7910bcb56b3385babb28a8ff0986) Thanks [@wojtekpiskorz](https://github.com/wojtekpiskorz)! - Fixes broken image collapsing media picker container — adds `onError` handler and fallback placeholder so Change/Remove buttons remain accessible when referenced image is missing from storage

- [#1013](https://github.com/emdash-cms/emdash/pull/1013) [`0cd8c6d`](https://github.com/emdash-cms/emdash/commit/0cd8c6d4e0f0dc126d66f953afcfdc3d6201d00b) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes the slash command menu's initial selection getting overridden when the menu opens under a stationary pointer. The menu items previously reacted to `mouseenter` unconditionally, so an item rendered beneath the cursor would steal selection from the keyboard default before any user interaction. Mouse-hover-selects still works, but only after the user actually moves the pointer over the menu.

- [#1020](https://github.com/emdash-cms/emdash/pull/1020) [`d014b48`](https://github.com/emdash-cms/emdash/commit/d014b483e438a52fb27fcfa47ed6ef64a24e21df) Thanks [@ahliweb](https://github.com/ahliweb)! - Adds missing Indonesian (id) translations for SEO settings labels and replaces "Edit" with "Sunting" and "Tagline" with "Slogan" across the admin UI.

- Updated dependencies []:
  - @emdash-cms/blocks@0.13.0

## 0.12.0

### Minor Changes

- [#997](https://github.com/emdash-cms/emdash/pull/997) [`7b45cba`](https://github.com/emdash-cms/emdash/commit/7b45cba66143c3a75bbd880abff85303c1fd6072) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds support for a site-wide default Open Graph image. The setting is exposed in the admin SEO settings page (Settings -> SEO -> Default Social Image), resolved to a URL on read by `getSiteSettings()`, and automatically emitted as `og:image` / `twitter:image` (and BlogPosting JSON-LD `image`) by `EmDashHead.astro` whenever a page has no image of its own. Per-page images still take precedence.

  This wires up an existing data model that was previously defined in the schema and MCP tools but never used: stored values were not resolved and no template path read the setting.

  Emitted URLs are absolutized using `SiteSettings.url`, the page's `siteUrl`, or the request origin so crawlers and JSON-LD consumers that reject relative URLs work correctly.

  Also adds a `localOnly` prop to `MediaPickerModal` that suppresses the "Insert from URL" input and external provider tabs. Used by SEO settings to ensure the picker only returns locally-stored media (since the setting only persists a local `mediaId`).

  Media metadata updates and deletes now invalidate the worker-scoped site-settings cache, so resolved logo/favicon/default-social-image URLs and dimensions stay in sync with the underlying media row.

### Patch Changes

- [#996](https://github.com/emdash-cms/emdash/pull/996) [`19576be`](https://github.com/emdash-cms/emdash/commit/19576be43134359596ca7705f84fd645bd2f3824) Thanks [@r2sake](https://github.com/r2sake)! - Fix media library admin page and the media picker modal (used by the rich text editor and image fields when embedding media into content) to support libraries larger than 50 items by wiring up cursor-based infinite scroll (mirrors the content list fix from #135)

- [#1004](https://github.com/emdash-cms/emdash/pull/1004) [`35791ff`](https://github.com/emdash-cms/emdash/commit/35791ff9f68c10c6d3ff15ee0ab407baef09c2aa) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes a stale ref race in the slash command menu's keyboard handlers. The state ref was synced via `useEffect` (post-commit), so TipTap's Suggestion plugin could read stale state when invoking `onKeyDown` synchronously -- causing Enter to occasionally fail to execute commands and arrow navigation to skip selections on slower runs.

- Updated dependencies []:
  - @emdash-cms/blocks@0.12.0

## 0.11.1

### Patch Changes

- Updated dependencies []:
  - @emdash-cms/blocks@0.11.1

## 0.11.0

### Minor Changes

- [#942](https://github.com/emdash-cms/emdash/pull/942) [`7c536e5`](https://github.com/emdash-cms/emdash/commit/7c536e59b005a79925dd0ecab46404d9d34196b8) Thanks [@MA2153](https://github.com/MA2153)! - Adds per-field allowed MIME types for `file` and `image` fields. Field-level `allowedTypes` is now honored end-to-end: it filters the media picker, widens upload acceptance for that field (so e.g. a zip-only field can accept zip uploads even though the global allowlist excludes them), and validates referenced media against the destination field on content save. The schema editor in admin gains an "Allowed types" control with curated presets and freeform entry.

  Behavior change: the `image` builder's `allowedTypes` option was previously accepted but read by nothing. It is now load-bearing — a code-first schema that already passed `allowedTypes` (e.g. `["image/png"]`) will now actually narrow the picker and gate uploads. Most users will see no change; if you set this option intending the old (silent) behavior, drop it.

  Behavior change: updating a field via the admin schema editor now explicitly clears its validation when the form contains no validation settings, instead of leaving an existing `validation` value intact. This only affects fields with pre-existing validation that is not expressible in the editor UI.

- [#921](https://github.com/emdash-cms/emdash/pull/921) [`530b013`](https://github.com/emdash-cms/emdash/commit/530b013000e0547bc01f252113cff77c1e26e485) Thanks [@jcheese1](https://github.com/jcheese1)! - Adds table support to the PortableText editor. Users can now insert and edit tables via the slash command menu (/table) or toolbar button. Tables support header rows, column/row insertion and deletion, and include a bubble menu for quick editing.

### Patch Changes

- [#958](https://github.com/emdash-cms/emdash/pull/958) [`7f6b6ea`](https://github.com/emdash-cms/emdash/commit/7f6b6ead417f3b495843a4da5653531cf735aae4) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes admin lists, tables and info cards rendering as transparent against the page background. Card containers in the content list, content type list, content type editor, media library, comments, users and device authorization views now have an explicit `bg-kumo-base` surface so they're visually distinct from the body.

  Also fixes column header labels in content list tables ("Title", "Status", etc.) rendering pale because of an undefined Tailwind class (`text-kumo-fg`) -- they now use the default text color and rely on the sort indicator icon to signal active state.

- [#952](https://github.com/emdash-cms/emdash/pull/952) [`131bea6`](https://github.com/emdash-cms/emdash/commit/131bea68b7f580e353716a1a1934f2a6fec3b3e7) Thanks [@ascorbic](https://github.com/ascorbic)! - Replaces 20 raw `<input type="checkbox">` elements across the admin UI with Kumo's `Switch` and `Checkbox` components. Single-boolean toggles (SEO, Enable comments, Required, etc.) become `Switch`; multi-select / list-context checkboxes (collection multi-select, term tree nodes) become `Checkbox`. Drops manual styling and label markup that duplicated what the Kumo components provide built-in.

- [#956](https://github.com/emdash-cms/emdash/pull/956) [`54b5aa1`](https://github.com/emdash-cms/emdash/commit/54b5aa1c189d7ebd8d34e02a9b3c3a560b5f263f) Thanks [@CacheMeOwside](https://github.com/CacheMeOwside)! - Fixes broken checkboxes on the comments moderation page (`/_emdash/admin/comments`). Selecting a comment threw a JavaScript error and did not select the row.

- [#934](https://github.com/emdash-cms/emdash/pull/934) [`c630e31`](https://github.com/emdash-cms/emdash/commit/c630e31d1362a275c95324f4bbc1e92d0a4646cf) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes button and link inconsistencies across the admin UI. Standardises on Kumo's `Button` `icon` prop and `LinkButton` (with `external` for new-tab links) instead of manual icon spacing and raw anchor styling, removes a `<Link><Button>` invalid HTML nesting in the plugin manager, and translates two stray English strings in the user list empty state.

- [#949](https://github.com/emdash-cms/emdash/pull/949) [`7aa1897`](https://github.com/emdash-cms/emdash/commit/7aa189782946bb99397ea909cac50fc1109b27b9) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes invalid `<a><button>` HTML produced by `<Link><Button>...</Button></Link>` patterns across the admin UI. Introduces a `RouterLinkButton` component that wraps TanStack Router's `<Link>` with Kumo button styling (`variant`, `size`, `shape`, `icon` props), and migrates all existing `<Link className={buttonVariants(...)}>` usages to use it. Extracts the duplicated "Back to settings" header link into a shared `BackToSettingsLink` component.

- [#940](https://github.com/emdash-cms/emdash/pull/940) [`0b8a319`](https://github.com/emdash-cms/emdash/commit/0b8a319e7afb247b1ebacd60aeb6052bec5560d5) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes the long tail of untranslated English strings in the admin UI: settings panels, marketplace, sandboxed-plugin host, auth flows, taxonomy/menu management, and lib/api fallback messages. After this PR, EmDash admin UI is fully localizable across all known surfaces.

- [#957](https://github.com/emdash-cms/emdash/pull/957) [`13ff061`](https://github.com/emdash-cms/emdash/commit/13ff061517ede4b29608de0120283914b43e6b76) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes the OG image picker in the content editor only appearing for collections with a field literally named `featured_image`. The OG image control now lives in the SEO sidebar panel alongside the other SEO fields, so any collection with `seo` enabled can set a social preview image regardless of whether it has a featured image field.

- [#955](https://github.com/emdash-cms/emdash/pull/955) [`49b66d9`](https://github.com/emdash-cms/emdash/commit/49b66d910c80b87b2632ad34e923695c9a302a05) Thanks [@ascorbic](https://github.com/ascorbic)! - Removes the sticky editor header from content / content-type / section / settings pages. The sticky implementation had transparency artifacts (backdrop-blur over varied content), layout fragility (negative margins canceling parent padding), z-index conflicts with the app bar, and ~85px of permanent vertical chrome. Each editor now renders a Save button at the bottom of the form so users can save without scrolling back to the top header. The distraction-free hover-overlay header in the content editor is preserved.

- [#966](https://github.com/emdash-cms/emdash/pull/966) [`1b2fa77`](https://github.com/emdash-cms/emdash/commit/1b2fa77d0c1455f9478908234f45e9d91847e044) Thanks [@ahliweb](https://github.com/ahliweb)! - i18n(id): complete Indonesian translation (320 strings)

- [#937](https://github.com/emdash-cms/emdash/pull/937) [`af15975`](https://github.com/emdash-cms/emdash/commit/af15975b1c8daf6bdef216ac56693568d448a112) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes ~250 untranslated English strings in the admin UI's most-used screens (router toasts, content type editor, widgets, byline and user routes, invite-accept flow, portable text editor toolbar, image and embed editor nodes, user list). All `title=`, `aria-label=`, `placeholder=`, and toast messages in these areas now flow through Lingui.

- [#950](https://github.com/emdash-cms/emdash/pull/950) [`a4968c1`](https://github.com/emdash-cms/emdash/commit/a4968c105741ca008035d1f33e55851b52a7d2d6) Thanks [@ascorbic](https://github.com/ascorbic)! - Replaces raw `<select>` and `<input type="search">` elements across the admin UI with Kumo's `Select` and `Input` components. This gives consistent styling, proper focus rings, accessibility (label association via the Field wrapper), and dark-mode handling for free instead of relying on hand-rolled Tailwind classes that bypassed the design system.

- [#973](https://github.com/emdash-cms/emdash/pull/973) [`f80fb58`](https://github.com/emdash-cms/emdash/commit/f80fb58ca5906d65e7f1a38d91267ce511d2bef2) Thanks [@ahliweb](https://github.com/ahliweb)! - Translates the remaining untranslated string in the Indonesian locale, bringing it to 100% coverage.

- Updated dependencies []:
  - @emdash-cms/blocks@0.11.0

## 0.10.0

### Patch Changes

- [#719](https://github.com/emdash-cms/emdash/pull/719) [`2e2b8e9`](https://github.com/emdash-cms/emdash/commit/2e2b8e90c099f3422808f0e1da9c83a9ec533b64) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes the `file` field type rendering as a plain text input in the content editor. Adds a `FileFieldRenderer` that opens the media picker (with mime filter disabled) so any file type can be attached. Also adds a `hideUrlInput` prop to `MediaPickerModal` so non-image pickers can hide the image-specific "Insert from URL" input.

  Aligns the Zod schema and generated TypeScript types for `image` and `file` fields with the shape the admin actually stores: `provider?`, `meta?` (for both), and `previewUrl?` (for image). Previously these fields were stripped on validation and missing from generated types, so site code could not reliably resolve local media URLs from `meta.storageKey`.

- Updated dependencies [[`5eb4318`](https://github.com/emdash-cms/emdash/commit/5eb431876cbfb69a961735fbb6ab09c9de937f28)]:
  - @emdash-cms/blocks@0.10.0

## 0.9.0

### Minor Changes

- [#731](https://github.com/emdash-cms/emdash/pull/731) [`9dfc65c`](https://github.com/emdash-cms/emdash/commit/9dfc65c42c04c41088e0c8f5a8ca4347643e2fea) Thanks [@drudge](https://github.com/drudge)! - Adds a `media_picker` Block Kit element: a thumbnail preview with a modal library picker and mime-type filter. Usable in plugin block forms and in Block Kit field widgets. The stored value is the selected asset's URL string, so it is value-compatible with a plain `text_input` — existing content continues to work after swapping. The `mime_type_filter` is restricted to image MIME types (`image/` or `image/<subtype>`); wildcards and non-image types are rejected.

- [#809](https://github.com/emdash-cms/emdash/pull/809) [`e7df21f`](https://github.com/emdash-cms/emdash/commit/e7df21f0adca795cdb233d6e64cd543ead7e2347) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds an optional `category` field to `PortableTextBlockConfig` for plugin-contributed block types. Plugins can now choose how their blocks are grouped in the admin slash menu (e.g. "Sections", "Marketing", "Media", "Layout") instead of always falling under "Embeds". Existing plugins that omit the field continue to render under "Embeds" exactly as before.

- [#814](https://github.com/emdash-cms/emdash/pull/814) [`a838000`](https://github.com/emdash-cms/emdash/commit/a83800068678daf6391e02bba8acf27ff4db0e19) Thanks [@arashackdev](https://github.com/arashackdev)! - rtl srtyle improvements and LTR/RTL compatible arrow/caret icons

- [#854](https://github.com/emdash-cms/emdash/pull/854) [`491aeec`](https://github.com/emdash-cms/emdash/commit/491aeec5a66e2f764eb9d8ed8425e9d402ada4a7) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Adds consistently-placed sticky Save buttons across editor pages so unsaved changes are always visible. The Content editor, Section editor, Content Type editor, and Settings sub-pages (General, SEO, Social Links) now render their primary save action in a sticky top-right header that stays visible while users scroll long forms. The existing bottom-of-form save buttons are preserved so keyboard and screen-reader users still hit a save action as the last interactive control on the page (DOM order is unchanged). Introduces a shared `EditorHeader` component for editor pages that want the same sticky-header pattern. Fixes #233.

### Patch Changes

- [#849](https://github.com/emdash-cms/emdash/pull/849) [`d6754ae`](https://github.com/emdash-cms/emdash/commit/d6754ae7746b0f9035d2c5e390ece7199762b094) Thanks [@drudge](https://github.com/drudge)! - Fixes the `datetime` field widget so existing values display in the editor and new values pass server validation. The widget passed raw ISO 8601 (`YYYY-MM-DDTHH:mm:ss.sssZ`) into `<input type="datetime-local">`, which silently rendered empty, and emitted `YYYY-MM-DDTHH:mm` on save, which the field's zod schema rejected. Strips the suffix for display, appends `:00.000Z` on save, and normalizes date-only stored values to UTC midnight for the input. Applies to the top-level `datetime` widget in the content editor and the `datetime` sub-field type inside `RepeaterField`.

- [#702](https://github.com/emdash-cms/emdash/pull/702) [`0ee372a`](https://github.com/emdash-cms/emdash/commit/0ee372a7f33eecce7d90e12624923d2d9c132adf) Thanks [@ilicfilip](https://github.com/ilicfilip)! - Adds `@emdash-cms/plugin-field-kit` — composable field widgets for `json` fields. Four widgets (`object-form`, `list`, `grid`, `tags`) are configured entirely through seed `options` so site builders don't need to write React to get a usable editing UI. Widgets store clean JSON (no nesting, no mutation of shape), so removing the plugin leaves valid data in the database. See discussion #571 for background.

  Widens `FieldDescriptor.options` to `Array<{ value: string; label: string }> | Record<string, unknown>` so plugin widgets can accept arbitrary widget config (not only enum choices). The array shape for `select` / `multiSelect` continues to work unchanged.

- [#856](https://github.com/emdash-cms/emdash/pull/856) [`ef3f076`](https://github.com/emdash-cms/emdash/commit/ef3f076c8112e9dffc2a87c019e5521e823f5e86) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Fixes `npm install` peer dependency conflicts (#819) by removing `react` and `react-dom` from `dependencies`. They were declared in both `dependencies` and `peerDependencies`, which made npm think the admin package required an exact pinned React version and conflicted with the host Astro app's React. They remain `peerDependencies` (`^18.0.0 || ^19.0.0`), and the host app supplies React.

- [#821](https://github.com/emdash-cms/emdash/pull/821) [`8d0feb3`](https://github.com/emdash-cms/emdash/commit/8d0feb3eece62b01075260bbb79188984a8631b8) Thanks [@r2sake](https://github.com/r2sake)! - Fixes the Settings (gear) icon on the Plugin Manager so it links to the plugin's primary admin page instead of a non-existent `/settings` sub-route.

- [#862](https://github.com/emdash-cms/emdash/pull/862) [`8354088`](https://github.com/emdash-cms/emdash/commit/83540887936a87a6c99230b21d2afe3fe424218c) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Fixes slug-style `<input pattern="...">` attributes so HTML form validation works in current browsers. The patterns used `[a-z0-9-]+`, which is rejected as `Invalid character class` when compiled with the `v` (unicode-sets) flag — the mode browsers now use for the `pattern` attribute. The dangling `-` is now escaped (`[a-z0-9\-]+`), restoring slug validation in the Sections list/edit, Menus list, and Widgets create-area dialogs. Resolves #845.

- [#887](https://github.com/emdash-cms/emdash/pull/887) [`254a443`](https://github.com/emdash-cms/emdash/commit/254a443684ec3bddfc2706b349d6ccce901987af) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes stale content shown in the Portable Text editor when switching between translations of the same content. Previously, navigating from one locale's editor to another (e.g. from the English version of a post to the French version) kept the previous locale's body in the editor, and any subsequent edit would silently overwrite the new translation's content. The form now resets synchronously when the underlying content item changes, and field editors are keyed by item id so they remount cleanly on a translation switch.

- [#885](https://github.com/emdash-cms/emdash/pull/885) [`25128b2`](https://github.com/emdash-cms/emdash/commit/25128b2444853e3301af7ff09d21a3f5883a599f) Thanks [@ahliweb](https://github.com/ahliweb)! - Fixes malformed ICU plural syntax in Indonesian (id) locale — ContentList item count now renders correctly

- [#872](https://github.com/emdash-cms/emdash/pull/872) [`ab45916`](https://github.com/emdash-cms/emdash/commit/ab45916e8561678ccddf7d6184a7d56729ea03cc) Thanks [@ahliweb](https://github.com/ahliweb)! - Enables Indonesian (Bahasa Indonesia) locale in the admin UI

- [#807](https://github.com/emdash-cms/emdash/pull/807) [`0913a39`](https://github.com/emdash-cms/emdash/commit/0913a39a23538c96bfa62fe7da37bf332d18bb46) Thanks [@ascorbic](https://github.com/ascorbic)! - Sizes the plugin block edit modal based on field complexity so Block Kit forms have room to breathe. Simple URL embeds keep the previous compact dialog; forms with several fields get a wider one, and forms containing a repeater open at the largest size. Inputs inside the dialog now fill the available width.

- [#815](https://github.com/emdash-cms/emdash/pull/815) [`ddbf808`](https://github.com/emdash-cms/emdash/commit/ddbf8088e1bcfa07d6347a953bb1995295e8f8fd) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes content list loading state showing `No results for ""` instead of a loader while items are being fetched. The trash tab gets the same treatment.

- [#870](https://github.com/emdash-cms/emdash/pull/870) [`1c958fb`](https://github.com/emdash-cms/emdash/commit/1c958fb484387cd8cce7fab53ff4eddfe0dbb7f6) Thanks [@CacheMeOwside](https://github.com/CacheMeOwside)! - Fixes the image-settings icon in the Section editor so it actually opens `<ImageDetailPanel>` in the sidebar.

- [#816](https://github.com/emdash-cms/emdash/pull/816) [`d4be24f`](https://github.com/emdash-cms/emdash/commit/d4be24f478a0c8d0a7bba3c299e11105bba3ed94) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Unifies plugin capability names under a single `<resource>[.<sub-resource>]:<verb>[:<qualifier>]` formula so capabilities read like RBAC permissions, separates hook-registration permissions from data-access ones for clearer audits, and replaces the overloaded `:any` qualifier with the more conspicuous `:unrestricted`. Old names are still accepted with `@deprecated` warnings; `emdash plugin bundle` and `emdash plugin validate` warn for each deprecated name and `emdash plugin publish` refuses manifests that still use them.

  The Cloudflare sandbox bridge and HTTP fetch helper now enforce canonical names (`content:read`, `content:write`, `media:read`, `media:write`, `users:read`, `network:request`, `network:request:unrestricted`). Manifests that still declare legacy names continue to work — the runner normalizes capabilities before passing them into the bridge, so installed plugins with `read:content` resolve to `content:read` and reach the same code path.

  | Old                 | New                              |
  | ------------------- | -------------------------------- |
  | `read:content`      | `content:read`                   |
  | `write:content`     | `content:write`                  |
  | `read:media`        | `media:read`                     |
  | `write:media`       | `media:write`                    |
  | `read:users`        | `users:read`                     |
  | `network:fetch`     | `network:request`                |
  | `network:fetch:any` | `network:request:unrestricted`   |
  | `email:provide`     | `hooks.email-transport:register` |
  | `email:intercept`   | `hooks.email-events:register`    |
  | `page:inject`       | `hooks.page-fragments:register`  |

  Existing installs keep working — manifests are normalized at every external boundary and `diffCapabilities` normalizes both sides so version upgrades that only rename do not trigger a "capability changed" prompt. Deprecated names will be removed in the next minor.

- Updated dependencies [[`7b8d496`](https://github.com/emdash-cms/emdash/commit/7b8d4964c619821937d1a738cbd6f81e98095a91), [`9dfc65c`](https://github.com/emdash-cms/emdash/commit/9dfc65c42c04c41088e0c8f5a8ca4347643e2fea), [`a838000`](https://github.com/emdash-cms/emdash/commit/a83800068678daf6391e02bba8acf27ff4db0e19)]:
  - @emdash-cms/blocks@0.9.0

## 0.8.0

### Minor Changes

- [#679](https://github.com/emdash-cms/emdash/pull/679) [`493e317`](https://github.com/emdash-cms/emdash/commit/493e3172d4539d8e041e6d2bf2d7d2dc89b2a10d) Thanks [@drudge](https://github.com/drudge)! - Adds a `repeater` Block Kit element: array-of-objects with scalar sub-fields, drag-to-reorder, and collapsible item cards. Plugin block forms can now capture repeating data (FAQ rows, carousel slides, card grids) inline in the portable-text editor.

- [#779](https://github.com/emdash-cms/emdash/pull/779) [`e402890`](https://github.com/emdash-cms/emdash/commit/e402890fcd8647fdfe847bb34aa9f9e7094473dd) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `settings_get` and `settings_update` MCP tools so agents can read and update site-wide settings (title, tagline, logo, favicon, URL, posts-per-page, date format, timezone, social, SEO). `settings_get` resolves media references (logo/favicon/seo.defaultOgImage) to URLs; `settings_update` is a partial update that preserves omitted fields. New `settings:read` (EDITOR+) and `settings:manage` (ADMIN) API token scopes back the tools, with matching options in the personal API token settings UI.

- [#398](https://github.com/emdash-cms/emdash/pull/398) [`31333dc`](https://github.com/emdash-cms/emdash/commit/31333dc593e2b9128113e4e923455209f11853fd) Thanks [@simnaut](https://github.com/simnaut)! - Adds pluggable auth provider system with AT Protocol as the first plugin-based provider. Refactors GitHub and Google OAuth from hardcoded buttons into the same `AuthProviderDescriptor` interface. All auth methods (passkey, AT Protocol, GitHub, Google) are equal options on the login page and setup wizard.

### Patch Changes

- [#611](https://github.com/emdash-cms/emdash/pull/611) [`86b26f6`](https://github.com/emdash-cms/emdash/commit/86b26f6c1067efb28d8f7cb447be23da99d2e38e) Thanks [@drudge](https://github.com/drudge)! - Wires up the block configuration sidebar inside `WidgetEditor`. `PortableTextEditor` now receives `onBlockSidebarOpen`/`onBlockSidebarClose` callbacks that hold the active `BlockSidebarPanel` in local state, and renders `ImageDetailPanel` when the panel type is `"image"` — mirroring the content-entry editor. Without this, clicking a block's settings button or the media picker inside widget content had no visible effect.

- [#786](https://github.com/emdash-cms/emdash/pull/786) [`e998083`](https://github.com/emdash-cms/emdash/commit/e998083115b3c5a6e27707a940dfac557ea72458) Thanks [@smart-cau](https://github.com/smart-cau)! - Adds Korean translations for 21 admin UI strings that previously fell back to English. Korean (ko) coverage is now complete.

- [#670](https://github.com/emdash-cms/emdash/pull/670) [`37ada52`](https://github.com/emdash-cms/emdash/commit/37ada52a62e94f4f0581f4356ba55dc978863f49) Thanks [@segmentationfaulter](https://github.com/segmentationfaulter)! - Change text direction of input fields and tiptap editor depending upon the language entered

- [#720](https://github.com/emdash-cms/emdash/pull/720) [`acab807`](https://github.com/emdash-cms/emdash/commit/acab8071e72a29751a55e923473cd4749e34fefd) Thanks [@Pouf5](https://github.com/Pouf5)! - Fix taxonomies not nesting correctly in a RTL layout

- [#750](https://github.com/emdash-cms/emdash/pull/750) [`0ecd3b4`](https://github.com/emdash-cms/emdash/commit/0ecd3b4901eb721825b36eb4812506032e43da14) Thanks [@edrpls](https://github.com/edrpls)! - Make the admin collection list column headers sortable. `Title`, `Status`, `Locale`, and `Date` are now clickable buttons that toggle direction; the current sort state is exposed via `aria-sort` on the `<th>` so screen readers announce it correctly.

  The server's `orderBy` field whitelist now accepts `status`, `locale`, and `name` alongside the existing date fields — unchanged from a security standpoint, the repo still rejects unknown field names to prevent column enumeration.

  Callers of `<ContentList>` that don't pass `onSortChange` render the previous static-label headers, so legacy integrations (e.g. the content picker) are unaffected.

- [#184](https://github.com/emdash-cms/emdash/pull/184) [`4c9f04d`](https://github.com/emdash-cms/emdash/commit/4c9f04d9506a9a79cec2425ccb71785a6948843a) Thanks [@masonjames](https://github.com/masonjames)! - Fixes plugin block defaults so initial values are seeded without overriding later edits.

- [#700](https://github.com/emdash-cms/emdash/pull/700) [`ed4d880`](https://github.com/emdash-cms/emdash/commit/ed4d88057e9b26d497181655eecf3e06e12a1001) Thanks [@dcardosods](https://github.com/dcardosods)! - Prefill site title and tagline in Setup Wizard from seed file

- Updated dependencies [[`6e0e921`](https://github.com/emdash-cms/emdash/commit/6e0e9215e00f6f2e84ade30447e4c30b1812dbf5), [`493e317`](https://github.com/emdash-cms/emdash/commit/493e3172d4539d8e041e6d2bf2d7d2dc89b2a10d)]:
  - @emdash-cms/blocks@1.0.0

## 0.7.0

### Minor Changes

- [#705](https://github.com/emdash-cms/emdash/pull/705) [`8ebdf1a`](https://github.com/emdash-cms/emdash/commit/8ebdf1af65764cc4b72624e7758c4a666817aade) Thanks [@eba8](https://github.com/eba8)! - Adds admin white-labeling support via `admin` config in `astro.config.mjs`. Agencies can set a custom logo, site name, and favicon for the admin panel, separate from public site settings.

### Patch Changes

- [#680](https://github.com/emdash-cms/emdash/pull/680) [`2e4b205`](https://github.com/emdash-cms/emdash/commit/2e4b205b1df30bdb6bb96259f223b85610de5e78) Thanks [@CacheMeOwside](https://github.com/CacheMeOwside)! - Fixes dark mode toggle having no effect with the classic theme.

- [#732](https://github.com/emdash-cms/emdash/pull/732) [`e3e18aa`](https://github.com/emdash-cms/emdash/commit/e3e18aae92d31cf22efd11a0ba06110de24a076a) Thanks [@jcheese1](https://github.com/jcheese1)! - Fixes select dropdown appearing behind dialog by removing explicit z-index values and adding `isolate` to the admin body for proper stacking context.

- [#647](https://github.com/emdash-cms/emdash/pull/647) [`743b080`](https://github.com/emdash-cms/emdash/commit/743b0807f1a37fdedbcd37632058b557f493f3be) Thanks [@arashackdev](https://github.com/arashackdev)! - Adds Persian (Farsi) locale with full admin translations.
  Adds Vazirmatn as the default font family for Farsi.

- [#689](https://github.com/emdash-cms/emdash/pull/689) [`fa8d753`](https://github.com/emdash-cms/emdash/commit/fa8d7533e8ba7e02599372d580399dae88ecd891) Thanks [@edrpls](https://github.com/edrpls)! - Fixes the taxonomy term picker to match across diacritic boundaries.

  Typing `Mexico` in the admin picker now surfaces a term labeled `México` instead of prompting a duplicate create. Input and term labels are folded via NFD decomposition + lowercase before substring-matching, so editors who type without diacritics — or with locale keyboards that produce precomposed vs. combining forms — still see the canonical term.

  Before this fix, `"mexico"` and `"méxico"` were treated as distinct strings, so the picker showed zero suggestions and the editor had no way to find the existing term except to create a duplicate. Duplicate terms then split the taxonomy and broke public-facing filter pages that group content by slug.

  The exact-match check that gates the "Create new term" button uses the same fold, so typing `Mexico` when `México` exists also suppresses Create — closing the duplicate-creation loop.

- Updated dependencies []:
  - @emdash-cms/blocks@0.7.0

## 0.6.0

### Minor Changes

- [#565](https://github.com/emdash-cms/emdash/pull/565) [`913cb62`](https://github.com/emdash-cms/emdash/commit/913cb6239510f9959581cb74a70faa53a462a9aa) Thanks [@ophirbucai](https://github.com/ophirbucai)! - Adds full RTL (right-to-left) support to the admin UI by converting all directional Tailwind classes to their direction-aware equivalents.

### Patch Changes

- [#610](https://github.com/emdash-cms/emdash/pull/610) [`dfcb0cd`](https://github.com/emdash-cms/emdash/commit/dfcb0cd4ed65d10212d47622b51a22b0eacf8acb) Thanks [@drudge](https://github.com/drudge)! - Passes plugin block definitions into the `PortableTextEditor` nested inside `WidgetEditor`, so custom plugin-registered block types (image blocks, marker blocks, etc.) can be inserted and rendered inside content-type widgets. The manifest is fetched with react-query in the top-level `Widgets` component, flattened into a `PluginBlockDef[]` list, and threaded through `WidgetAreaPanel` → `WidgetItem` → `WidgetEditor`.

- [#568](https://github.com/emdash-cms/emdash/pull/568) [`cf63b02`](https://github.com/emdash-cms/emdash/commit/cf63b0298576d062641cf88f37d6e7e86e4ddb3a) Thanks [@Vallhalen](https://github.com/Vallhalen)! - Fix document outline not showing headings on initial load. The outline now defers initial extraction to next tick (so TipTap finishes hydrating) and also listens for transaction events to catch programmatic content changes.

- [#564](https://github.com/emdash-cms/emdash/pull/564) [`0b32b2f`](https://github.com/emdash-cms/emdash/commit/0b32b2f3906bf5bfed313044af6371480d43edc1) Thanks [@ascorbic](https://github.com/ascorbic)! - Replaces the horizontal language-switch button bar on the admin login page with a dropdown, so the selector stays usable as more locales are added.

- [#592](https://github.com/emdash-cms/emdash/pull/592) [`6c92d58`](https://github.com/emdash-cms/emdash/commit/6c92d58767dc92548136a87cc90c1c6912da6695) Thanks [@asdfgl98](https://github.com/asdfgl98)! - Adds Korean locale support to the admin UI.

- [#559](https://github.com/emdash-cms/emdash/pull/559) [`a2d5afb`](https://github.com/emdash-cms/emdash/commit/a2d5afbb19b5bcaf98464d354322fa737a8b9ba0) Thanks [@ayfl269](https://github.com/ayfl269)! - Adds Chinese (Traditional) translation for the admin UI, including login page, settings page, and locale switching.

- [#604](https://github.com/emdash-cms/emdash/pull/604) [`39d285e`](https://github.com/emdash-cms/emdash/commit/39d285ea3d21b7b6277a554ae9cff011500655e1) Thanks [@all3f0r1](https://github.com/all3f0r1)! - Fixes loading spinner not centered under logo on the login page.

- Updated dependencies []:
  - @emdash-cms/blocks@0.6.0

## 0.5.0

### Minor Changes

- [#551](https://github.com/emdash-cms/emdash/pull/551) [`598026c`](https://github.com/emdash-cms/emdash/commit/598026c99083325c281b9e7ab87e9724e11f2c8d) Thanks [@ophirbucai](https://github.com/ophirbucai)! - Adds RTL (right-to-left) language support infrastructure. Enables proper text direction for RTL languages like Arabic, Hebrew, Farsi, and Urdu. Includes LocaleDirectionProvider component that syncs HTML dir/lang attributes with Kumo's DirectionProvider for automatic layout mirroring when locale changes.

### Patch Changes

- [#489](https://github.com/emdash-cms/emdash/pull/489) [`9ea4cf7`](https://github.com/emdash-cms/emdash/commit/9ea4cf7c63cd5a1c45ec569bd72076c935066a1c) Thanks [@all3f0r1](https://github.com/all3f0r1)! - Adds JSON field editor in admin UI content forms

- [#542](https://github.com/emdash-cms/emdash/pull/542) [`64f90d1`](https://github.com/emdash-cms/emdash/commit/64f90d1957af646ca200b9d70e856fa72393f001) Thanks [@mohamedmostafa58](https://github.com/mohamedmostafa58)! - Fixes invite flow: corrects invite URL to point to admin UI page, adds InviteAcceptPage for passkey registration.

- Updated dependencies []:
  - @emdash-cms/blocks@0.5.0

## 0.4.0

### Minor Changes

- [#516](https://github.com/emdash-cms/emdash/pull/516) [`20b03b4`](https://github.com/emdash-cms/emdash/commit/20b03b480156a5c901298a1ab9c968c800179215) Thanks [@erral](https://github.com/erral)! - Adds Basque (eu) translation

### Patch Changes

- [#490](https://github.com/emdash-cms/emdash/pull/490) [`3a96aa7`](https://github.com/emdash-cms/emdash/commit/3a96aa7f5671f6c718ab066e02c61fb55b33d901) Thanks [@all3f0r1](https://github.com/all3f0r1)! - Fixes mobile sidebar nav sections not displaying their pages

- [#87](https://github.com/emdash-cms/emdash/pull/87) [`c869df2`](https://github.com/emdash-cms/emdash/commit/c869df2b08decae6dc9c85bdfca83cc6577203cf) Thanks [@txhno](https://github.com/txhno)! - Fixes SEO sidebar text fields firing a PUT on every keystroke by debouncing saves; guards against stale server responses overwriting newer local edits.

- [#302](https://github.com/emdash-cms/emdash/pull/302) [`10ebfe1`](https://github.com/emdash-cms/emdash/commit/10ebfe19b81feacfe99cfaf2daf4976eaac17bd4) Thanks [@ideepakchauhan7](https://github.com/ideepakchauhan7)! - Fixes autosave form reset bug. Autosave no longer invalidates the query cache, preventing form fields from reverting to server state after autosave completes.

- [#36](https://github.com/emdash-cms/emdash/pull/36) [`275a21c`](https://github.com/emdash-cms/emdash/commit/275a21c389c121cbac6daa6be497ae3b6c1bfc6d) Thanks [@scottbuscemi](https://github.com/scottbuscemi)! - Fixes image field removal not persisting after save by sending null instead of undefined, which JSON.stringify was silently dropping.

- [#502](https://github.com/emdash-cms/emdash/pull/502) [`af0647c`](https://github.com/emdash-cms/emdash/commit/af0647c7352922ad63077613771150d8178263ed) Thanks [@pagelab](https://github.com/pagelab)! - Adds Portuguese (Brazil) locale with full pt-BR translations following the WordPress pt-BR glossary standard.

- [#521](https://github.com/emdash-cms/emdash/pull/521) [`b89e7f3`](https://github.com/emdash-cms/emdash/commit/b89e7f3811488ebe8fbe28068baa18f7f25844ad) Thanks [@ascorbic](https://github.com/ascorbic)! - Wraps all user-visible strings in the admin shell and core content screens with Lingui macros so they are translatable. Covers: Sidebar (nav labels, group headings), Header (View Site, Log out, Settings), ThemeToggle, Dashboard (headings, empty states, status indicators), ContentList (table headers, actions, dialogs, status badges), SaveButton, and ContentEditor (publish panel, schedule controls, byline editor, author selector, all dialogs). Runs `locale:extract` to add 116 new message IDs to all catalog files.

- [#528](https://github.com/emdash-cms/emdash/pull/528) [`ba0a5af`](https://github.com/emdash-cms/emdash/commit/ba0a5afccf110465b72916e23db4ff975d81bc2e) Thanks [@ascorbic](https://github.com/ascorbic)! - Wraps all remaining admin UI components with Lingui macros, completing full i18n coverage of the admin interface. Catalog grows from 296 to 1,216 message IDs. Covers media library, menus, sections, redirects, taxonomies, content types, field editor, plugins, marketplace, SEO panels, setup wizard, auth flows, and all settings pages.

- [#504](https://github.com/emdash-cms/emdash/pull/504) [`e2f96aa`](https://github.com/emdash-cms/emdash/commit/e2f96aa74bd936832a3a4d0636e81f948adb51c7) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes client-side locale switching and replaces toggle buttons with a Select dropdown.

- [#471](https://github.com/emdash-cms/emdash/pull/471) [`4645103`](https://github.com/emdash-cms/emdash/commit/4645103f06ae9481b07dba14af07ac0ff57e32cf) Thanks [@ayfl269](https://github.com/ayfl269)! - Adds Chinese (Simplified) translation for the admin UI, including login page, settings page, and locale switching.

- Updated dependencies []:
  - @emdash-cms/blocks@0.4.0

## 0.3.0

### Patch Changes

- [#351](https://github.com/emdash-cms/emdash/pull/351) [`c70f66f`](https://github.com/emdash-cms/emdash/commit/c70f66f7da66311fcf2f5922f23cdf951cdaff5f) Thanks [@CacheMeOwside](https://github.com/CacheMeOwside)! - Fixes redirect loops causing the ERR_TOO_MANY_REDIRECTS error, by detecting circular chains when creating or editing redirects on the admin Redirects page.

- [#499](https://github.com/emdash-cms/emdash/pull/499) [`0b4e61b`](https://github.com/emdash-cms/emdash/commit/0b4e61b059e40d7fc56aceb63d43004c8872005d) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes admin failing to load when installed from npm due to broken locale catalog resolution.

- Updated dependencies []:
  - @emdash-cms/blocks@0.3.0

## 0.2.0

### Minor Changes

- [#111](https://github.com/emdash-cms/emdash/pull/111) [`87b0439`](https://github.com/emdash-cms/emdash/commit/87b0439927454a275833992de4244678b47b9aa3) Thanks [@mvanhorn](https://github.com/mvanhorn)! - Adds repeater field type for structured repeating data

### Patch Changes

- [#467](https://github.com/emdash-cms/emdash/pull/467) [`0966223`](https://github.com/emdash-cms/emdash/commit/09662232bd960e426ca00b10e7d49585aad00f99) Thanks [@sakibmd](https://github.com/sakibmd)! - fix: move useMemo above early returns in ContentListPage

- [#349](https://github.com/emdash-cms/emdash/pull/349) [`53dec88`](https://github.com/emdash-cms/emdash/commit/53dec8822bf486a1748e381087306f6097e6290c) Thanks [@tsikatawill](https://github.com/tsikatawill)! - Fixes menu editor rejecting relative URLs like /about by changing input type from url to text with pattern validation.

- [#99](https://github.com/emdash-cms/emdash/pull/99) [`3b6b75b`](https://github.com/emdash-cms/emdash/commit/3b6b75b01b5674776cb588506d75042d4a2745ea) Thanks [@all3f0r1](https://github.com/all3f0r1)! - Fix content list not fetching beyond the first API page when navigating to the last client-side page

- [#247](https://github.com/emdash-cms/emdash/pull/247) [`a293708`](https://github.com/emdash-cms/emdash/commit/a2937083f8f74e32ad1b0383d9f22b20e18d7237) Thanks [@NaeemHaque](https://github.com/NaeemHaque)! - Fixes email settings page showing empty by registering the missing API route. Adds error state to the admin UI so fetch failures are visible instead of silently swallowed.

- [#316](https://github.com/emdash-cms/emdash/pull/316) [`c9bf640`](https://github.com/emdash-cms/emdash/commit/c9bf64003d161a9517bd78599b3d7f8d0bf93cda) Thanks [@mvanhorn](https://github.com/mvanhorn)! - Allow relative URLs in menu custom links by changing input type from "url" to "text"

- [#377](https://github.com/emdash-cms/emdash/pull/377) [`5eeab91`](https://github.com/emdash-cms/emdash/commit/5eeab918820f680ea8b46903df7d69969af8b8ee) Thanks [@Pouf5](https://github.com/Pouf5)! - Fixes new content always being created with locale `en` regardless of which locale is selected in the collection locale switcher. The "Add New" link now forwards the active locale to the new-content route, and the new-content page passes it through to the create API.

- [#185](https://github.com/emdash-cms/emdash/pull/185) [`e3f7db8`](https://github.com/emdash-cms/emdash/commit/e3f7db8bb670bb7444632ab0cd4e680e4c9029b3) Thanks [@ophirbucai](https://github.com/ophirbucai)! - Fixes field scroll-into-view not triggering when navigating to a field via URL parameter.

- [#93](https://github.com/emdash-cms/emdash/pull/93) [`a5e0603`](https://github.com/emdash-cms/emdash/commit/a5e0603b1910481d042f5a22dd19a60c76da7197) Thanks [@eyupcanakman](https://github.com/eyupcanakman)! - Fix taxonomy links missing from admin sidebar

- Updated dependencies [[`e1349e3`](https://github.com/emdash-cms/emdash/commit/e1349e342f90227c50f253cc2c1fbda0bc288a39)]:
  - @emdash-cms/blocks@0.2.0

## 0.1.1

### Patch Changes

- [#328](https://github.com/emdash-cms/emdash/pull/328) [`12d73ff`](https://github.com/emdash-cms/emdash/commit/12d73ff4560551bbe873783e4628bbd80809c449) Thanks [@jdevalk](https://github.com/jdevalk)! - Add OG Image field to content editor

- [#200](https://github.com/emdash-cms/emdash/pull/200) [`422018a`](https://github.com/emdash-cms/emdash/commit/422018aeb227dffe3da7bfc772d86f9ce9c2bcd1) Thanks [@ascorbic](https://github.com/ascorbic)! - Replace placeholder text branding with proper EmDash logo SVGs across admin UI, playground loading page, and preview interstitial

- [#306](https://github.com/emdash-cms/emdash/pull/306) [`71744fb`](https://github.com/emdash-cms/emdash/commit/71744fb8b2bcc7f48acea41f9866878463a4f4f7) Thanks [@JULJERYT](https://github.com/JULJERYT)! - Align back button position in API Tokens section

- [#135](https://github.com/emdash-cms/emdash/pull/135) [`018be7f`](https://github.com/emdash-cms/emdash/commit/018be7f1c3a8b399a9f38d7fa524e6f2908d95c3) Thanks [@fzihak](https://github.com/fzihak)! - Fix content list for large collections by implementing infinite scroll pagination

- [#181](https://github.com/emdash-cms/emdash/pull/181) [`9d10d27`](https://github.com/emdash-cms/emdash/commit/9d10d2791fe16be901d9d138e434bd79cf9335c4) Thanks [@ilicfilip](https://github.com/ilicfilip)! - fix(admin): use collection urlPattern for preview button fallback URL

- [#225](https://github.com/emdash-cms/emdash/pull/225) [`d211452`](https://github.com/emdash-cms/emdash/commit/d2114523a55021f65ee46e44e11157b06334819e) Thanks [@seslly](https://github.com/seslly)! - Adds `passkeyPublicOrigin` on `emdash()` so WebAuthn `origin` and `rpId` match the browser when dev sits behind a TLS-terminating reverse proxy. Validates the value at integration load time and threads it through all passkey-related API routes.

  Updates the admin passkey setup and login flows to detect non-secure origins and explain that passkeys need HTTPS or `http://localhost` rather than implying the browser lacks WebAuthn support.

- [#268](https://github.com/emdash-cms/emdash/pull/268) [`ab21f29`](https://github.com/emdash-cms/emdash/commit/ab21f29f713a5aa4c087c535608e1a2cab2ef9e0) Thanks [@doguabaris](https://github.com/doguabaris)! - Fixes passkey login error handling when no credential is returned from the authenticator

- [#221](https://github.com/emdash-cms/emdash/pull/221) [`bfcda12`](https://github.com/emdash-cms/emdash/commit/bfcda121400ee2bbbc35d666cc8bed38e0eba8ea) Thanks [@tohaitrieu](https://github.com/tohaitrieu)! - Fixes form state not updating when switching between taxonomy terms in the editor dialog.

- [#45](https://github.com/emdash-cms/emdash/pull/45) [`5f448d1`](https://github.com/emdash-cms/emdash/commit/5f448d1035073283fd7435d2f320d1f3c94898a0) Thanks [@Flynsarmy](https://github.com/Flynsarmy)! - Adds Back navigation to Security and Domain settings pages

## 0.1.0

### Minor Changes

- [#14](https://github.com/emdash-cms/emdash/pull/14) [`755b501`](https://github.com/emdash-cms/emdash/commit/755b5017906811f97f78f4c0b5a0b62e67b52ec4) Thanks [@ascorbic](https://github.com/ascorbic)! - First beta release

### Patch Changes

- Updated dependencies [[`755b501`](https://github.com/emdash-cms/emdash/commit/755b5017906811f97f78f4c0b5a0b62e67b52ec4)]:
  - @emdash-cms/blocks@0.1.0

## 0.0.2

### Patch Changes

- [#8](https://github.com/emdash-cms/emdash/pull/8) [`3c319ed`](https://github.com/emdash-cms/emdash/commit/3c319ed6411a595e6974a86bc58c2a308b91c214) Thanks [@ascorbic](https://github.com/ascorbic)! - Update branding
