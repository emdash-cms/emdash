# emdash

## 0.11.1

### Patch Changes

- [#991](https://github.com/emdash-cms/emdash/pull/991) [`dc44989`](https://github.com/emdash-cms/emdash/commit/dc44989b263164625039525aa84e4a562f0a879f) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes TypeError crash on all content mutation API routes when Astro's cache API is not available. The `cache` context parameter is undefined when the cache feature is not enabled, causing `cache.enabled` to throw. All 11 call sites now use optional chaining (`cache?.enabled`).

- Updated dependencies []:
  - @emdash-cms/admin@0.11.1
  - @emdash-cms/auth@0.11.1
  - @emdash-cms/gutenberg-to-portable-text@0.11.1
  - @emdash-cms/auth-atproto@0.2.4

## 0.11.0

### Minor Changes

- [#978](https://github.com/emdash-cms/emdash/pull/978) [`27e6d58`](https://github.com/emdash-cms/emdash/commit/27e6d58ec1ba547ece4736ac0a87309812a95681) Thanks [@ascorbic](https://github.com/ascorbic)! - Enforces the sandboxed plugin bundle size caps from RFC 0001 §"Bundle size limits" in both the `bundle` and `publish` CLI flows: total decompressed ≤ 256 KB, per-file decompressed ≤ 128 KB, and at most 20 files per bundle. The previous bundle command capped only the total at 5 MB; the publish command now also re-validates the decompressed tarball before signing the release record so a publisher hits the same cap locally that aggregators enforce at ingest. Bundles between 256 KB and the old 5 MB ceiling will now be rejected — usually a sign the plugin is bundling host-provided dependencies or assets that belong in a CDN rather than the plugin payload.

- [#942](https://github.com/emdash-cms/emdash/pull/942) [`7c536e5`](https://github.com/emdash-cms/emdash/commit/7c536e59b005a79925dd0ecab46404d9d34196b8) Thanks [@MA2153](https://github.com/MA2153)! - Adds per-field allowed MIME types for `file` and `image` fields. Field-level `allowedTypes` is now honored end-to-end: it filters the media picker, widens upload acceptance for that field (so e.g. a zip-only field can accept zip uploads even though the global allowlist excludes them), and validates referenced media against the destination field on content save. The schema editor in admin gains an "Allowed types" control with curated presets and freeform entry.

  Behavior change: the `image` builder's `allowedTypes` option was previously accepted but read by nothing. It is now load-bearing — a code-first schema that already passed `allowedTypes` (e.g. `["image/png"]`) will now actually narrow the picker and gate uploads. Most users will see no change; if you set this option intending the old (silent) behavior, drop it.

  Behavior change: updating a field via the admin schema editor now explicitly clears its validation when the form contains no validation settings, instead of leaving an existing `validation` value intact. This only affects fields with pre-existing validation that is not expressible in the editor UI.

### Patch Changes

- [#893](https://github.com/emdash-cms/emdash/pull/893) [`f8ee1ed`](https://github.com/emdash-cms/emdash/commit/f8ee1ed5e7b02b8905ebec82fb703e3061fe8161) Thanks [@j-liszt](https://github.com/j-liszt)! - Enhances Passkey authentication with polymorphic algorithm support. Adds support for RS256 (RSA) alongside the existing ES256 (ECDSA) implementation, ensuring full compatibility with Windows Hello, hardware security keys, and FIDO2 standards. Includes a database migration to track and persist credential algorithms for future-proof authentication.

  Note for standalone `@emdash-cms/auth` consumers: If your `credentials` table already exists, you must manually run `ALTER TABLE credentials ADD COLUMN algorithm INTEGER NOT NULL DEFAULT -7` to support this update. The `DEFAULT -7` value ensures that existing rows (which are all ES256) continue to work seamlessly without requiring any data backfill.

- [#976](https://github.com/emdash-cms/emdash/pull/976) [`4c11017`](https://github.com/emdash-cms/emdash/commit/4c11017b833e4c009562b6063fd1fe281639f168) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Fixes migration `016_api_tokens` failing with `table "_emdash_api_tokens" already exists` after a partially-applied previous attempt. If `up()` crashed mid-way (D1 subrequest limit, isolate cancellation, transient connection error), the migration record never got recorded and Kysely re-ran the migration from the top on the next request, blocking every subsequent boot. `up()` now uses `IF NOT EXISTS` on every CREATE so a retry skips already-applied steps and finishes the remainder. Resolves the "table already exists" error reported on fresh Cloudflare Workers + D1 deploys.

- [#939](https://github.com/emdash-cms/emdash/pull/939) [`f1d4c0b`](https://github.com/emdash-cms/emdash/commit/f1d4c0bfc475ef947f0f4f00d171ab226f89dc6c) Thanks [@schiste](https://github.com/schiste)! - Make the MCP menu write tools locale-aware by exposing `locale` on `menu_create`,
  `menu_update`, `menu_delete`, and `menu_set_items`, exposing `translationOf` on
  `menu_create`, and teaching `handleMenuSetItems()` to target the requested locale
  and tag inserted menu items with that menu's locale.

  All seven menu-name lookups (`handleMenuUpdate`, `handleMenuDelete`,
  `handleMenuSetItems`, `handleMenuItemCreate`, `handleMenuItemUpdate`,
  `handleMenuItemDelete`, `handleMenuItemReorder`) now fail loud with the new
  `AMBIGUOUS_LOCALE` error code (HTTP 400) when called with a `name` that exists
  in multiple locales and no `locale` is provided. Previously the lookup silently
  picked an arbitrary translation, which could rewrite or delete the wrong
  locale's menu on multi-locale installs. The error message lists the available
  locales so callers can recover. Single-locale installs and callers that already
  pass `locale` are unaffected.

  The `translationOf` → `locale` requirement is now enforced inside
  `handleMenuCreate` (returns `VALIDATION_ERROR`), so REST/SDK callers get the
  same guard the MCP boundary already provided.

- [`d273e9a`](https://github.com/emdash-cms/emdash/commit/d273e9a3d3dff6e356bc17dd3e22d294e9635b03) Thanks [@ascorbic](https://github.com/ascorbic)! - Refactors the plugin manifest types to re-export from `@emdash-cms/plugin-types`. The capability vocabulary (`PluginCapability`, `CAPABILITY_RENAMES`, `normalizeCapability`, `isDeprecatedCapability`) and manifest shape (`ManifestHookEntry`, `ManifestRouteEntry`, `PluginStorageConfig`, `StorageCollectionConfig`) now live in the shared package so the registry CLI can write the same types core reads. Existing imports from `emdash`'s plugin types module continue to work unchanged.

- [#943](https://github.com/emdash-cms/emdash/pull/943) [`514d32d`](https://github.com/emdash-cms/emdash/commit/514d32d97c11a56cd501f4a45a33524b31badd49) Thanks [@Rimander](https://github.com/Rimander)! - Fixes seed menu items losing their `translation_group` across export/apply by adding optional `id`, `locale`, and `translationOf` fields to `SeedMenuItem`. The export emits stable seed IDs and `translationOf` references; the apply resolves them to the anchor's `translation_group`, matching the existing pattern for content entries, taxonomies, and terms.

- [#948](https://github.com/emdash-cms/emdash/pull/948) [`8116949`](https://github.com/emdash-cms/emdash/commit/8116949935d7b713ebcb3858435c29e45c00c090) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds always-on `db.*` and `cache.*` Server-Timing fields so render-phase performance is diagnosable in production. Each request now emits `db.total` (cumulative DB ms), `db.count` (query count), `db.first` / `db.last` (first/last query offset from request start), and `cache.hit` / `cache.miss` (request-scoped cache stats). The Kysely log hook is now always installed so counters work without setting `EMDASH_QUERY_LOG`.

- [#946](https://github.com/emdash-cms/emdash/pull/946) [`c4ee7ad`](https://github.com/emdash-cms/emdash/commit/c4ee7ad838c5fcbc7939fe8102cd87d5d6856e68) Thanks [@LeanderG](https://github.com/LeanderG)! - Fixes Postgres rate-limit queries by quoting the reserved `window` column name.

- Updated dependencies [[`7f6b6ea`](https://github.com/emdash-cms/emdash/commit/7f6b6ead417f3b495843a4da5653531cf735aae4), [`131bea6`](https://github.com/emdash-cms/emdash/commit/131bea68b7f580e353716a1a1934f2a6fec3b3e7), [`f8ee1ed`](https://github.com/emdash-cms/emdash/commit/f8ee1ed5e7b02b8905ebec82fb703e3061fe8161), [`54b5aa1`](https://github.com/emdash-cms/emdash/commit/54b5aa1c189d7ebd8d34e02a9b3c3a560b5f263f), [`c630e31`](https://github.com/emdash-cms/emdash/commit/c630e31d1362a275c95324f4bbc1e92d0a4646cf), [`7c536e5`](https://github.com/emdash-cms/emdash/commit/7c536e59b005a79925dd0ecab46404d9d34196b8), [`7aa1897`](https://github.com/emdash-cms/emdash/commit/7aa189782946bb99397ea909cac50fc1109b27b9), [`943df46`](https://github.com/emdash-cms/emdash/commit/943df46d62043df386eef4664fbba4710be16c31), [`0b8a319`](https://github.com/emdash-cms/emdash/commit/0b8a319e7afb247b1ebacd60aeb6052bec5560d5), [`13ff061`](https://github.com/emdash-cms/emdash/commit/13ff061517ede4b29608de0120283914b43e6b76), [`49b66d9`](https://github.com/emdash-cms/emdash/commit/49b66d910c80b87b2632ad34e923695c9a302a05), [`1b2fa77`](https://github.com/emdash-cms/emdash/commit/1b2fa77d0c1455f9478908234f45e9d91847e044), [`530b013`](https://github.com/emdash-cms/emdash/commit/530b013000e0547bc01f252113cff77c1e26e485), [`af15975`](https://github.com/emdash-cms/emdash/commit/af15975b1c8daf6bdef216ac56693568d448a112), [`a4968c1`](https://github.com/emdash-cms/emdash/commit/a4968c105741ca008035d1f33e55851b52a7d2d6), [`f80fb58`](https://github.com/emdash-cms/emdash/commit/f80fb58ca5906d65e7f1a38d91267ce511d2bef2)]:
  - @emdash-cms/admin@0.11.0
  - @emdash-cms/auth@0.11.0
  - @emdash-cms/plugin-types@0.0.1
  - @emdash-cms/auth-atproto@0.2.3
  - @emdash-cms/gutenberg-to-portable-text@0.11.0

## 0.10.0

### Minor Changes

- [#916](https://github.com/emdash-cms/emdash/pull/916) [`71f4e7d`](https://github.com/emdash-cms/emdash/commit/71f4e7d85b2568dbadd9dc6ff26160789cb24e47) Thanks [@Rimander](https://github.com/Rimander)! - Adds i18n support to menus and taxonomies (categories, tags, custom
  definitions), mirroring the per-locale model already in place for content.
  Each row carries `locale` and `translation_group`; translations of the
  same menu/term/def share a `translation_group`. `_emdash_menu_items.reference_id`
  and `content_taxonomies.taxonomy_id` are remapped to store the referenced
  row's translation_group, so a single association survives content
  translations and is resolved against the active locale at runtime.
  - Runtime helpers (`getMenu`, `getTaxonomyTerms`, `getTerm`, `getEntryTerms`,
    `getAllTermsForEntries`, …) accept an optional `{ locale }` and honour the
    i18n fallback chain; when no locale is given they fall back to the
    request context and `defaultLocale`, matching `getEmDashCollection` /
    `getEmDashEntry`.
  - REST API: GET endpoints accept `?locale=xx`; POST endpoints accept
    `locale` and `translationOf` in their bodies. New endpoints:
    `GET/POST /_emdash/api/menus/:name/translations` and
    `GET/POST /_emdash/api/taxonomies/:name/terms/:slug/translations`.
  - Creating a content translation now auto-copies the source's taxonomy
    assignments (the pivot is locale-agnostic, so the copied rows apply to
    the whole translation group).
  - MCP: `taxonomy_list`, `taxonomy_list_terms`, `taxonomy_create_term`,
    `menu_list`, `menu_get` accept `locale`. New tools:
    `taxonomy_term_translations`, `menu_translations`.
  - Admin: `TaxonomyManager` and `MenuList` surface a `LocaleSwitcher` when
    multiple locales are configured and thread the active locale through
    all API calls. `TaxonomyManager` exposes a "Translate" action per term
    that creates the translation and switches to the new locale.

  No breaking changes for new installs or single-locale upgrades — defaults
  are additive (locale defaults to `'en'` when omitted, reproducing pre-i18n
  behaviour).

  > ⚠️ **Rolling back migration `036_i18n_menus_and_taxonomies` is blocked
  > on multi-locale installs.** Dropping the `locale` column would collapse
  > translated rows onto an ambiguous `(name, slug)` unique key, silently
  > deleting content. The migration's `down()` now refuses to run when any
  > row uses a non-default locale and prints the affected table in the
  > error. If you need to revert, export translations first (or delete
  > them), then re-run the rollback. Single-locale installs revert cleanly.

- [#902](https://github.com/emdash-cms/emdash/pull/902) [`7e32092`](https://github.com/emdash-cms/emdash/commit/7e32092596149ae2886bae34c8d2f4bad86dbe2f) Thanks [@ascorbic](https://github.com/ascorbic)! - `emdash plugin init` now prompts for the plugin format (sandboxed or native) when run interactively, and the scaffolded boilerplate matches the canonical patterns from the docs. Both formats now ship a `dist/` build via tsdown, declare a sample `storage` collection, and demonstrate a hook plus an API route. The sandboxed entry uses an explicitly typed `ContentSaveEvent`; the native entry forwards options through `createPlugin`. The descriptor `id` is now derived from the slug instead of the full scoped package name, so scoped names like `@org/my-plugin` produce a runtime-valid id. Pass `--format=sandboxed`, `--format=native`, or `--native` to skip the prompt; non-TTY runs continue to default to sandboxed.

### Patch Changes

- [#701](https://github.com/emdash-cms/emdash/pull/701) [`a2d3658`](https://github.com/emdash-cms/emdash/commit/a2d3658e510f292bf1fbe6b0a9e8e4f02ebc1e03) Thanks [@lsngmin](https://github.com/lsngmin)! - Fixes MediaValue.src returning bare media ID instead of a usable URL for local media

- [#912](https://github.com/emdash-cms/emdash/pull/912) [`c8a3a2c`](https://github.com/emdash-cms/emdash/commit/c8a3a2cce6bfdcdc6521556bcc507f88bd79ba31) Thanks [@lsngmin](https://github.com/lsngmin)! - Permanent-delete API now refuses to remove live (non-trashed) rows and uses a content-domain `content:delete_permanent` permission instead of the unrelated `import:execute`. Existing audience (ADMIN-only) is unchanged.

- [#896](https://github.com/emdash-cms/emdash/pull/896) [`699e1b3`](https://github.com/emdash-cms/emdash/commit/699e1b3d208a5ef4bca5dc3a40a39291e484f060) Thanks [@cristianuibar](https://github.com/cristianuibar)! - Fixes 500 error on `GET /_emdash/api/dashboard` when running on Cloudflare D1 with many title-bearing collections. `fetchRecentItems` now issues one query per collection in parallel and merges results in JS instead of building a single chained `UNION ALL`, which trips D1's `SQLITE_LIMIT_COMPOUND_SELECT` cap once enough collections are present (#895).

- [#719](https://github.com/emdash-cms/emdash/pull/719) [`2e2b8e9`](https://github.com/emdash-cms/emdash/commit/2e2b8e90c099f3422808f0e1da9c83a9ec533b64) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes the `file` field type rendering as a plain text input in the content editor. Adds a `FileFieldRenderer` that opens the media picker (with mime filter disabled) so any file type can be attached. Also adds a `hideUrlInput` prop to `MediaPickerModal` so non-image pickers can hide the image-specific "Insert from URL" input.

  Aligns the Zod schema and generated TypeScript types for `image` and `file` fields with the shape the admin actually stores: `provider?`, `meta?` (for both), and `previewUrl?` (for image). Previously these fields were stripped on validation and missing from generated types, so site code could not reliably resolve local media URLs from `meta.storageKey`.

- [#911](https://github.com/emdash-cms/emdash/pull/911) [`9146931`](https://github.com/emdash-cms/emdash/commit/91469312df211304d51576c9aef621148707b6d3) Thanks [@masonjames](https://github.com/masonjames)! - Fixes WordPress media URL rewriting for imported image URLs that use generated size suffixes.

- Updated dependencies [[`c8a3a2c`](https://github.com/emdash-cms/emdash/commit/c8a3a2cce6bfdcdc6521556bcc507f88bd79ba31), [`2e2b8e9`](https://github.com/emdash-cms/emdash/commit/2e2b8e90c099f3422808f0e1da9c83a9ec533b64)]:
  - @emdash-cms/auth@0.10.0
  - @emdash-cms/admin@0.10.0
  - @emdash-cms/auth-atproto@0.2.2
  - @emdash-cms/gutenberg-to-portable-text@0.10.0

## 0.9.0

### Minor Changes

- [#884](https://github.com/emdash-cms/emdash/pull/884) [`e2b3c6c`](https://github.com/emdash-cms/emdash/commit/e2b3c6cd930d5fa6fc607a0b26fd796f5b0f98b2) Thanks [@ascorbic](https://github.com/ascorbic)! - Removes the worker-isolate manifest cache and stops loading the manifest on public requests.

  The admin manifest (collection schemas, plugins, taxonomies) is built fresh from the live database on every admin request via constant-shape queries (`SchemaRegistry.listCollectionsWithFields()` — one collection query plus one batched field query, chunked at the D1 bound-parameter limit; two queries in practice for typical sites), deduplicated within a single request by `requestCached`. Logged-out / public requests no longer touch it at all — the global middleware no longer pre-loads `locals.emdashManifest`. Admin routes that need it call `await emdash.getManifest()`.

  This closes the cross-isolate staleness bug class behind #776, #873, #876, and #877 by elimination: there is no cache to invalidate, so there is nothing to fan out across warm sibling isolates on Cloudflare Workers, and there is nothing to leave stale after a fire-and-forget delete is cancelled at response-time.

  **Breaking changes**
  - `locals.emdash.invalidateManifest` is removed. The shim that survived earlier was a misnomer once the manifest cache itself was gone. Plugin code that called this after schema changes should switch to `locals.emdash.invalidateUrlPatternCache` (the only side effect that survived) — or drop the call entirely if the mutation didn't affect collection URL patterns (field/taxonomy/plugin mutations don't).
  - `locals.emdashManifest` is removed. Read it via `await locals.emdash.getManifest()` instead. The only in-tree consumers were the admin manifest endpoint and the WordPress importer routes, both updated.
  - `EmDashRuntime.invalidateManifest()` is removed. `EmDashRuntime.getManifest()` is preserved with the same signature; its body now skips the cache layer.

  **Performance**

  The admin manifest build is now O(1) query shapes (one for collections, one batched query for the fields of every returned collection, chunked at the D1 bound-parameter limit) instead of N+1. This is the cost the cache was hiding; the rebuild is cheap enough to run per request.

- [#731](https://github.com/emdash-cms/emdash/pull/731) [`9dfc65c`](https://github.com/emdash-cms/emdash/commit/9dfc65c42c04c41088e0c8f5a8ca4347643e2fea) Thanks [@drudge](https://github.com/drudge)! - Adds a `media_picker` Block Kit element: a thumbnail preview with a modal library picker and mime-type filter. Usable in plugin block forms and in Block Kit field widgets. The stored value is the selected asset's URL string, so it is value-compatible with a plain `text_input` — existing content continues to work after swapping. The `mime_type_filter` is restricted to image MIME types (`image/` or `image/<subtype>`); wildcards and non-image types are rejected.

- [#809](https://github.com/emdash-cms/emdash/pull/809) [`e7df21f`](https://github.com/emdash-cms/emdash/commit/e7df21f0adca795cdb233d6e64cd543ead7e2347) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds an optional `category` field to `PortableTextBlockConfig` for plugin-contributed block types. Plugins can now choose how their blocks are grouped in the admin slash menu (e.g. "Sections", "Marketing", "Media", "Layout") instead of always falling under "Embeds". Existing plugins that omit the field continue to render under "Embeds" exactly as before.

- [#890](https://github.com/emdash-cms/emdash/pull/890) [`8ae227c`](https://github.com/emdash-cms/emdash/commit/8ae227cceade5c9852897c7b56f89e7422ee82a1) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `publishedAt` to `content_publish` (MCP and REST) and exposes `seo`, `bylines`, and `publishedAt` on the MCP `content_update` tool.

  `content_publish` now accepts an optional ISO 8601 `publishedAt` to backdate a publish, which is useful when migrating content from another CMS or correcting a historical publish date. The override requires the `content:publish_any` permission. Without it, the existing `published_at` is preserved on re-publish (idempotent) and falls back to the current time on first publish.

  The MCP `content_update` tool previously dropped `seo`, `bylines`, and `publishedAt` even though the underlying handler accepted them. Callers had to fall back to raw SQL against `_emdash_seo` and `_emdash_content_bylines` to set these fields. They now flow through the MCP tool and are persisted in the same transaction as field updates. Setting `publishedAt` requires `content:publish_any`, mirroring the REST PUT route. Closes #621 and #622.

- [#800](https://github.com/emdash-cms/emdash/pull/800) [`e2d5d16`](https://github.com/emdash-cms/emdash/commit/e2d5d160acea4444945b1ea79c80ca9ce138965b) Thanks [@csfalcao](https://github.com/csfalcao)! - Adds support for accepting passkey assertions from multiple origins that share an `rpId`, for deployments reachable under several hostnames (apex + preview/staging) under one registrable parent. Declare additional origins via `EmDashConfig.allowedOrigins` (in `astro.config.mjs`) or the `EMDASH_ALLOWED_ORIGINS` env var (comma-separated); the two sources merge at runtime. EmDash validates the merged set against `siteUrl` and rejects dead config (non-subdomain entries, IP-literal `siteUrl`, trailing dots, empty labels) with source-attributed errors. `PasskeyConfig.origin: string` is replaced by `PasskeyConfig.origins: string[]`.

- [#837](https://github.com/emdash-cms/emdash/pull/837) [`e81aa0f`](https://github.com/emdash-cms/emdash/commit/e81aa0f717be11bacdff30ed9bbc454824268555) Thanks [@netogregorio](https://github.com/netogregorio)! - Make the preview URL pattern locale-aware. `getPreviewUrl()` now accepts a `{locale}` placeholder and a `locale` option (empty string collapses adjacent slashes so default-locale entries on `prefixDefaultLocale: false` sites stay unprefixed). The `POST /_emdash/api/content/{collection}/{id}/preview-url` route resolves the locale automatically from the entry and the site's i18n config, and reads a project-wide default pattern from the new `EMDASH_PREVIEW_PATH_PATTERN` env var so the admin's "View on site" link can match locale-prefixed routes (e.g. `/{locale}/{id}`).

- [#811](https://github.com/emdash-cms/emdash/pull/811) [`cee403d`](https://github.com/emdash-cms/emdash/commit/cee403d5c008feb9ca60bb7201e151b828737743) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds a centralized secrets module and `emdash secrets` CLI command group.
  The preview HMAC secret and commenter-IP hash salt are now generated and
  persisted in the options table on first need, with `EMDASH_PREVIEW_SECRET`
  and `EMDASH_IP_SALT` as optional env overrides. This replaces the previous
  empty-string preview fallback (which silently disabled token verification)
  and the hardcoded `"emdash-ip-salt"` constant (which was correlatable
  across installs).

  Adds:
  - `emdash secrets generate [--write <file> [--force]]` — emits a fresh
    `EMDASH_ENCRYPTION_KEY` (versioned `emdash_enc_v1_<43 chars>` format),
    optionally writes it to `.dev.vars` or `.env` idempotently.
  - `emdash secrets fingerprint <key>` — prints the kid (8-char fingerprint)
    for a key without exposing its value.

  Lays groundwork for plugin-secret encryption-at-rest in a follow-up.

  Deprecates:
  - `emdash auth secret` — kept as a working alias that prints a stderr
    deprecation note. Will be removed in a future minor. `EMDASH_AUTH_SECRET`
    itself is now legacy: it's only consulted as a fallback IP-salt source
    for upgrade compatibility (so existing installs keep stable
    commenter-IP hashes). New installs don't need to set it.

  API changes:
  - `fingerprintKey()` (exported from `emdash`'s config module) now
    validates its input and throws `EmDashSecretsError` for malformed or
    non-canonical keys, where it previously silently hashed any string.
    Callers that want the previous "fingerprint anything" behavior should
    hash the input themselves with `crypto.subtle.digest`.

  User-visible side effects on upgrade:
  - Installs that hadn't set `EMDASH_PREVIEW_SECRET` get a fresh random
    preview secret on first start, which invalidates any outstanding
    preview URLs (typically short-lived).
  - Installs that hadn't set `EMDASH_AUTH_SECRET` get a fresh random IP
    salt, resetting active comment rate-limit windows once.
  - Installs that did set `EMDASH_AUTH_SECRET` keep the same IP salt via a
    legacy fallback, so existing rate-limit data carries over.
  - If you sign preview URLs from a separate process without access to the
    EmDash database (e.g. a remote preview Worker), you must continue to
    set `EMDASH_PREVIEW_SECRET` in **both** processes. Processes that share
    the database converge on the same auto-generated value automatically;
    the env override is only needed when the verifying process can't read
    the options table.

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

### Patch Changes

- [#858](https://github.com/emdash-cms/emdash/pull/858) [`e0dc6fb`](https://github.com/emdash-cms/emdash/commit/e0dc6fb8adadc0e048f3f314d62bfa98d9bb48d4) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Adds CSS custom-property hooks to portable-text block defaults in `Image`, `Embed`, `Gallery`, and `Break` so host sites can theme figcaptions and horizontal rules without overriding component CSS. Resolution order is `--emdash-caption-color` → `--color-muted` → `#666` for captions, `--emdash-break-color` → `--color-border` → `#e0e0e0` for the break line, and `--emdash-break-dots-color` → `--color-muted` → `#999` for break dots. Backward compatible: sites that don't define any of these variables get the previous hex defaults; sites that already expose the conventional `--color-muted` / `--color-border` tokens (e.g. the blog template) now get correct dark-mode theming automatically.

- [#838](https://github.com/emdash-cms/emdash/pull/838) [`c22fb3a`](https://github.com/emdash-cms/emdash/commit/c22fb3a10d445f12cca91620c9258d50695afa44) Thanks [@ascorbic](https://github.com/ascorbic)! - Removes a redundant `SELECT id, author_id` lookup that fired after every collection-list and entry fetch when computing the byline-fallback for entries without explicit credits. The column is already on the row data, so it is now read directly. Saves up to one round-trip per list query and two on post-detail routes (~30 fewer queries across the perf-fixture suite).

- [#805](https://github.com/emdash-cms/emdash/pull/805) [`6a4e9b8`](https://github.com/emdash-cms/emdash/commit/6a4e9b8b0fa6064989224a42b14de435f487a76f) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes data loss in the visual-editing inline editor for plugin-contributed Portable Text block types. Previously, custom blocks like `marketing.hero` lost every field except `id` when the page was opened in edit mode, and the next save persisted the loss. Blocks now round-trip losslessly and render as a read-only placeholder labelled with the block type.

- [#702](https://github.com/emdash-cms/emdash/pull/702) [`0ee372a`](https://github.com/emdash-cms/emdash/commit/0ee372a7f33eecce7d90e12624923d2d9c132adf) Thanks [@ilicfilip](https://github.com/ilicfilip)! - Adds `@emdash-cms/plugin-field-kit` — composable field widgets for `json` fields. Four widgets (`object-form`, `list`, `grid`, `tags`) are configured entirely through seed `options` so site builders don't need to write React to get a usable editing UI. Widgets store clean JSON (no nesting, no mutation of shape), so removing the plugin leaves valid data in the database. See discussion #571 for background.

  Widens `FieldDescriptor.options` to `Array<{ value: string; label: string }> | Record<string, unknown>` so plugin widgets can accept arbitrary widget config (not only enum choices). The array shape for `select` / `multiSelect` continues to work unchanged.

- [#861](https://github.com/emdash-cms/emdash/pull/861) [`22a16ee`](https://github.com/emdash-cms/emdash/commit/22a16eed607a4e81391ecb6c45fe2e59aaca92fe) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Fixes "Cannot find module 'kysely'" at runtime after `astro build` followed by `astro preview` or `node dist/server/entry.mjs` on Node deployments using SQLite or libSQL (#741). The SQLite and libSQL dialect runtime modules used CJS `require("kysely")` and `require("better-sqlite3")`, ostensibly to defer loading at config time — though in practice these modules are only ever loaded at runtime via `virtual:emdash/dialect`, so the deferral served no purpose. Vite preserved those literal `require()` calls in the bundled SSR chunks; under pnpm's strict `node_modules` layout, Node's CJS resolver could not find `kysely` (a transitive dep of `emdash`) from the user's `dist/server/chunks/` directory. The dialect modules now use static imports — matching the existing `db/postgres.ts` adapter — so Vite resolves the deps correctly at build time.

- [#847](https://github.com/emdash-cms/emdash/pull/847) [`1e2b024`](https://github.com/emdash-cms/emdash/commit/1e2b02486ee0407e4f50b8342ba1a9e7d060e405) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes site favicon injection so user-configured favicons render on the public site, including SVG favicons in Chromium browsers (#831). `EmDashHead` now emits a `<link rel="icon">` tag with the correct `type` attribute (e.g. `image/svg+xml`) sourced from the stored media's MIME type. The bundled templates and demos have been updated to drop their per-template favicon link in favour of the centralized injection; existing user sites that still emit their own `<link rel="icon">` continue to work because browsers tolerate the duplicate.

  `MediaReference` now carries `url`, `contentType`, `width`, and `height` when resolved via `resolveMediaReference`, so callers can emit correct head tags without a second round-trip to the media table.

- [#851](https://github.com/emdash-cms/emdash/pull/851) [`81662e9`](https://github.com/emdash-cms/emdash/commit/81662e98fcf1ad0ee880d4f1af96271c527d7423) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Fixes admin branding (logo, siteName, favicon) configured via the integration's `admin` option not being delivered to the React admin SPA. The `/_emdash/api/manifest` route now reads admin branding from the per-request config plumbed through middleware (the same source `admin.astro` already used), instead of a build-time global that was never assigned.

- [#857](https://github.com/emdash-cms/emdash/pull/857) [`2f22f57`](https://github.com/emdash-cms/emdash/commit/2f22f57abadf305cf6d3ce07ee78290178e032d1) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Fixes a migration race on D1 where two concurrent Workers isolates could both try to apply the same migration, causing one to fail with `UNIQUE constraint failed: _emdash_migrations.name`. The losing isolate would throw before reaching auto-seed, leaving the manifest cache empty and the admin UI reporting collections as not found while the API reported them correctly. `runMigrations` now treats this specific error as benign, waits for the concurrent migrator to finish, and verifies the schema is fully migrated before returning success. Closes #762.

- [#856](https://github.com/emdash-cms/emdash/pull/856) [`ef3f076`](https://github.com/emdash-cms/emdash/commit/ef3f076c8112e9dffc2a87c019e5521e823f5e86) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Fixes `npm install` peer dependency conflicts (#819) by removing `@tanstack/react-query` and `@tanstack/react-router` from `peerDependencies`. These libraries are internal implementation details of the bundled admin UI (`@emdash-cms/admin`) and consuming Astro apps don't import them directly. Listing them as peers of `emdash` was forcing every npm-based install to install and resolve them at the top level, which produced ERESOLVE errors and bloat. The admin package continues to declare them as its own runtime dependencies.

- [#817](https://github.com/emdash-cms/emdash/pull/817) [`a9c29ea`](https://github.com/emdash-cms/emdash/commit/a9c29ea584300f6cf67206bedcb1d39f05ea1c26) Thanks [@all3f0r1](https://github.com/all3f0r1)! - Fixes redirect middleware so 301/302 rules from `_emdash_redirects` actually fire for unauthenticated visitors. Previously, the lookup was silently skipped on the public-visitor branch because `locals.emdash.db` is intentionally omitted there — only logged-in admins, edit-mode sessions and preview tokens ever saw redirects (so WordPress migration 301s, manual rewrites and `Auto: slug change` rows did nothing for real traffic, and `hits` / `_emdash_404_log` stayed at zero). The middleware now falls back to `getDb()` (ALS-aware) when `locals.emdash.db` is absent. Resolves #808.

- [#874](https://github.com/emdash-cms/emdash/pull/874) [`d5f7c48`](https://github.com/emdash-cms/emdash/commit/d5f7c481a507868f470361cfd715a5828640d45a) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Fixes `EmDashRuntime.invalidateManifest()` leaving the persisted manifest cache row stale on Cloudflare Workers. The D1 row delete was a fire-and-forget promise — on Workers, unawaited work is cancelled when the isolate is torn down post-response, so `options.emdash:manifest_cache` was almost never actually wiped after a schema mutation. Cold-starting isolates downstream then adopted the pre-mutation snapshot and served `Collection '<slug>' not found` until something else cleared the row. The delete now goes through `after()`, which hands it to `ctx.waitUntil` under workerd. (#873)

- [#839](https://github.com/emdash-cms/emdash/pull/839) [`0d98c62`](https://github.com/emdash-cms/emdash/commit/0d98c620a5f407648f3b7f3cbd30b642c74be607) Thanks [@ascorbic](https://github.com/ascorbic)! - Caches the `site:*` settings prefix-scan across requests within a worker isolate. Site settings change rarely; reading them once per route was wasted work. Writes via `setSiteSettings()` invalidate the cache so other isolates pick up changes within their lifetime.

- [#840](https://github.com/emdash-cms/emdash/pull/840) [`64bf5b9`](https://github.com/emdash-cms/emdash/commit/64bf5b98125ca18ec26f7e0e65a71fcbe71fd44f) Thanks [@ascorbic](https://github.com/ascorbic)! - Reduces duplicate queries on pages that render multiple taxonomy or "recent posts" widgets. `getTaxonomyDef(name)` now reuses the full taxonomy-defs list when it has already been loaded in the same request, and `getEmDashCollection` buckets small limits so a post-detail page asking for 4 posts in the body and 5 in a sidebar widget shares one fetch instead of two. Cuts ~6 queries from the perf-fixture post-detail render.

- [#803](https://github.com/emdash-cms/emdash/pull/803) [`0041d76`](https://github.com/emdash-cms/emdash/commit/0041d7699b32b77b4cd2ecd77b97340f0dd3abce) Thanks [@mvanhorn](https://github.com/mvanhorn)! - Fixes migrations 034 and 035 so they can safely re-run when a previous attempt left the schema partially applied without recording it in `_emdash_migrations`. Resolves the "index already exists" error reported on upgrade from 0.1.1 to 0.6.0+.

- [#869](https://github.com/emdash-cms/emdash/pull/869) [`a8bac5d`](https://github.com/emdash-cms/emdash/commit/a8bac5d7216e185b1bd9a2aaaeaa9a0306ab066e) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Fixes autosave validation errors on content seeded from the blog,
  portfolio, and starter templates (issue #867).

  Two related issues:
  - `_key` was strictly required on Portable Text blocks by the
    generated Zod schema, but the rest of the block schema is
    `.passthrough()` and the editor regenerates `_key` on every change,
    so requiring it on input rejected legitimate seed/import data
    without protecting any real invariant. `_key` is now optional in the
    validator.
  - The portfolio template shipped `featured_image` as bare URL strings.
    `image` fields validate as `{ id, ... }` objects, so any user who
    edited a different field on a portfolio entry hit
    `featured_image: expected object, received string`. The portfolio
    seeds now use `$media` references in the same shape as the blog
    template, and every shipped template seed has stable `_key`s on its
    Portable Text nodes.

  A regression test runs every shipped template seed through the same
  validator the autosave endpoint uses, so future template changes that
  break this invariant fail before release.

- [#882](https://github.com/emdash-cms/emdash/pull/882) [`5b6f059`](https://github.com/emdash-cms/emdash/commit/5b6f059d06175ae0cb740d1ba32867d1ec6b2249) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes the seed virtual module to also look at the conventional `seed/seed.json` path when no `.emdash/seed.json` or `package.json#emdash.seed` pointer is configured. Without this fallback, a site that only had `seed/seed.json` would silently fall through to the built-in default seed -- the setup wizard would not offer demo content, and the wrong schema would be applied. The loader now warns when it falls through to the default seed so misconfiguration is loud during dev.

- [#855](https://github.com/emdash-cms/emdash/pull/855) [`a86ff80`](https://github.com/emdash-cms/emdash/commit/a86ff80836fed175508ff06f744c7ad6b805627c) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Fixes Astro session lookups firing on every anonymous public SSR request (#733). The middleware now skips `context.session.get("user")` when no `astro-session` cookie is present, which on Cloudflare Workers (where the Astro session backend is KV) was turning normal anonymous traffic into a flood of KV read misses. Logged-in editors, admin routes, edit/preview flows, and any request that actually carries the session cookie continue to read the session as before.

- [#853](https://github.com/emdash-cms/emdash/pull/853) [`eb6dbd0`](https://github.com/emdash-cms/emdash/commit/eb6dbd056717fd076a8b5fa807d91516a00f5f2f) Thanks [@drudge](https://github.com/drudge)! - Fixes content saves on collections with boolean fields. Boolean fields map to `INTEGER` columns and the repository writes booleans as `0/1`, but never converts them back on read, so a GET → edit → POST round-trip surfaced numbers where the per-collection zod schema expected booleans, and every save was rejected. The boolean field schema now coerces the `0/1` shape to real booleans at the validation boundary; other numbers and strings still fail validation as before.

- Updated dependencies [[`9dfc65c`](https://github.com/emdash-cms/emdash/commit/9dfc65c42c04c41088e0c8f5a8ca4347643e2fea), [`d6754ae`](https://github.com/emdash-cms/emdash/commit/d6754ae7746b0f9035d2c5e390ece7199762b094), [`0ee372a`](https://github.com/emdash-cms/emdash/commit/0ee372a7f33eecce7d90e12624923d2d9c132adf), [`ef3f076`](https://github.com/emdash-cms/emdash/commit/ef3f076c8112e9dffc2a87c019e5521e823f5e86), [`8d0feb3`](https://github.com/emdash-cms/emdash/commit/8d0feb3eece62b01075260bbb79188984a8631b8), [`8354088`](https://github.com/emdash-cms/emdash/commit/83540887936a87a6c99230b21d2afe3fe424218c), [`254a443`](https://github.com/emdash-cms/emdash/commit/254a443684ec3bddfc2706b349d6ccce901987af), [`25128b2`](https://github.com/emdash-cms/emdash/commit/25128b2444853e3301af7ff09d21a3f5883a599f), [`e7df21f`](https://github.com/emdash-cms/emdash/commit/e7df21f0adca795cdb233d6e64cd543ead7e2347), [`ab45916`](https://github.com/emdash-cms/emdash/commit/ab45916e8561678ccddf7d6184a7d56729ea03cc), [`0913a39`](https://github.com/emdash-cms/emdash/commit/0913a39a23538c96bfa62fe7da37bf332d18bb46), [`e2d5d16`](https://github.com/emdash-cms/emdash/commit/e2d5d160acea4444945b1ea79c80ca9ce138965b), [`a838000`](https://github.com/emdash-cms/emdash/commit/a83800068678daf6391e02bba8acf27ff4db0e19), [`ddbf808`](https://github.com/emdash-cms/emdash/commit/ddbf8088e1bcfa07d6347a953bb1995295e8f8fd), [`1c958fb`](https://github.com/emdash-cms/emdash/commit/1c958fb484387cd8cce7fab53ff4eddfe0dbb7f6), [`491aeec`](https://github.com/emdash-cms/emdash/commit/491aeec5a66e2f764eb9d8ed8425e9d402ada4a7), [`d4be24f`](https://github.com/emdash-cms/emdash/commit/d4be24f478a0c8d0a7bba3c299e11105bba3ed94)]:
  - @emdash-cms/admin@0.9.0
  - @emdash-cms/auth@0.9.0
  - @emdash-cms/auth-atproto@0.2.1
  - @emdash-cms/gutenberg-to-portable-text@0.9.0

## 0.8.0

### Minor Changes

- [#679](https://github.com/emdash-cms/emdash/pull/679) [`493e317`](https://github.com/emdash-cms/emdash/commit/493e3172d4539d8e041e6d2bf2d7d2dc89b2a10d) Thanks [@drudge](https://github.com/drudge)! - Adds a `repeater` Block Kit element: array-of-objects with scalar sub-fields, drag-to-reorder, and collapsible item cards. Plugin block forms can now capture repeating data (FAQ rows, carousel slides, card grids) inline in the portable-text editor.

- [#779](https://github.com/emdash-cms/emdash/pull/779) [`e402890`](https://github.com/emdash-cms/emdash/commit/e402890fcd8647fdfe847bb34aa9f9e7094473dd) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `settings_get` and `settings_update` MCP tools so agents can read and update site-wide settings (title, tagline, logo, favicon, URL, posts-per-page, date format, timezone, social, SEO). `settings_get` resolves media references (logo/favicon/seo.defaultOgImage) to URLs; `settings_update` is a partial update that preserves omitted fields. New `settings:read` (EDITOR+) and `settings:manage` (ADMIN) API token scopes back the tools, with matching options in the personal API token settings UI.

- [#777](https://github.com/emdash-cms/emdash/pull/777) [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd) Thanks [@ascorbic](https://github.com/ascorbic)! - **Behavior change** — MCP `taxonomy_list_terms` now uses an opaque base64 keyset cursor over `(label, id)` instead of the previous raw term-id cursor. The new cursor is robust to concurrent term deletion: it encodes a position in sort space rather than a reference to a specific row. **MCP clients that persisted page cursors across this upgrade should drop them and restart pagination** — pre-upgrade cursors will return `INVALID_CURSOR`.

  Adds parent-chain validation to `taxonomy_create_term` (previously only `taxonomy_update_term` validated): rejects non-existent parents, cross-taxonomy parents, self-parent on update, cycles on update, and parent chains exceeding 100 ancestors. Existing taxonomies with chains over the depth limit continue to function but cannot accept new descendants until the chain is shortened.

- [#675](https://github.com/emdash-cms/emdash/pull/675) [`b6cb2e6`](https://github.com/emdash-cms/emdash/commit/b6cb2e6c7001d37a0558e22953eba41013457528) Thanks [@eyupcanakman](https://github.com/eyupcanakman)! - Renders local media through storage `publicUrl` when configured. `EmDashImage` and the Portable Text image block now call a new `locals.emdash.getPublicMediaUrl()` helper, so R2 and S3 deployments with a custom domain serve images from that domain. `S3Storage.getPublicUrl` now returns the `/_emdash/api/media/file/{key}` path when no `publicUrl` is set (previously `{endpoint}/{bucket}/{key}`).

- [#398](https://github.com/emdash-cms/emdash/pull/398) [`31333dc`](https://github.com/emdash-cms/emdash/commit/31333dc593e2b9128113e4e923455209f11853fd) Thanks [@simnaut](https://github.com/simnaut)! - Adds pluggable auth provider system with AT Protocol as the first plugin-based provider. Refactors GitHub and Google OAuth from hardcoded buttons into the same `AuthProviderDescriptor` interface. All auth methods (passkey, AT Protocol, GitHub, Google) are equal options on the login page and setup wizard.

### Patch Changes

- [#777](https://github.com/emdash-cms/emdash/pull/777) [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes MCP ownership checks failing with an internal error on content that has no `authorId` (seed-imported rows). Admins and editors can now edit, publish, unpublish, schedule, and restore such items; users with only own-content permissions get a clean permission error.

- [#777](https://github.com/emdash-cms/emdash/pull/777) [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes content create / update silently accepting invalid data: required fields are now enforced, select / multiSelect values must match the configured options, and reference fields must resolve to a real, non-trashed target. Errors surface with a structured `VALIDATION_ERROR` code and a message naming every offending field.

- [#670](https://github.com/emdash-cms/emdash/pull/670) [`37ada52`](https://github.com/emdash-cms/emdash/commit/37ada52a62e94f4f0581f4356ba55dc978863f49) Thanks [@segmentationfaulter](https://github.com/segmentationfaulter)! - Change text direction of input fields and tiptap editor depending upon the language entered

- [#688](https://github.com/emdash-cms/emdash/pull/688) [`0557b62`](https://github.com/emdash-cms/emdash/commit/0557b62ec646e49eeb5e28686d50b4e8746338be) Thanks [@corwinperdomo](https://github.com/corwinperdomo)! - Fixes the Settings > Email admin page so active `email:beforeSend` / `email:afterSend` middleware plugins are listed (previously always empty). Adds `HookPipeline.getHookProviders()` for enumerating non-exclusive hook providers.

- [#673](https://github.com/emdash-cms/emdash/pull/673) [`5a581d9`](https://github.com/emdash-cms/emdash/commit/5a581d966cc1da72637a76ad42a7ac3b81ec59c3) Thanks [@mvanhorn](https://github.com/mvanhorn)! - Fixes WordPress media import to emit relative `/_emdash/api/media/file/...` URLs instead of absolute ones, matching every other media endpoint. Imported media is now recognized by `INTERNAL_MEDIA_PREFIX` for enrichment, and no longer pins URLs to the origin that happened to serve the import request (breaking renders on a different port or behind a reverse proxy).

- [#750](https://github.com/emdash-cms/emdash/pull/750) [`0ecd3b4`](https://github.com/emdash-cms/emdash/commit/0ecd3b4901eb721825b36eb4812506032e43da14) Thanks [@edrpls](https://github.com/edrpls)! - Make the admin collection list column headers sortable. `Title`, `Status`, `Locale`, and `Date` are now clickable buttons that toggle direction; the current sort state is exposed via `aria-sort` on the `<th>` so screen readers announce it correctly.

  The server's `orderBy` field whitelist now accepts `status`, `locale`, and `name` alongside the existing date fields — unchanged from a security standpoint, the repo still rejects unknown field names to prevent column enumeration.

  Callers of `<ContentList>` that don't pass `onSortChange` render the previous static-label headers, so legacy integrations (e.g. the content picker) are unaffected.

- [`3138432`](https://github.com/emdash-cms/emdash/commit/31384322537070db8c35e4f93f4ffe8225d784d6) Thanks [@r2sake](https://github.com/r2sake)! - Fixes hydration of the inline PortableText editor on pnpm projects by aliasing `use-sync-external-store/shim` to the main `use-sync-external-store` package. The shim is a CJS-only React<18 polyfill imported transitively by `@tiptap/react`; under pnpm's virtual store Vite cannot pre-bundle it, and the browser receives raw `module.exports` which fails to load as ESM (`SyntaxError: ... does not provide an export named 'useSyncExternalStore'`). The aliases redirect to React's built-in `useSyncExternalStore` (peer-dep floor is React 18), so users no longer need to add the workaround themselves in `astro.config.mjs`.

- [#755](https://github.com/emdash-cms/emdash/pull/755) [`70924cd`](https://github.com/emdash-cms/emdash/commit/70924cd19b4227b3a1ecfad6618f1a80530a378b) Thanks [@mvanhorn](https://github.com/mvanhorn)! - Fixes the WordPress importer so collections created mid-import are visible to the subsequent execute phase.

  `POST /_emdash/api/import/wordpress/prepare` now calls `emdash.invalidateManifest()` when it creates new collections or fields. Without this, the DB-persisted manifest cache (`emdash:manifest_cache` in the `options` table) stays stale and the `execute` request reports `Collection "<slug>" does not exist` for every item destined for a freshly created collection — a bug that survived dev-server restarts and required manually deleting the cache row.

- [#757](https://github.com/emdash-cms/emdash/pull/757) [`1f0f6f2`](https://github.com/emdash-cms/emdash/commit/1f0f6f2507d026f2b5c60c254432bfc327b3474f) Thanks [@ascorbic](https://github.com/ascorbic)! - Removes two redundant in-scope database queries from the FTS verify-and-repair path. The inner block re-fetched searchable fields and search config that were already loaded in the outer scope of the same method. No behavior change.

- [#777](https://github.com/emdash-cms/emdash/pull/777) [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes paginated list endpoints silently returning the first page when given a malformed cursor. Bad cursors now produce a structured `INVALID_CURSOR` error so client pagination bugs surface immediately.

  **Note for plugin authors:** the low-level `decodeCursor` export from `emdash/database/repositories` now throws `InvalidCursorError` on invalid input instead of returning `null`. Direct callers (rare — most code uses `findMany`-style helpers that handle this internally) should wrap the call in `try`/`catch` or migrate to the higher-level helpers.

- [#777](https://github.com/emdash-cms/emdash/pull/777) [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes `schema_create_collection` MCP tool to apply its documented default of `['drafts', 'revisions']` for `supports` when omitted.

- [#189](https://github.com/emdash-cms/emdash/pull/189) [`f5658f0`](https://github.com/emdash-cms/emdash/commit/f5658f052f7294039f7ea8c5eb8b49af263beb0d) Thanks [@Sayeem3051](https://github.com/Sayeem3051)! - Add url and email plugin setting field types (Issue #175)

- [#777](https://github.com/emdash-cms/emdash/pull/777) [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd) Thanks [@ascorbic](https://github.com/ascorbic)! - Preserves structured error codes through MCP tool responses. Errors returned by MCP tools now include a stable `[CODE]` prefix in the message text and a `_meta.code` field on the response envelope, so MCP clients can distinguish failure modes (e.g. NOT_FOUND, CONFLICT, VALIDATION_ERROR) instead of seeing only a generic message.

- [#777](https://github.com/emdash-cms/emdash/pull/777) [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes `revision_restore` for collections that support revisions: restore now creates a new draft revision from the source revision's data and updates `draft_revision_id`, leaving the live columns untouched. Previously, restore overwrote the live row directly and left any pending draft unchanged, opposite to the documented contract ("Replaces the current draft..."). The response is also hydrated so the returned `data` reflects the post-restore state.

  Behavior is unchanged for collections that do not support revisions.

- [#734](https://github.com/emdash-cms/emdash/pull/734) [`cf1edae`](https://github.com/emdash-cms/emdash/commit/cf1edae6ac3e5cd8c72fd43a09bb80bae5cc8031) Thanks [@huckabarry](https://github.com/huckabarry)! - Preserve clearer error logging and run sandboxed `after()` content hook tasks in parallel when deferred plugin hooks execute after save and publish.

- [#794](https://github.com/emdash-cms/emdash/pull/794) [`b352e88`](https://github.com/emdash-cms/emdash/commit/b352e881fedb7f6fdc35f9d75402f67caba7f154) Thanks [@ascorbic](https://github.com/ascorbic)! - Sanitises the `snippet` field returned by the `search()` API so it is safe to render with `set:html` / `innerHTML`. Previously SQLite's FTS5 `snippet()` function spliced literal `<mark>` tags around matched terms but left the surrounding text unescaped, meaning a post title like `Hello <script>alert(1)</script>` would render as live markup. Templates and components rendering snippets directly were exposed; the in-tree `LiveSearch` component already worked around this client-side. Snippets now contain only HTML-escaped source text plus literal `<mark>...</mark>` highlight tags, matching the documented contract.

- [#183](https://github.com/emdash-cms/emdash/pull/183) [`da3d065`](https://github.com/emdash-cms/emdash/commit/da3d0656a4431365176cca65dc2bedf5eca19ce3) Thanks [@masonjames](https://github.com/masonjames)! - Fixes Astro dev to use the built admin package for external app installs while keeping source aliasing for local monorepo development.

- [#777](https://github.com/emdash-cms/emdash/pull/777) [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd) Thanks [@ascorbic](https://github.com/ascorbic)! - Tightens conflict-error matchers in `handleContentCreate` and `handleContentUpdate`. Both paths now match specifically on `"unique constraint failed"` or `"duplicate key"` (avoiding false positives where the word "unique" appears in unrelated error text), and produce sanitized `SLUG_CONFLICT` / `CONFLICT` messages so raw database error text — including Postgres-internal index names — no longer leaks to API consumers. Clients that pattern-match the previous unsanitized messages will see normalized text instead.

- [#777](https://github.com/emdash-cms/emdash/pull/777) [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes `taxonomy_list` exposing collection slugs for collections that no longer exist. Orphaned slugs are filtered out so the response stays consistent with `schema_list_collections`.

- [#777](https://github.com/emdash-cms/emdash/pull/777) [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes `content_unpublish` so that `publishedAt` is cleared when an item is unpublished.

- [#608](https://github.com/emdash-cms/emdash/pull/608) [`47978b5`](https://github.com/emdash-cms/emdash/commit/47978b5e1b69b671d2ea5c08ee0bbf4c72d1594d) Thanks [@drudge](https://github.com/drudge)! - Fixes `/_emdash/api/widget-areas/*` endpoints returning raw DB rows (snake_case fields, `content` as a JSON string) instead of the transformed `Widget` shape. Admin UI expects `content` to already be a parsed PortableText array and `componentId`/`componentProps`/`menuName` in camelCase, so expanding a content widget in `/_emdash/admin/widgets` produced an empty editor. All four route handlers (`GET /widget-areas`, `GET /widget-areas/:name`, `POST /widget-areas/:name/widgets`, `PUT /widget-areas/:name/widgets/:id`) now run their results through `rowToWidget`, which was made module-exported.

- [#777](https://github.com/emdash-cms/emdash/pull/777) [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `taxonomies:manage` and `menus:manage` API token scopes for fine-grained control over taxonomy and menu mutations via MCP and REST. Existing tokens with `content:write` continue to work for those operations: `content:write` now implicitly grants `menus:manage` and `taxonomies:manage` so PATs issued before the split keep their effective permissions. The reverse implication does not hold — a token with only `menus:manage` cannot create or edit content.

- Updated dependencies [[`86b26f6`](https://github.com/emdash-cms/emdash/commit/86b26f6c1067efb28d8f7cb447be23da99d2e38e), [`493e317`](https://github.com/emdash-cms/emdash/commit/493e3172d4539d8e041e6d2bf2d7d2dc89b2a10d), [`e998083`](https://github.com/emdash-cms/emdash/commit/e998083115b3c5a6e27707a940dfac557ea72458), [`37ada52`](https://github.com/emdash-cms/emdash/commit/37ada52a62e94f4f0581f4356ba55dc978863f49), [`acab807`](https://github.com/emdash-cms/emdash/commit/acab8071e72a29751a55e923473cd4749e34fefd), [`0ecd3b4`](https://github.com/emdash-cms/emdash/commit/0ecd3b4901eb721825b36eb4812506032e43da14), [`4c9f04d`](https://github.com/emdash-cms/emdash/commit/4c9f04d9506a9a79cec2425ccb71785a6948843a), [`e402890`](https://github.com/emdash-cms/emdash/commit/e402890fcd8647fdfe847bb34aa9f9e7094473dd), [`ed4d880`](https://github.com/emdash-cms/emdash/commit/ed4d88057e9b26d497181655eecf3e06e12a1001), [`31333dc`](https://github.com/emdash-cms/emdash/commit/31333dc593e2b9128113e4e923455209f11853fd), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd)]:
  - @emdash-cms/admin@1.0.0
  - @emdash-cms/auth@1.0.0
  - @emdash-cms/auth-atproto@1.0.0
  - @emdash-cms/gutenberg-to-portable-text@1.0.0

## 0.7.0

### Minor Changes

- [#705](https://github.com/emdash-cms/emdash/pull/705) [`8ebdf1a`](https://github.com/emdash-cms/emdash/commit/8ebdf1af65764cc4b72624e7758c4a666817aade) Thanks [@eba8](https://github.com/eba8)! - Adds admin white-labeling support via `admin` config in `astro.config.mjs`. Agencies can set a custom logo, site name, and favicon for the admin panel, separate from public site settings.

- [#742](https://github.com/emdash-cms/emdash/pull/742) [`c26442b`](https://github.com/emdash-cms/emdash/commit/c26442be9887f1e3d3df37db5ccda6b260820a77) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `trustedProxyHeaders` config option so self-hosted deployments behind a reverse proxy can declare which client-IP headers to trust. Used by auth rate limits (magic-link, signup, passkey, OAuth device flow) and the public comment endpoint — without it, every request on a non-Cloudflare deployment was treated as "unknown" and rate limits were effectively disabled.

  Set the option in `astro.config.mjs`:

  ```js
  emdash({
  	trustedProxyHeaders: ["x-real-ip"], // nginx, Caddy, Traefik
  });
  ```

  or via the `EMDASH_TRUSTED_PROXY_HEADERS` env var (comma-separated). Headers are tried in order; values ending in `forwarded-for` are parsed as comma-separated lists.

  Also removes the user-agent-hash fallback on the comment endpoint. The fallback was meant to give anonymous commenters on non-Cloudflare deployments something approximating per-user rate limiting, but the UA is trivially rotatable; requests with no trusted IP now share a stricter "unknown" bucket. Operators behind a reverse proxy should set `trustedProxyHeaders` to restore per-IP bucketing.

  **Only set `trustedProxyHeaders` when you control the reverse proxy.** Trusting a forwarded-IP header from the open internet lets any client spoof their IP and defeats rate limiting.

### Patch Changes

- [#745](https://github.com/emdash-cms/emdash/pull/745) [`7186961`](https://github.com/emdash-cms/emdash/commit/7186961d3cbf706c1248e9e40b14b1a545ce8586) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes an unauthenticated denial-of-service via the 404 log. Every 404 response previously inserted a new row into `_emdash_404_log`, so an attacker could grow the database without bound by requesting unique nonexistent URLs. Repeat hits to the same path now dedup into a single row with a `hits` counter and `last_seen_at` timestamp, referrer and user-agent headers are truncated to bounded lengths, and the log is capped at 10,000 rows with oldest-first eviction.

- [#739](https://github.com/emdash-cms/emdash/pull/739) [`e9ecec2`](https://github.com/emdash-cms/emdash/commit/e9ecec2d2dfb20ab4c413fb593a09a9f6d0fb27e) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Fixes the REST content API silently stripping `publishedAt` on create/update and `createdAt` on create. Importers can now preserve original publish and creation dates on migrated content. Gated behind `content:publish_any` (EDITOR+) so regular contributors cannot backdate posts. `createdAt` is intentionally not accepted on update — `created_at` is treated as immutable.

- [#732](https://github.com/emdash-cms/emdash/pull/732) [`e3e18aa`](https://github.com/emdash-cms/emdash/commit/e3e18aae92d31cf22efd11a0ba06110de24a076a) Thanks [@jcheese1](https://github.com/jcheese1)! - Fixes select dropdown appearing behind dialog by removing explicit z-index values and adding `isolate` to the admin body for proper stacking context.

- [#695](https://github.com/emdash-cms/emdash/pull/695) [`fae63bd`](https://github.com/emdash-cms/emdash/commit/fae63bdae8ff798a420379c36d3d05e54ea3628a) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes `emdash seed` so entries declared with `"status": "published"` are actually published. Previously the seed wrote the content row with `status: "published"` and a `published_at` timestamp but never created a live revision, so the admin UI showed "Save & Publish" instead of "Unpublish" and `live_revision_id` stayed null. The seed now promotes published entries to a live revision on both create and update paths.

- [#744](https://github.com/emdash-cms/emdash/pull/744) [`30d8fe0`](https://github.com/emdash-cms/emdash/commit/30d8fe00025e058c71c8bfcd296946bb2042c4a7) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes a setup-window admin hijack by binding `/setup/admin` and `/setup/admin/verify` to a per-session nonce cookie. Previously an unauthenticated attacker who could reach a site during first-time setup could POST to `/setup/admin` between the legitimate admin's email submission and passkey verification, overwriting the stored email — the admin account would then be created with the attacker's address. The admin route now mints a cryptographically random nonce, stores it in setup state, and sets it as an HttpOnly, SameSite=Strict, `/_emdash/`-scoped cookie; the verify route rejects any request whose cookie does not match in constant time.

- [#685](https://github.com/emdash-cms/emdash/pull/685) [`d4a95bf`](https://github.com/emdash-cms/emdash/commit/d4a95bf313855e97108dfec4de3ab35f1a85f8ba) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes visual editing: clicking an editable field now opens the inline editor instead of always opening the admin in a new tab. The toolbar's manifest fetch was reading `manifest.collections` directly but the `/_emdash/api/manifest` endpoint wraps its payload in `{ data: … }`, so every field-kind lookup returned `null` and every click fell through to the admin-new-tab fallback.

- [#743](https://github.com/emdash-cms/emdash/pull/743) [`a31db7d`](https://github.com/emdash-cms/emdash/commit/a31db7dcc6d9ddb09328eec815d255a4976ce3b8) Thanks [@ascorbic](https://github.com/ascorbic)! - Locks `emdash:site_url` after the first setup call so a spoofed Host header on a later step of the wizard can't overwrite it. Config (`siteUrl`) and env (`EMDASH_SITE_URL`) paths already took precedence; this is a defence-in-depth guard for deployments that rely on the request-origin fallback.

- [#737](https://github.com/emdash-cms/emdash/pull/737) [`adb118c`](https://github.com/emdash-cms/emdash/commit/adb118c99d867be7b17714798e1e565ccdf096e4) Thanks [@ascorbic](https://github.com/ascorbic)! - Rate-limits the self-signup request endpoint to prevent abuse. `POST /_emdash/api/auth/signup/request` now allows 3 requests per 5 minutes per IP, matching the existing limit on magic-link/send. Over-limit requests return the same generic success response as allowed-but-ignored requests, so the limit isn't observable to callers.

- [#738](https://github.com/emdash-cms/emdash/pull/738) [`080a4f1`](https://github.com/emdash-cms/emdash/commit/080a4f1efdd793cddd49767d8b18cd53162f39e3) Thanks [@ascorbic](https://github.com/ascorbic)! - Strengthens SSRF protection on the import pipeline against DNS-rebinding. The `validateExternalUrl` helper now also blocks known wildcard DNS services (`nip.io`, `sslip.io`, `xip.io`, `traefik.me`, `lvh.me`, `localtest.me`) and trailing-dot FQDN forms of blocked hostnames. A new `resolveAndValidateExternalUrl` resolves the target hostname via DNS-over-HTTPS (Cloudflare) and rejects if any returned IP is in a private range. `ssrfSafeFetch` and the plugin unrestricted-fetch path now use the DNS-aware validator on every hop. This adds two DoH round-trips per outbound request; self-hosted admins whose egress blocks `cloudflare-dns.com` can inject a custom resolver via `setDefaultDnsResolver`.

- [#736](https://github.com/emdash-cms/emdash/pull/736) [`81fe93b`](https://github.com/emdash-cms/emdash/commit/81fe93bc675581ddd0161eaabbe7a3471ec76529) Thanks [@ascorbic](https://github.com/ascorbic)! - Restricts Subscriber-role access to draft, scheduled, and trashed content. Subscribers retain `content:read` for member-only published content but no longer see non-published items via the REST API or MCP server. Adds a new `content:read_drafts` permission (Contributor and above) that gates `/compare`, `/revisions`, `/trash`, `/preview-url`, and the corresponding MCP tools.

- Updated dependencies [[`8ebdf1a`](https://github.com/emdash-cms/emdash/commit/8ebdf1af65764cc4b72624e7758c4a666817aade), [`2e4b205`](https://github.com/emdash-cms/emdash/commit/2e4b205b1df30bdb6bb96259f223b85610de5e78), [`e3e18aa`](https://github.com/emdash-cms/emdash/commit/e3e18aae92d31cf22efd11a0ba06110de24a076a), [`743b080`](https://github.com/emdash-cms/emdash/commit/743b0807f1a37fdedbcd37632058b557f493f3be), [`fa8d753`](https://github.com/emdash-cms/emdash/commit/fa8d7533e8ba7e02599372d580399dae88ecd891), [`81fe93b`](https://github.com/emdash-cms/emdash/commit/81fe93bc675581ddd0161eaabbe7a3471ec76529)]:
  - @emdash-cms/admin@0.7.0
  - @emdash-cms/auth@0.7.0
  - @emdash-cms/gutenberg-to-portable-text@0.7.0

## 0.6.0

### Minor Changes

- [#626](https://github.com/emdash-cms/emdash/pull/626) [`1859347`](https://github.com/emdash-cms/emdash/commit/18593475bb8e30ce1aab55d72903d02dbf3fd0cb) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds eager hydration of taxonomy terms on `getEmDashCollection` and `getEmDashEntry` results. Each entry now exposes a `data.terms` field keyed by taxonomy name (e.g. `post.data.terms.tag`, `post.data.terms.category`), populated via a single batched JOIN query alongside byline hydration. Templates that previously looped and called `getEntryTerms(collection, id, taxonomy)` per entry can read `entry.data.terms` directly and skip the N+1 round-trip.

  New exports: `getAllTermsForEntries`, `invalidateTermCache`.

  Reserved field slugs now also block `terms`, `bylines`, and `byline` at schema-creation time to prevent new fields shadowing the hydrated values. Existing installs that already have a user-defined field with any of those slugs will see the hydrated value overwrite the stored value on read (consistent with the pre-existing behavior of `bylines` / `byline` hydration); rename the field to keep its data accessible.

- [#600](https://github.com/emdash-cms/emdash/pull/600) [`9295cc1`](https://github.com/emdash-cms/emdash/commit/9295cc199f72c9b9adff236e4a72ba412604493f) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds Noto Sans as the default admin UI font via the Astro Font API. Fonts are downloaded from Google at build time and self-hosted. The base font covers Latin, Cyrillic, Greek, Devanagari, and Vietnamese. Additional scripts (Arabic, CJK, Hebrew, Thai, etc.) can be added via the new `fonts.scripts` config option. Set `fonts: false` to disable and use system fonts.

### Patch Changes

- [#648](https://github.com/emdash-cms/emdash/pull/648) [`ada4ac7`](https://github.com/emdash-cms/emdash/commit/ada4ac7105f72a96eaf4ce3d884d705d8aba0119) Thanks [@CacheMeOwside](https://github.com/CacheMeOwside)! - Adds the missing `url` field type for seed files, content type builder, and content editor with client-side URL validation.

- [#658](https://github.com/emdash-cms/emdash/pull/658) [`f279320`](https://github.com/emdash-cms/emdash/commit/f279320ef49c68662c8936db15e21f46cb57e82b) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `after(fn)` — a helper for deferring bookkeeping work past the HTTP response. On Cloudflare it hands off to `waitUntil` (extending the worker's lifetime); on Node it fire-and-forgets (the event loop keeps the process alive for the next request anyway). Host binding is plumbed through a new `virtual:emdash/wait-until` virtual module so core stays runtime-neutral — Cloudflare-specific imports live in the integration layer, not in request-handling code.

  First use: cron stale-lock recovery (`_emdash_cron_tasks` UPDATE) now runs after the response ships instead of blocking it. On D1 this shaves a primary-routed write off the cold-start critical path.

  Usage:

  ```ts
  import { after } from "emdash";

  // Fire-and-forget; errors are caught and logged so a deferred task
  // never surfaces as an unhandled rejection.
  after(async () => {
  	await recordAuditEntry();
  });
  ```

- [#642](https://github.com/emdash-cms/emdash/pull/642) [`7f75193`](https://github.com/emdash-cms/emdash/commit/7f75193df49967c871acdf47a22f0e48d2e98986) Thanks [@Pouf5](https://github.com/Pouf5)! - Adds `maxUploadSize` config option to set the maximum media file upload size in bytes. Defaults to 52_428_800 (50 MB) — existing behaviour is unchanged.

- [#595](https://github.com/emdash-cms/emdash/pull/595) [`cfd01f3`](https://github.com/emdash-cms/emdash/commit/cfd01f3bd484b38549a5a164ad006279a2024788) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes playground initialization crash caused by syncSearchState attempting first-time FTS enablement during field creation.

- [#663](https://github.com/emdash-cms/emdash/pull/663) [`38d637b`](https://github.com/emdash-cms/emdash/commit/38d637b520f8596758939ec08a7b534bb9550967) Thanks [@ascorbic](https://github.com/ascorbic)! - Cache `getSiteSetting(key)` per-request. It was firing an uncached `options` table read on every call, so templates that pull several settings (or `EmDashHead` reading `seo` on every page render) paid N round-trips to the D1 primary instead of sharing one. Noticeable on colos far from the primary — APS/APE were seeing ~30–100 ms of avoidable warm-render latency per page.

  Wraps each key in `requestCached("siteSetting:${key}", ...)` so concurrent callers in a single render share the in-flight query.

- [#631](https://github.com/emdash-cms/emdash/pull/631) [`31d2f4e`](https://github.com/emdash-cms/emdash/commit/31d2f4edd5e84391e23f2eb6ff833e2fd4e51077) Thanks [@ascorbic](https://github.com/ascorbic)! - Improves cold-start performance for anonymous page requests. Sites with D1 replicas far from the worker colo should see the biggest improvement; on the blog-demo the homepage cold request on Asia colos dropped from several seconds to under a second.

  Three underlying changes:
  - Search index health checks run on demand (on the first search request) rather than at worker boot, reclaiming the time a boot-time scan spent walking every searchable collection.
  - Module-scoped caches (manifest, taxonomy names, byline existence, taxonomy-assignment existence) are now reused across anonymous requests that route through D1 read replicas. They previously rebuilt on every request.
  - Cold-start Server-Timing headers break runtime init into sub-phases (`rt.db`, `rt.plugins`, etc.) so further regressions are easier to diagnose.

- [#605](https://github.com/emdash-cms/emdash/pull/605) [`445b3bf`](https://github.com/emdash-cms/emdash/commit/445b3bfecf1f4cdc109be865685eb6ae6e0c06e6) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes D1 read replicas being bypassed for anonymous public page traffic. The middleware fast path now asks the database adapter for a per-request scoped Kysely, so anonymous reads land on the nearest replica instead of the primary-pinned singleton binding.

  All D1-specific semantics (Sessions API, constraint selection, bookmark cookie) live in `@emdash-cms/cloudflare/db/d1` behind a single `createRequestScopedDb(opts)` function. Core middleware has no D1-specific logic. Adapters opt in via a new `supportsRequestScope: boolean` flag on `DatabaseDescriptor`; `d1()` sets it to true.

  Other fixes in the same change:
  - Nested `runWithContext` calls in the request-context middleware now merge the parent context instead of replacing it, so an outer per-request db override is preserved through edit/preview flows.
  - Baseline security headers now forward Astro's cookie symbol across the response clone so `cookies.set()` calls in middleware survive.
  - Any write (authenticated or anonymous) now forces `first-primary`, so an anonymous form/comment POST isn't racing across replicas.
  - The session user is read once per request and reused in both the fast path and the full runtime init (previously read twice on authenticated public-page traffic).
  - Bookmark cookies are validated only for length (≤1024) and absence of control characters — no stricter shape check, so a future D1 bookmark format change won't silently degrade consistency.
  - The `!config` bail-out now still applies baseline security headers.
  - `__ec_d1_bookmark` references aligned to `__em_d1_bookmark` across runtime, docs, and JSDoc.

- [#654](https://github.com/emdash-cms/emdash/pull/654) [`943d540`](https://github.com/emdash-cms/emdash/commit/943d54060eb6675dda643b09f7cdb80bbbe5d566) Thanks [@ascorbic](https://github.com/ascorbic)! - Dedups repeat DB queries within a single page render. Measured against the query-count fixture:
  - The "has any bylines / has any taxonomy terms" probes were module-scoped singletons, but the bundler duplicates those modules across chunks — each chunk ended up with its own copy of the singleton, so the probe re-ran whenever a different chunk called the helper. Stored on `globalThis` with a Symbol key (same pattern as `request-context.ts`), so a single value is shared across all chunks now.
  - Wraps `getCollectionInfo`, `getTaxonomyDef`, `getTaxonomyTerms`, and `getEmDashCollection` in the request-scoped cache so two callers with the same arguments in the same render share a single query.

  Biggest wins land on pages that render multiple content-heavy components (a post detail page with comments, byline credits, and sidebar widgets). On the fixture post page: -3 queries cold / -1 warm under SQLite, -2 queries cold under D1.

- [#668](https://github.com/emdash-cms/emdash/pull/668) [`2cb3165`](https://github.com/emdash-cms/emdash/commit/2cb31658037bc2b9ebfd3c5b82e4fb709b4a1fad) Thanks [@CacheMeOwside](https://github.com/CacheMeOwside)! - Fixes boolean field checkbox displaying as unchecked after publish in the admin UI.

- [#500](https://github.com/emdash-cms/emdash/pull/500) [`14c923b`](https://github.com/emdash-cms/emdash/commit/14c923b5eaf23f6e601cd2559ce9fc3af2f40822) Thanks [@all3f0r1](https://github.com/all3f0r1)! - Adds inline term creation in the post editor taxonomy sidebar. Tags show a "Create" option when no match exists; categories get an "Add new" button below the list.

- [#606](https://github.com/emdash-cms/emdash/pull/606) [`c5ef0f5`](https://github.com/emdash-cms/emdash/commit/c5ef0f5befda129e4040822ee341f8cd8bb5acaf) Thanks [@ascorbic](https://github.com/ascorbic)! - Caches the manifest in memory and in the database to eliminate N+1 schema queries per request. Batches site info queries during initialization. Cold starts read 1 cached row instead of rebuilding from scratch.

- [#671](https://github.com/emdash-cms/emdash/pull/671) [`f839381`](https://github.com/emdash-cms/emdash/commit/f8393819e74b31c269ba6c5088eab1f40b438c62) Thanks [@jcheese1](https://github.com/jcheese1)! - Fixes MCP OAuth discovery and dynamic client registration so EmDash only advertises supported client registration mechanisms and rejects unsupported redirect URIs or token endpoint auth methods during client registration. Also exempts OAuth protocol endpoints (token, register, device code, device token) from the Origin-based CSRF check, since these endpoints are called cross-origin by design (MCP clients, CLIs, native apps) and carry no ambient credentials, and sends the required CORS headers so browser-based MCP clients can reach them.

- [#664](https://github.com/emdash-cms/emdash/pull/664) [`002d0ac`](https://github.com/emdash-cms/emdash/commit/002d0accd87fc0b6983a3a45fd11227398837366) Thanks [@ascorbic](https://github.com/ascorbic)! - `getSiteSetting(key)` now transparently piggybacks on `getSiteSettings()` when the batch has already been loaded in the current request. If a parent template has called `getSiteSettings()` (which is request-cached), a later `getSiteSetting("seo")` — from `EmDashHead`, a plugin, or user code — reads the key from that cached result instead of firing its own round-trip. Falls back to a per-key cached query when nothing has been primed.

  Exposes `peekRequestCache(key)` for internal use by other helpers that want the same "read from a broader cached query if available" pattern.

  On the blog-demo fixture: the SEO call added in PR #613 now costs zero extra queries per page (it reads from the Base layout's existing `getSiteSettings()` result).

- [#465](https://github.com/emdash-cms/emdash/pull/465) [`0a61ef4`](https://github.com/emdash-cms/emdash/commit/0a61ef412ef8d2643fa847caeddbe8b8933d3fc7) Thanks [@Pouf5](https://github.com/Pouf5)! - Fixes FTS5 tables not being created when a searchable collection is created or updated via the Admin UI.

- [#636](https://github.com/emdash-cms/emdash/pull/636) [`6d41fe1`](https://github.com/emdash-cms/emdash/commit/6d41fe16539d09c53916b4ca41c515a29f8e0d4f) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes two correctness issues from the #631 cold-start work:
  - `ensureSearchHealthy()` now runs against the runtime's singleton database instead of the per-request session-bound one. The verify step reads, but a corrupted index triggers a rebuild write, and D1 Sessions on a GET request uses `first-unconstrained` routing that's free to land on a replica. The singleton goes through the default binding, which the adapter correctly promotes to `first-primary` for writes.
  - The playground request-context middleware now sets `dbIsIsolated: true`. Without it, schema-derived caches (manifest, taxonomy defs, byline/term existence probes) could carry values across playground sessions that have independent schemas.

- [#627](https://github.com/emdash-cms/emdash/pull/627) [`b158e40`](https://github.com/emdash-cms/emdash/commit/b158e40de596e8ca3cb056495276ec97403c24d9) Thanks [@ascorbic](https://github.com/ascorbic)! - Prime the request-scoped cache for `getEntryTerms` during collection and entry hydration. `getEmDashCollection` and `getEmDashEntry` already fetch taxonomy terms for their results via a single batched JOIN; now the same data is seeded into the per-request cache under the same keys `getEntryTerms` uses, so existing templates that still call `getEntryTerms(collection, id, taxonomy)` in a loop get cache hits instead of a serial DB round-trip per iteration.

  Empty-result entries are seeded with `[]` for every taxonomy that applies to the collection so "this post has no tags" also short-circuits without a query. Cache entries are scoped to the request context via ALS and GC'd with it.

- [#653](https://github.com/emdash-cms/emdash/pull/653) [`f97d6ab`](https://github.com/emdash-cms/emdash/commit/f97d6ab0f1995fe86862aeb20de65d0ee774699f) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds opt-in query instrumentation for performance regression testing. Setting `EMDASH_QUERY_LOG=1` causes the Kysely log hook to emit `[emdash-query-log]`-prefixed NDJSON on stdout for every DB query executed inside a request, tagged with the route, method, and an `X-Perf-Phase` header value. Zero runtime overhead when the flag is unset — the log option is only attached to Kysely when enabled.

  Also exposes the helpers at `emdash/database/instrumentation` so first-party adapters (e.g. `@emdash-cms/cloudflare`) can wire the same hook into their per-request Kysely instances.

- [#613](https://github.com/emdash-cms/emdash/pull/613) [`e67b940`](https://github.com/emdash-cms/emdash/commit/e67b94056c21c716eada0fff7350b8592c6a3c68) Thanks [@nickgraynews](https://github.com/nickgraynews)! - Fixes site SEO settings `googleVerification` and `bingVerification` not being emitted into `<head>`. The fields were stored in the database and editable in the admin UI but were never rendered as `<meta name="google-site-verification">` or `<meta name="msvalidate.01">` tags, making meta-tag verification with Google Search Console and Bing Webmaster Tools impossible. EmDashHead now loads site SEO settings and renders these tags on every page.

- [#659](https://github.com/emdash-cms/emdash/pull/659) [`0896ec8`](https://github.com/emdash-cms/emdash/commit/0896ec81065da7fa9b93053d366500805602c8fe) Thanks [@ascorbic](https://github.com/ascorbic)! - Two query-count reductions on the request hot path:
  - **Widget areas now fetch in a single query.** `getWidgetArea(name)` used to do two round-trips — one for the area, one for its widgets. Single left-join now. Saves one query per `<WidgetArea>` rendered on a page.
  - **Dropped the "has any bylines / has any term assignments" probes.** Those fired on every hydration call to save a single query on sites with zero bylines/terms — exactly the wrong tradeoff. The batch hydration queries already handle empty sites at the same cost, so the probes are removed. Pre-migration databases (tables not created yet) are still handled via an `isMissingTableError` catch. Saves two queries per render on pages that hydrate bylines and taxonomy terms.

  On the fixture post-detail page: SQLite `/posts/[slug]` drops from 34 → 32, D1 from 43 → 39. The widget-area JOIN shaves one off every page that renders a widget area.

  `invalidateBylineCache()` and `invalidateTermCache()` are preserved as no-op exports so callers don't break.

- [#558](https://github.com/emdash-cms/emdash/pull/558) [`629fe1d`](https://github.com/emdash-cms/emdash/commit/629fe1dd3094a0178c57529a455a2be805b08ad0) Thanks [@csfalcao](https://github.com/csfalcao)! - Fixes `/_emdash/api/search/suggest` 500 error. `getSuggestions` no longer double-appends the FTS5 prefix operator `*` on top of the one `escapeQuery` already adds, so autocomplete queries like `?q=des` now return results instead of raising `SqliteError: fts5: syntax error near "*"`.

- [#552](https://github.com/emdash-cms/emdash/pull/552) [`f52154d`](https://github.com/emdash-cms/emdash/commit/f52154da8afb838b1af6deccf33b5a261257ec7c) Thanks [@masonjames](https://github.com/masonjames)! - Fixes passkey login failures so unregistered or invalid credentials return an authentication failure instead of an internal server error.

- [#601](https://github.com/emdash-cms/emdash/pull/601) [`8221c2a`](https://github.com/emdash-cms/emdash/commit/8221c2a3a37353b550f1c2c4a188bc4e2725b914) Thanks [@CacheMeOwside](https://github.com/CacheMeOwside)! - Fixes the Save Changes button on the Content Type editor failing silently with a 400 error

- [#598](https://github.com/emdash-cms/emdash/pull/598) [`8fb93eb`](https://github.com/emdash-cms/emdash/commit/8fb93eb045eb529eafd83e451ec673106f5bdb3c) Thanks [@maikunari](https://github.com/maikunari)! - Fixes WordPress import error reporting to surface the real exception message instead of a generic "Failed to import item" string, making import failures diagnosable.

- [#629](https://github.com/emdash-cms/emdash/pull/629) [`6d7f288`](https://github.com/emdash-cms/emdash/commit/6d7f288d812b554988742c36ef7a74be67386e6d) Thanks [@CacheMeOwside](https://github.com/CacheMeOwside)! - Adds toast feedback when taxonomy assignments are saved or fail on content items.

- [#638](https://github.com/emdash-cms/emdash/pull/638) [`4ffa141`](https://github.com/emdash-cms/emdash/commit/4ffa141c00ec7b9785bbb86f9292055e46b22a61) Thanks [@auggernaut](https://github.com/auggernaut)! - Fixes repeated FTS startup rebuilds on SQLite by verifying indexed row counts against the FTS shadow table.

- [#582](https://github.com/emdash-cms/emdash/pull/582) [`04e6cca`](https://github.com/emdash-cms/emdash/commit/04e6ccaa939f184edf4129eea0edf8ac5185d018) Thanks [@all3f0r1](https://github.com/all3f0r1)! - Improves the "Failed to create database" error to detect NODE_MODULE_VERSION mismatches from better-sqlite3 and surface an actionable message telling the user to rebuild the native module.

- Updated dependencies [[`dfcb0cd`](https://github.com/emdash-cms/emdash/commit/dfcb0cd4ed65d10212d47622b51a22b0eacf8acb), [`cf63b02`](https://github.com/emdash-cms/emdash/commit/cf63b0298576d062641cf88f37d6e7e86e4ddb3a), [`0b32b2f`](https://github.com/emdash-cms/emdash/commit/0b32b2f3906bf5bfed313044af6371480d43edc1), [`913cb62`](https://github.com/emdash-cms/emdash/commit/913cb6239510f9959581cb74a70faa53a462a9aa), [`6c92d58`](https://github.com/emdash-cms/emdash/commit/6c92d58767dc92548136a87cc90c1c6912da6695), [`a2d5afb`](https://github.com/emdash-cms/emdash/commit/a2d5afbb19b5bcaf98464d354322fa737a8b9ba0), [`39d285e`](https://github.com/emdash-cms/emdash/commit/39d285ea3d21b7b6277a554ae9cff011500655e1), [`f52154d`](https://github.com/emdash-cms/emdash/commit/f52154da8afb838b1af6deccf33b5a261257ec7c)]:
  - @emdash-cms/admin@0.6.0
  - @emdash-cms/auth@0.6.0
  - @emdash-cms/gutenberg-to-portable-text@0.6.0

## 0.5.0

### Minor Changes

- [#540](https://github.com/emdash-cms/emdash/pull/540) [`82c6345`](https://github.com/emdash-cms/emdash/commit/82c63451ff05ddc0a8e2777c124907358814da2b) Thanks [@jdevalk](https://github.com/jdevalk)! - Adds `where: { status?, locale? }` to `ContentListOptions`, letting plugins narrow `ContentAccess.list()` results at the database layer instead of filtering the returned array. The underlying repository already supports these filters — this PR only exposes them through the plugin-facing type.

- [#551](https://github.com/emdash-cms/emdash/pull/551) [`598026c`](https://github.com/emdash-cms/emdash/commit/598026c99083325c281b9e7ab87e9724e11f2c8d) Thanks [@ophirbucai](https://github.com/ophirbucai)! - Adds RTL (right-to-left) language support infrastructure. Enables proper text direction for RTL languages like Arabic, Hebrew, Farsi, and Urdu. Includes LocaleDirectionProvider component that syncs HTML dir/lang attributes with Kumo's DirectionProvider for automatic layout mirroring when locale changes.

### Patch Changes

- [#542](https://github.com/emdash-cms/emdash/pull/542) [`64f90d1`](https://github.com/emdash-cms/emdash/commit/64f90d1957af646ca200b9d70e856fa72393f001) Thanks [@mohamedmostafa58](https://github.com/mohamedmostafa58)! - Fixes invite flow: corrects invite URL to point to admin UI page, adds InviteAcceptPage for passkey registration.

- [#555](https://github.com/emdash-cms/emdash/pull/555) [`197bc1b`](https://github.com/emdash-cms/emdash/commit/197bc1bdcb16012138a95b46a1e31530bde8c5ab) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes OAuth authorization server metadata discovery for MCP clients by serving it at the RFC 8414-compliant path.

- [#534](https://github.com/emdash-cms/emdash/pull/534) [`ce873f8`](https://github.com/emdash-cms/emdash/commit/ce873f8fa618aa175598726a60230b4c36d37e2e) Thanks [@ttmx](https://github.com/ttmx)! - Fixes Table block to render inline marks (bold, italic, code, links, etc.) through the Portable Text pipeline instead of stripping them to plain text. Links are sanitized via `sanitizeHref()`. Table styles now use CSS custom properties with fallbacks.

- Updated dependencies [[`9ea4cf7`](https://github.com/emdash-cms/emdash/commit/9ea4cf7c63cd5a1c45ec569bd72076c935066a1c), [`64f90d1`](https://github.com/emdash-cms/emdash/commit/64f90d1957af646ca200b9d70e856fa72393f001), [`598026c`](https://github.com/emdash-cms/emdash/commit/598026c99083325c281b9e7ab87e9724e11f2c8d)]:
  - @emdash-cms/admin@0.5.0
  - @emdash-cms/auth@0.5.0
  - @emdash-cms/gutenberg-to-portable-text@0.5.0

## 0.4.0

### Minor Changes

- [#539](https://github.com/emdash-cms/emdash/pull/539) [`8ed7969`](https://github.com/emdash-cms/emdash/commit/8ed7969df2c95790d7c635ef043df20bb21b6156) Thanks [@jdevalk](https://github.com/jdevalk)! - Adds `locale` to the `ContentItem` type returned by the plugin content access API. Follow-up to #536 — plugins that build i18n URLs from content records need the locale to pick the right URL prefix, otherwise multilingual content is emitted at default-locale URLs.

- [#523](https://github.com/emdash-cms/emdash/pull/523) [`5d9120e`](https://github.com/emdash-cms/emdash/commit/5d9120eca846dd7c446d05f1b9c14fe1b7e394ec) Thanks [@jdevalk](https://github.com/jdevalk)! - Add `nlweb` to the allowed `rel` values for `page:metadata` link contributions, letting plugins inject `<link rel="nlweb" href="...">` tags for agent/conversational endpoint discovery.

- [#536](https://github.com/emdash-cms/emdash/pull/536) [`9318c56`](https://github.com/emdash-cms/emdash/commit/9318c5684fb293f167cd3e6f9e9a3ca12f042d7b) Thanks [@ttmx](https://github.com/ttmx)! - Adds `slug`, `status`, and `publishedAt` to the `ContentItem` type returned by the plugin content access API. Exports `ContentPublishStateChangeEvent` type. Fires `afterDelete` hooks on permanent content deletion.

- [#519](https://github.com/emdash-cms/emdash/pull/519) [`5c0776d`](https://github.com/emdash-cms/emdash/commit/5c0776deee7005ba580fc7dc8f778e805ab82cef) Thanks [@ascorbic](https://github.com/ascorbic)! - Enables the MCP server endpoint by default. The endpoint at `/_emdash/api/mcp` requires bearer token auth, so it has no effect unless a client is configured. Set `mcp: false` to disable.

  Fixes MCP server crash ("exports is not defined") on Cloudflare in dev mode by pre-bundling the MCP SDK's CJS dependencies for workerd.

### Patch Changes

- [#515](https://github.com/emdash-cms/emdash/pull/515) [`5beddc3`](https://github.com/emdash-cms/emdash/commit/5beddc31785aa7de086b2b22a2a9612f9d1c8aaf) Thanks [@ascorbic](https://github.com/ascorbic)! - Reduces logged-out page load queries by caching byline existence, URL patterns, and redirect rules at worker level with proper invalidation.

- [#512](https://github.com/emdash-cms/emdash/pull/512) [`f866c9c`](https://github.com/emdash-cms/emdash/commit/f866c9cc0dd1ac62035ef3e06bbe8d8d7d1c44a0) Thanks [@mahesh-projects](https://github.com/mahesh-projects)! - Fixes save/publish race condition in visual editor toolbar. When a user blurred a field and immediately clicked Publish, the in-flight save PUT could arrive at the server after the publish POST, causing the stale revision to be promoted silently. Introduces `pendingSavePromise` so `publish()` chains onto the pending save rather than firing immediately.

- [#537](https://github.com/emdash-cms/emdash/pull/537) [`1acf174`](https://github.com/emdash-cms/emdash/commit/1acf1743e7116a5f00b11536306ebb55edbf3b2e) Thanks [@Glacier-Luo](https://github.com/Glacier-Luo)! - Fixes plugin bundle resolving dist path before source, which caused build failures and potential workspace-wide source file destruction.

- [#538](https://github.com/emdash-cms/emdash/pull/538) [`678cc8c`](https://github.com/emdash-cms/emdash/commit/678cc8c4c34a23e8a7aeda652b0ec87070983b07) Thanks [@Glacier-Luo](https://github.com/Glacier-Luo)! - Fixes revision pruning crash on PostgreSQL by replacing column alias in HAVING clause with the aggregate expression.

- [#509](https://github.com/emdash-cms/emdash/pull/509) [`d56f6c1`](https://github.com/emdash-cms/emdash/commit/d56f6c1d2a688eee46e96a1dbe2d8c894ffc7095) Thanks [@mvanhorn](https://github.com/mvanhorn)! - Fixes TypeError when setting baseline security headers on Cloudflare responses with immutable headers.

- [#495](https://github.com/emdash-cms/emdash/pull/495) [`2a7c68a`](https://github.com/emdash-cms/emdash/commit/2a7c68a9f6c88216eb3f599b942b63fec8e1ae31) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes atomicity gaps: content update \_rev check, menu reorder, byline delete, and seed content creation now run inside transactions.

- [#497](https://github.com/emdash-cms/emdash/pull/497) [`6492ea2`](https://github.com/emdash-cms/emdash/commit/6492ea202c5872132c952678862eb6f564c78b7c) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes migration 011 rollback, plugin media upload returning wrong ID, MCP taxonomy tools bypassing validation, and FTS query escaping logic.

- [#517](https://github.com/emdash-cms/emdash/pull/517) [`b382357`](https://github.com/emdash-cms/emdash/commit/b38235702fd075d95c04b2a6874804ca45baa721) Thanks [@ascorbic](https://github.com/ascorbic)! - Improves plugin safety: hooks log dependency cycles, timeouts clear timers, routes don't leak error internals, one-shot cron tasks retry with exponential backoff (max 5), marketplace downloads validate redirect targets.

- [#532](https://github.com/emdash-cms/emdash/pull/532) [`1b743ac`](https://github.com/emdash-cms/emdash/commit/1b743acc35750dc36de4acdd95164c34cd7d092f) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes cold-start query explosion (159 -> ~25 queries) by short-circuiting migrations when all are applied, fixing FTS triggers to exclude soft-deleted content, and preventing false-positive FTS index rebuilds on every startup.

- Updated dependencies [[`3a96aa7`](https://github.com/emdash-cms/emdash/commit/3a96aa7f5671f6c718ab066e02c61fb55b33d901), [`c869df2`](https://github.com/emdash-cms/emdash/commit/c869df2b08decae6dc9c85bdfca83cc6577203cf), [`10ebfe1`](https://github.com/emdash-cms/emdash/commit/10ebfe19b81feacfe99cfaf2daf4976eaac17bd4), [`275a21c`](https://github.com/emdash-cms/emdash/commit/275a21c389c121cbac6daa6be497ae3b6c1bfc6d), [`af0647c`](https://github.com/emdash-cms/emdash/commit/af0647c7352922ad63077613771150d8178263ed), [`b89e7f3`](https://github.com/emdash-cms/emdash/commit/b89e7f3811488ebe8fbe28068baa18f7f25844ad), [`20b03b4`](https://github.com/emdash-cms/emdash/commit/20b03b480156a5c901298a1ab9c968c800179215), [`ba0a5af`](https://github.com/emdash-cms/emdash/commit/ba0a5afccf110465b72916e23db4ff975d81bc2e), [`e2f96aa`](https://github.com/emdash-cms/emdash/commit/e2f96aa74bd936832a3a4d0636e81f948adb51c7), [`4645103`](https://github.com/emdash-cms/emdash/commit/4645103f06ae9481b07dba14af07ac0ff57e32cf)]:
  - @emdash-cms/admin@0.4.0
  - @emdash-cms/auth@0.4.0
  - @emdash-cms/gutenberg-to-portable-text@0.4.0

## 0.3.0

### Minor Changes

- [#457](https://github.com/emdash-cms/emdash/pull/457) [`f2b3973`](https://github.com/emdash-cms/emdash/commit/f2b39739c13cbef86ed16be007f08abf86b0f9ca) Thanks [@UpperM](https://github.com/UpperM)! - Adds runtime resolution of S3 storage config from `S3_*` environment
  variables (`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `S3_PUBLIC_URL`). Any field omitted from
  `s3({...})` is read from the matching env var on Node at runtime, so
  container images can be built once and receive credentials at boot without a
  rebuild. Explicit values in `s3({...})` still take precedence.

  `s3()` with no arguments is now valid for fully env-driven deployments.
  `accessKeyId` and `secretAccessKey` are now optional in `S3StorageConfig`
  (both or neither). Workers users should continue passing explicit values to
  `s3({...})`.

### Patch Changes

- [#492](https://github.com/emdash-cms/emdash/pull/492) [`13f5ff5`](https://github.com/emdash-cms/emdash/commit/13f5ff57ffbe89e330d55b3c9c25a1907bf94394) Thanks [@UpperM](https://github.com/UpperM)! - Fixes manifest version being hardcoded to "0.1.0". The version and git commit SHA are now injected at build time via tsdown/Vite `define`, reading from package.json and `git rev-parse`.

- [#494](https://github.com/emdash-cms/emdash/pull/494) [`a283954`](https://github.com/emdash-cms/emdash/commit/a28395455cec14cea6d382a604e2598ead097d99) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds defensive identifier validation to all SQL interpolation points to prevent injection via dynamic identifiers.

- [#351](https://github.com/emdash-cms/emdash/pull/351) [`c70f66f`](https://github.com/emdash-cms/emdash/commit/c70f66f7da66311fcf2f5922f23cdf951cdaff5f) Thanks [@CacheMeOwside](https://github.com/CacheMeOwside)! - Fixes redirect loops causing the ERR_TOO_MANY_REDIRECTS error, by detecting circular chains when creating or editing redirects on the admin Redirects page.

- [#499](https://github.com/emdash-cms/emdash/pull/499) [`0b4e61b`](https://github.com/emdash-cms/emdash/commit/0b4e61b059e40d7fc56aceb63d43004c8872005d) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes admin failing to load when installed from npm due to broken locale catalog resolution.

- Updated dependencies [[`c70f66f`](https://github.com/emdash-cms/emdash/commit/c70f66f7da66311fcf2f5922f23cdf951cdaff5f), [`0b4e61b`](https://github.com/emdash-cms/emdash/commit/0b4e61b059e40d7fc56aceb63d43004c8872005d)]:
  - @emdash-cms/admin@0.3.0
  - @emdash-cms/auth@0.3.0
  - @emdash-cms/gutenberg-to-portable-text@0.3.0

## 0.2.0

### Minor Changes

- [#367](https://github.com/emdash-cms/emdash/pull/367) [`8f44ec2`](https://github.com/emdash-cms/emdash/commit/8f44ec23a4b23f636f9689c075d29edfa4962c7c) Thanks [@ttmx](https://github.com/ttmx)! - Adds `content:afterPublish` and `content:afterUnpublish` plugin hooks, fired after content is published or unpublished. Both are fire-and-forget notifications requiring `read:content` capability, supporting trusted and sandboxed plugins.

- [#431](https://github.com/emdash-cms/emdash/pull/431) [`7ee7d95`](https://github.com/emdash-cms/emdash/commit/7ee7d95ee32df2b1915144030569382fe97aef3d) Thanks [@jdevalk](https://github.com/jdevalk)! - Per-collection sitemaps with sitemap index and lastmod

  `/sitemap.xml` now serves a `<sitemapindex>` with one child sitemap per SEO-enabled collection. Each collection's sitemap is at `/sitemap-{collection}.xml` with `<lastmod>` on both index entries and individual URLs. Uses the collection's `url_pattern` for correct URL building.

- [#414](https://github.com/emdash-cms/emdash/pull/414) [`4d4ac53`](https://github.com/emdash-cms/emdash/commit/4d4ac536eeb664b7d0ca9f1895a51960a47ecafe) Thanks [@jdevalk](https://github.com/jdevalk)! - Adds `breadcrumbs?: BreadcrumbItem[]` to `PublicPageContext` so themes can publish a breadcrumb trail as part of the page context, and SEO plugins (or any other `page:metadata` consumer) can read it without having to invent their own per-theme override mechanism. `BreadcrumbItem` is also exported from the `emdash` package root. The field is optional and non-breaking — existing themes and plugins work unchanged, and consumers can adopt it incrementally. Empty array (`breadcrumbs: []`) is an explicit opt-out signal (e.g. for homepages); `undefined` means "no opinion, fall back to consumer's own derivation".

- [#111](https://github.com/emdash-cms/emdash/pull/111) [`87b0439`](https://github.com/emdash-cms/emdash/commit/87b0439927454a275833992de4244678b47b9aa3) Thanks [@mvanhorn](https://github.com/mvanhorn)! - Adds repeater field type for structured repeating data

- [#382](https://github.com/emdash-cms/emdash/pull/382) [`befaeec`](https://github.com/emdash-cms/emdash/commit/befaeecfefd968d14693e96e3cdaa691ffabe7d3) Thanks [@UpperM](https://github.com/UpperM)! - Adds `siteUrl` config option to fix reverse-proxy origin mismatch. Replaces `passkeyPublicOrigin` with a single setting that covers all origin-dependent features: passkeys, CSRF, OAuth, auth redirects, MCP discovery, snapshots, sitemap, robots.txt, and JSON-LD.

  Supports `EMDASH_SITE_URL` / `SITE_URL` environment variables for container deployments where the domain is only known at runtime.

  Disables Astro's `security.checkOrigin` (EmDash's own CSRF layer handles origin validation with dual-origin support and runtime siteUrl resolution). When `siteUrl` is set in config, also sets `security.allowedDomains` so `Astro.url` reflects the public origin in templates.

  **Breaking:** `passkeyPublicOrigin` is removed. Rename to `siteUrl` in your `astro.config.mjs`.

### Patch Changes

- [#182](https://github.com/emdash-cms/emdash/pull/182) [`156ba73`](https://github.com/emdash-cms/emdash/commit/156ba7350070400e5877e3a54d33486cd0d33640) Thanks [@masonjames](https://github.com/masonjames)! - Fixes media routes so storage keys with slashes resolve correctly.

- [#422](https://github.com/emdash-cms/emdash/pull/422) [`80a895b`](https://github.com/emdash-cms/emdash/commit/80a895b1def1bf8794f56e151e5ad7675225fae4) Thanks [@baezor](https://github.com/baezor)! - Fixes SEO hydration exceeding D1 SQL variable limit on large collections by chunking the `content_id IN (...)` clause in `SeoRepository.getMany`.

- [#94](https://github.com/emdash-cms/emdash/pull/94) [`da957ce`](https://github.com/emdash-cms/emdash/commit/da957ce8ec18953995e6e00e0a38e5d830f1a381) Thanks [@eyupcanakman](https://github.com/eyupcanakman)! - Reject dangerous URL schemes in menu custom links

- [#223](https://github.com/emdash-cms/emdash/pull/223) [`fcd8b7b`](https://github.com/emdash-cms/emdash/commit/fcd8b7bebbd4342de6ca1d782a3ae4d42d1be913) Thanks [@baezor](https://github.com/baezor)! - Fixes byline hydration exceeding D1 SQL variable limit on large collections by chunking IN clauses.

- [#479](https://github.com/emdash-cms/emdash/pull/479) [`8ac15a4`](https://github.com/emdash-cms/emdash/commit/8ac15a4ee450552f763d3c6d9d097941c57b8300) Thanks [@ascorbic](https://github.com/ascorbic)! - Enforces permission checks on content status transitions, media provider endpoints, and translation group creation.

- [#250](https://github.com/emdash-cms/emdash/pull/250) [`ba2b020`](https://github.com/emdash-cms/emdash/commit/ba2b0204d274cf1bbf89f724a99797660733203c) Thanks [@JULJERYT](https://github.com/JULJERYT)! - Optimize dashboard stats (3x fewer db queries)

- [#340](https://github.com/emdash-cms/emdash/pull/340) [`0b108cf`](https://github.com/emdash-cms/emdash/commit/0b108cf6286e5b41c134bbeca8a6cc834756b190) Thanks [@mvanhorn](https://github.com/mvanhorn)! - Passes emailPipeline to plugin route handler context so plugins with email:send capability can send email from route handlers.

- [#148](https://github.com/emdash-cms/emdash/pull/148) [`1989e8b`](https://github.com/emdash-cms/emdash/commit/1989e8b4c432a05d022baf2196dec2680b2e2fd0) Thanks [@masonjames](https://github.com/masonjames)! - Adds public plugin settings helpers.

- [#352](https://github.com/emdash-cms/emdash/pull/352) [`e190324`](https://github.com/emdash-cms/emdash/commit/e1903248e0fccb1b34d0620b33e4f06eccdfe2a6) Thanks [@barckcode](https://github.com/barckcode)! - Allows external HTTPS images in the admin UI by adding `https:` to the `img-src` CSP directive. Fixes external content images (e.g. from migration or external hosting) being blocked in the content editor.

- [#72](https://github.com/emdash-cms/emdash/pull/72) [`724191c`](https://github.com/emdash-cms/emdash/commit/724191cf96d5d79b22528a167de8c45146fb0746) Thanks [@travisbreaks](https://github.com/travisbreaks)! - Fix CLI login against remote Cloudflare-deployed instances by unwrapping API response envelope and adding admin scope

- [#480](https://github.com/emdash-cms/emdash/pull/480) [`ed28089`](https://github.com/emdash-cms/emdash/commit/ed28089bd296e1633ea048c7ca667cb5341f6aa6) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes admin demotion guard, OAuth consent flow, device flow token exchange, preview token scoping, and revision cleanup on permanent delete.

- [#247](https://github.com/emdash-cms/emdash/pull/247) [`a293708`](https://github.com/emdash-cms/emdash/commit/a2937083f8f74e32ad1b0383d9f22b20e18d7237) Thanks [@NaeemHaque](https://github.com/NaeemHaque)! - Fixes email settings page showing empty by registering the missing API route. Adds error state to the admin UI so fetch failures are visible instead of silently swallowed.

- [#324](https://github.com/emdash-cms/emdash/pull/324) [`c75cc5b`](https://github.com/emdash-cms/emdash/commit/c75cc5b82cb678c5678859b249d545e12be6fd97) Thanks [@barckcode](https://github.com/barckcode)! - Fixes admin editor crash when image blocks lack the `asset` wrapper. Image blocks with `url` at the top level (e.g. from CMS migrations) now render correctly instead of throwing `TypeError: Cannot read properties of undefined (reading 'url')`.

- [#353](https://github.com/emdash-cms/emdash/pull/353) [`6ebb797`](https://github.com/emdash-cms/emdash/commit/6ebb7975be00a4d756cdb56955c88395840e3fec) Thanks [@ilicfilip](https://github.com/ilicfilip)! - fix(core): pass field.options through to admin manifest for plugin field widgets

- [#209](https://github.com/emdash-cms/emdash/pull/209) [`d421ee2`](https://github.com/emdash-cms/emdash/commit/d421ee2cedfe48748148912ac7766fd841757dd6) Thanks [@JonahFoster](https://github.com/JonahFoster)! - Fixes base OG, Twitter, and article JSON-LD titles so they can use a page-specific title without including the site name suffix from the document title.

- [#394](https://github.com/emdash-cms/emdash/pull/394) [`391caf4`](https://github.com/emdash-cms/emdash/commit/391caf4a0f404f323b97c5d7f54f4a4d96aef349) Thanks [@datienzalopez](https://github.com/datienzalopez)! - Fixes `plugin:activate` and `plugin:deactivate` hooks not being called when enabling or disabling a plugin via the admin UI or `setPluginStatus`. Previously, `setPluginStatus` rebuilt the hook pipeline but never invoked the lifecycle hooks. Now `plugin:activate` fires after the pipeline is rebuilt with the plugin included, and `plugin:deactivate` fires on the current pipeline before the plugin is removed.

- [#357](https://github.com/emdash-cms/emdash/pull/357) [`6474dae`](https://github.com/emdash-cms/emdash/commit/6474daee29b6d0be289c995755658755d93316b1) Thanks [@Vallhalen](https://github.com/Vallhalen)! - Fix: default adminPages and dashboardWidgets to empty arrays in manifest to prevent admin UI crash when plugins omit these properties.

- [#453](https://github.com/emdash-cms/emdash/pull/453) [`30c9a96`](https://github.com/emdash-cms/emdash/commit/30c9a96404e913ea8b3039ef4a5bc70541647eec) Thanks [@all3f0r1](https://github.com/all3f0r1)! - Fixes `ctx.content.create()` and `ctx.content.update()` so plugins can write
  to the core SEO panel. When the input `data` contains a reserved `seo` key,
  it is now extracted and routed to `_emdash_seo` via the SEO repository,
  matching the REST API shape. `ctx.content.get()` and `ctx.content.list()`
  also hydrate the `seo` field on returned items for SEO-enabled collections.

- [#326](https://github.com/emdash-cms/emdash/pull/326) [`122c236`](https://github.com/emdash-cms/emdash/commit/122c2364fc4cfc9082f036f9affcee13d9b00511) Thanks [@barckcode](https://github.com/barckcode)! - Fixes WXR import not preserving original post dates or publish status. Uses `wp:post_date_gmt` (UTC) with fallback chain to `pubDate` (RFC 2822) then `wp:post_date` (site-local). Handles the WordPress `0000-00-00 00:00:00` sentinel for unpublished drafts. Sets `published_at` for published posts. Applies to both WXR file upload and plugin-based import paths.

- [#371](https://github.com/emdash-cms/emdash/pull/371) [`5320321`](https://github.com/emdash-cms/emdash/commit/5320321f5ee1c1f456b1c8c054f2d0232be58ecd) Thanks [@pejmanjohn](https://github.com/pejmanjohn)! - Fix MCP OAuth discovery for unauthenticated POST requests.

- [#338](https://github.com/emdash-cms/emdash/pull/338) [`b712ae3`](https://github.com/emdash-cms/emdash/commit/b712ae3e5d8aec45e4d7a0f20f273795f7122715) Thanks [@mvanhorn](https://github.com/mvanhorn)! - Fixes standalone wildcard "_" in plugin allowedHosts so plugins declaring allowedHosts: ["_"] can make outbound HTTP requests to any host.

- [#434](https://github.com/emdash-cms/emdash/pull/434) [`9cb5a28`](https://github.com/emdash-cms/emdash/commit/9cb5a28001cc8e6d650ec6b45c9ea091a4e9e3c2) Thanks [@hayatosc](https://github.com/hayatosc)! - Avoid accessing sessions on prerendered public routes.

- [#119](https://github.com/emdash-cms/emdash/pull/119) [`e1014ef`](https://github.com/emdash-cms/emdash/commit/e1014eff18301ff68ac75d19157d3500ebe890c5) Thanks [@blmyr](https://github.com/blmyr)! - Fix plugin `page:metadata` and `page:fragments` hooks not firing for anonymous public page visitors. The middleware's early-return fast-path for unauthenticated requests now initializes the runtime (skipping only the manifest query), so plugin contributions render via `<EmDashHead>`, `<EmDashBodyStart>`, and `<EmDashBodyEnd>` for all visitors. Also adds `collectPageMetadata` and `collectPageFragments` to the `EmDashHandlers` interface.

- [#424](https://github.com/emdash-cms/emdash/pull/424) [`476cb3a`](https://github.com/emdash-cms/emdash/commit/476cb3a585d30acb2d4d172f94c5d2b4e5b6377b) Thanks [@csfalcao](https://github.com/csfalcao)! - Fixes public access to the search API (#104). The auth middleware blocked `/_emdash/api/search` before the handler ran, so #107's handler-level change never took effect for anonymous callers. Adds the endpoint to `PUBLIC_API_EXACT` so the shipped `LiveSearch` component works on public sites without credentials. Admin endpoints (`/search/enable`, `/search/rebuild`, `/search/stats`, `/search/suggest`) remain authenticated.

- [#333](https://github.com/emdash-cms/emdash/pull/333) [`dd708b1`](https://github.com/emdash-cms/emdash/commit/dd708b1c0c35d43761f89a87cba74b3c0ecb777e) Thanks [@mvanhorn](https://github.com/mvanhorn)! - Adds composite index on (deleted_at, published_at DESC, id DESC) to eliminate full table scans for frontend listing queries that order by published_at.

- [#448](https://github.com/emdash-cms/emdash/pull/448) [`c92e7e6`](https://github.com/emdash-cms/emdash/commit/c92e7e6907a575d134a69ebbeed531b99569d599) Thanks [@grexe](https://github.com/grexe)! - fixes logo and favicon site settings not being applied to templates

- [#319](https://github.com/emdash-cms/emdash/pull/319) [`2ba1f1f`](https://github.com/emdash-cms/emdash/commit/2ba1f1f8d1ff773889f980af35391187e3705f17) Thanks [@ideepakchauhan7](https://github.com/ideepakchauhan7)! - Fixes i18n config returning null in Vite dev SSR by reading from virtual module instead of dynamic import.

- [#251](https://github.com/emdash-cms/emdash/pull/251) [`a13c4ec`](https://github.com/emdash-cms/emdash/commit/a13c4ec6e362abecdae62abe64b1aebebc06aaae) Thanks [@yohaann196](https://github.com/yohaann196)! - fix: expose client_id in device flow discovery response

- [#93](https://github.com/emdash-cms/emdash/pull/93) [`a5e0603`](https://github.com/emdash-cms/emdash/commit/a5e0603b1910481d042f5a22dd19a60c76da7197) Thanks [@eyupcanakman](https://github.com/eyupcanakman)! - Fix taxonomy links missing from admin sidebar

- Updated dependencies [[`0966223`](https://github.com/emdash-cms/emdash/commit/09662232bd960e426ca00b10e7d49585aad00f99), [`53dec88`](https://github.com/emdash-cms/emdash/commit/53dec8822bf486a1748e381087306f6097e6290c), [`3b6b75b`](https://github.com/emdash-cms/emdash/commit/3b6b75b01b5674776cb588506d75042d4a2745ea), [`a293708`](https://github.com/emdash-cms/emdash/commit/a2937083f8f74e32ad1b0383d9f22b20e18d7237), [`1a93d51`](https://github.com/emdash-cms/emdash/commit/1a93d51777afaec239641e7587d6e32d8a590656), [`c9bf640`](https://github.com/emdash-cms/emdash/commit/c9bf64003d161a9517bd78599b3d7f8d0bf93cda), [`87b0439`](https://github.com/emdash-cms/emdash/commit/87b0439927454a275833992de4244678b47b9aa3), [`5eeab91`](https://github.com/emdash-cms/emdash/commit/5eeab918820f680ea8b46903df7d69969af8b8ee), [`e3f7db8`](https://github.com/emdash-cms/emdash/commit/e3f7db8bb670bb7444632ab0cd4e680e4c9029b3), [`a5e0603`](https://github.com/emdash-cms/emdash/commit/a5e0603b1910481d042f5a22dd19a60c76da7197)]:
  - @emdash-cms/admin@0.2.0
  - @emdash-cms/auth@0.2.0
  - @emdash-cms/gutenberg-to-portable-text@0.2.0

## 0.1.1

### Patch Changes

- [#200](https://github.com/emdash-cms/emdash/pull/200) [`422018a`](https://github.com/emdash-cms/emdash/commit/422018aeb227dffe3da7bfc772d86f9ce9c2bcd1) Thanks [@ascorbic](https://github.com/ascorbic)! - Replace placeholder text branding with proper EmDash logo SVGs across admin UI, playground loading page, and preview interstitial

- [#206](https://github.com/emdash-cms/emdash/pull/206) [`4221ba4`](https://github.com/emdash-cms/emdash/commit/4221ba48bc87ab9fa0b1bae144f6f2920beb4f5a) Thanks [@tsikatawill](https://github.com/tsikatawill)! - Fixes multiSelect custom fields rendering as plain text inputs instead of a checkbox group.

- [#133](https://github.com/emdash-cms/emdash/pull/133) [`9269759`](https://github.com/emdash-cms/emdash/commit/9269759674bf254863f37d4cf1687fae56082063) Thanks [@kyjus25](https://github.com/kyjus25)! - Fix auth links and OAuth callbacks to use `/_emdash/api/auth/...` so emailed sign-in, signup, and invite URLs resolve correctly in EmDash.

- [#365](https://github.com/emdash-cms/emdash/pull/365) [`d6cfc43`](https://github.com/emdash-cms/emdash/commit/d6cfc437f23e3e435a8862cab17d2c19363847d7) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes migration 033 failing with "index already exists" on databases where the schema registry had already created composite indexes on content tables.

- [#313](https://github.com/emdash-cms/emdash/pull/313) [`1bcfc50`](https://github.com/emdash-cms/emdash/commit/1bcfc502112d8756e34a720b8a170eb5486b425a) Thanks [@mvanhorn](https://github.com/mvanhorn)! - Remove FTS5 integrity-check from startup verification to prevent D1 shadow table corruption

- [#262](https://github.com/emdash-cms/emdash/pull/262) [`8c693b5`](https://github.com/emdash-cms/emdash/commit/8c693b582d7c5e29bd138161e81d9c8affb53689) Thanks [@BenjaminPrice](https://github.com/BenjaminPrice)! - Fix media upload OOM on Cloudflare Workers for large images by generating blurhash from client-provided thumbnails instead of decoding full-resolution images server-side

- [#330](https://github.com/emdash-cms/emdash/pull/330) [`5b3e33c`](https://github.com/emdash-cms/emdash/commit/5b3e33c26bc2eb30ab2a032960a5d57eb06f148a) Thanks [@MattieTK](https://github.com/MattieTK)! - Fixes migration 033 (optimize content indexes) not being registered in the static migration runner, so the composite and partial indexes it defines are now actually applied on startup.

- [#181](https://github.com/emdash-cms/emdash/pull/181) [`9d10d27`](https://github.com/emdash-cms/emdash/commit/9d10d2791fe16be901d9d138e434bd79cf9335c4) Thanks [@ilicfilip](https://github.com/ilicfilip)! - fix(admin): use collection urlPattern for preview button fallback URL

- [#363](https://github.com/emdash-cms/emdash/pull/363) [`91e31fb`](https://github.com/emdash-cms/emdash/commit/91e31fb2cab4c0470088c5d61bab6e2028821569) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes sandboxed plugin entries failing when package exports point to unbuilt TypeScript source. Adds build-time and bundle-time validation to catch misconfigured plugin exports early.

- [#298](https://github.com/emdash-cms/emdash/pull/298) [`f112ac4`](https://github.com/emdash-cms/emdash/commit/f112ac48194d1c2302e93756d54b116d3d207c22) Thanks [@BenjaminPrice](https://github.com/BenjaminPrice)! - Fixes install telemetry using an unstable hash that inflated install counts. Uses the site's request origin as a stable hash seed for accurate per-site deduplication. Denormalizes install_count on the marketplace plugins table for query performance.

- [#214](https://github.com/emdash-cms/emdash/pull/214) [`e9a6f7a`](https://github.com/emdash-cms/emdash/commit/e9a6f7ac3ceeaf5c2d0a557e4cf6cab5f3d7d764) Thanks [@SARAMALI15792](https://github.com/SARAMALI15792)! - Optimizes D1 database indexes to eliminate full table scans in admin panel. Adds
  composite indexes on ec\_\* content tables for common query patterns (deleted_at +
  updated_at/created_at + id) and rewrites comment counting to use partial indexes.
  Reduces D1 row reads by 90%+ for dashboard operations.

- [#107](https://github.com/emdash-cms/emdash/pull/107) [`b297fdd`](https://github.com/emdash-cms/emdash/commit/b297fdd88dadcabeb93f47abea9f24f70b7d4b71) Thanks [@mvanhorn](https://github.com/mvanhorn)! - Allows public access to search API for frontend LiveSearch

- [#225](https://github.com/emdash-cms/emdash/pull/225) [`d211452`](https://github.com/emdash-cms/emdash/commit/d2114523a55021f65ee46e44e11157b06334819e) Thanks [@seslly](https://github.com/seslly)! - Adds `passkeyPublicOrigin` on `emdash()` so WebAuthn `origin` and `rpId` match the browser when dev sits behind a TLS-terminating reverse proxy. Validates the value at integration load time and threads it through all passkey-related API routes.

  Updates the admin passkey setup and login flows to detect non-secure origins and explain that passkeys need HTTPS or `http://localhost` rather than implying the browser lacks WebAuthn support.

- [#105](https://github.com/emdash-cms/emdash/pull/105) [`8e28cfc`](https://github.com/emdash-cms/emdash/commit/8e28cfc5d66f58f0fb91aa35c02afdd426bb6555) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix CLI `--json` flag so JSON output is clean. Previously, `consola.success()` and other log messages leaked into stdout alongside the JSON data, making it unparseable by scripts. Log messages now go to stderr when `--json` is set.

- [#83](https://github.com/emdash-cms/emdash/pull/83) [`38af118`](https://github.com/emdash-cms/emdash/commit/38af118ad517fd9aa83064368543bf64bc32c08a) Thanks [@antoineVIVIES](https://github.com/antoineVIVIES)! - Sanitize WordPress post type slugs during import. Fixes crashes when importing sites using plugins (Elementor, WooCommerce, ACF, etc.) that register post types with hyphens, uppercase letters, or other characters invalid in EmDash collection slugs. Reserved collection slugs are prefixed with `wp_` to avoid conflicts.

- Updated dependencies [[`12d73ff`](https://github.com/emdash-cms/emdash/commit/12d73ff4560551bbe873783e4628bbd80809c449), [`422018a`](https://github.com/emdash-cms/emdash/commit/422018aeb227dffe3da7bfc772d86f9ce9c2bcd1), [`9269759`](https://github.com/emdash-cms/emdash/commit/9269759674bf254863f37d4cf1687fae56082063), [`71744fb`](https://github.com/emdash-cms/emdash/commit/71744fb8b2bcc7f48acea41f9866878463a4f4f7), [`018be7f`](https://github.com/emdash-cms/emdash/commit/018be7f1c3a8b399a9f38d7fa524e6f2908d95c3), [`9d10d27`](https://github.com/emdash-cms/emdash/commit/9d10d2791fe16be901d9d138e434bd79cf9335c4), [`d211452`](https://github.com/emdash-cms/emdash/commit/d2114523a55021f65ee46e44e11157b06334819e), [`ab21f29`](https://github.com/emdash-cms/emdash/commit/ab21f29f713a5aa4c087c535608e1a2cab2ef9e0), [`bfcda12`](https://github.com/emdash-cms/emdash/commit/bfcda121400ee2bbbc35d666cc8bed38e0eba8ea), [`5f448d1`](https://github.com/emdash-cms/emdash/commit/5f448d1035073283fd7435d2f320d1f3c94898a0)]:
  - @emdash-cms/admin@0.1.1
  - @emdash-cms/auth@0.1.1

## 0.1.0

### Minor Changes

- [#14](https://github.com/emdash-cms/emdash/pull/14) [`755b501`](https://github.com/emdash-cms/emdash/commit/755b5017906811f97f78f4c0b5a0b62e67b52ec4) Thanks [@ascorbic](https://github.com/ascorbic)! - First beta release

### Patch Changes

- Updated dependencies [[`755b501`](https://github.com/emdash-cms/emdash/commit/755b5017906811f97f78f4c0b5a0b62e67b52ec4)]:
  - @emdash-cms/admin@0.1.0
  - @emdash-cms/auth@0.1.0
  - @emdash-cms/gutenberg-to-portable-text@0.1.0

## 0.0.3

### Patch Changes

- [#8](https://github.com/emdash-cms/emdash/pull/8) [`3c319ed`](https://github.com/emdash-cms/emdash/commit/3c319ed6411a595e6974a86bc58c2a308b91c214) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix crash on fresh deployments when the first request hits a public page before setup has run. The middleware now detects an empty database and redirects to the setup wizard instead of letting template helpers query missing tables.

- Updated dependencies [[`3c319ed`](https://github.com/emdash-cms/emdash/commit/3c319ed6411a595e6974a86bc58c2a308b91c214)]:
  - @emdash-cms/admin@0.0.2

## 0.0.2

### Patch Changes

- [#2](https://github.com/emdash-cms/emdash/pull/2) [`b09bfd5`](https://github.com/emdash-cms/emdash/commit/b09bfd51cece5e88fe8314668a591ab11de36b4d) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix virtual module resolution errors when emdash is installed from npm on Cloudflare. The esbuild dependency pre-bundler was encountering `virtual:emdash/*` imports while crawling dist files and failing to resolve them. These are now excluded from the optimizeDeps scan.
