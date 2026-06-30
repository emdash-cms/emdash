# emdash

## 0.25.0

### Minor Changes

- [#1658](https://github.com/emdash-cms/emdash/pull/1658) [`1f4aa59`](https://github.com/emdash-cms/emdash/commit/1f4aa59a284bb6fa10dd9672a671b62a2a1ba3aa) Thanks [@ttmx](https://github.com/ttmx)! - Adds a content restore hook for plugins to react when trashed entries are restored.

### Patch Changes

- [#1662](https://github.com/emdash-cms/emdash/pull/1662) [`942fac6`](https://github.com/emdash-cms/emdash/commit/942fac6c87d7a6ce3a62ec7e0610887db5a44f3f) Thanks [@scottbuscemi](https://github.com/scottbuscemi)! - Treats API-token and OAuth-token (`Authorization: Bearer ec_pat_*` / `ec_oat_*`) requests as authenticated when choosing the request-scoped database connection. These requests carry no session cookie, so they were previously classified as anonymous and could be routed to a read replica (D1) or the query cache (Hyperdrive split caching), breaking read-your-writes for API clients. They now use the primary/uncached connection like session-authenticated requests.

- [#1543](https://github.com/emdash-cms/emdash/pull/1543) [`38a63d5`](https://github.com/emdash-cms/emdash/commit/38a63d54e7c7c2735caa179b303c63c175a9570e) Thanks [@marcusbellamyshaw-cell](https://github.com/marcusbellamyshaw-cell)! - Fixes the admin author filter returning HTTP 500 (`NOT_CONFIGURED` / "EmDash is not initialized") for every collection. The `handleContentAuthors` handler was never exposed on the per-request `locals.emdash` object in middleware, so `GET /_emdash/api/content/{collection}/authors` always tripped its not-initialized guard while sibling content routes worked normally.

- [#1556](https://github.com/emdash-cms/emdash/pull/1556) [`0f8d1ff`](https://github.com/emdash-cms/emdash/commit/0f8d1ffc081e31217eadc0d71051d7c7324ca173) Thanks [@marcusbellamyshaw-cell](https://github.com/marcusbellamyshaw-cell)! - `SchemaRegistry.updateField` (and `emdash seed --on-conflict update`) no longer silently ignore a field's `type` change ([#1397](https://github.com/emdash-cms/emdash/issues/1397)). Previously, changing a field's type in `seed.json` and re-seeding reported success and bumped the updated count while leaving `_emdash_fields.type`/`column_type` at their old values, so generated types and column mappings went stale with no warning. `UpdateFieldInput` now accepts `type`: a change whose underlying column type is unchanged (e.g. `string` → `slug`, both `TEXT`) is applied, and a change that would alter the column type (e.g. `text` → `portableText`, `TEXT` → `JSON`) is rejected with a clear `FIELD_TYPE_COLUMN_CHANGE` error pointing to the need for a manual content migration, instead of silently corrupting the metadata.

- Updated dependencies [[`8c4108e`](https://github.com/emdash-cms/emdash/commit/8c4108e58a9547af158d60e729f070335b0dd957), [`e277989`](https://github.com/emdash-cms/emdash/commit/e277989a89696b2b9211a9f0b898f7e7dcc99293), [`1ad7b6d`](https://github.com/emdash-cms/emdash/commit/1ad7b6d4cfb51a7c3cf592ad4af987c08a7ca897)]:
  - @emdash-cms/admin@0.25.0
  - @emdash-cms/auth@0.25.0
  - @emdash-cms/gutenberg-to-portable-text@0.25.0

## 0.24.1

### Patch Changes

- [#1646](https://github.com/emdash-cms/emdash/pull/1646) [`c962929`](https://github.com/emdash-cms/emdash/commit/c962929fa718479762ef8bded4a0b6c39eb43e0e) Thanks [@mvanhorn](https://github.com/mvanhorn)! - Fixes hierarchical taxonomy terms losing their parent in translated locales. A child term now stores its parent's translation group instead of a locale-bound row id, so translating a parent automatically re-nests its existing children in every locale instead of flattening them to the root. A forward-only migration backfills existing parent links.

- [#1644](https://github.com/emdash-cms/emdash/pull/1644) [`d64c961`](https://github.com/emdash-cms/emdash/commit/d64c961f89cf97303c4ffb3341f05424356120f0) Thanks [@masonjames](https://github.com/masonjames)! - Fixes React 19 development console warnings from the visual editing toolbar's `useSyncExternalStore` dependency path.

- Updated dependencies []:
  - @emdash-cms/admin@0.24.1
  - @emdash-cms/auth@0.24.1
  - @emdash-cms/gutenberg-to-portable-text@0.24.1

## 0.24.0

### Minor Changes

- [#1577](https://github.com/emdash-cms/emdash/pull/1577) [`79fc8b5`](https://github.com/emdash-cms/emdash/commit/79fc8b5b16b07001f5c0a4d964c2ac1fabd39573) Thanks [@marcusbellamyshaw-cell](https://github.com/marcusbellamyshaw-cell)! - Adds offset pagination to `getEmDashCollection` for numbered archive routes

  `getEmDashCollection` now accepts an `offset` option alongside `limit`, so you can render numbered archive URLs like `/page/2` or `/tag/security/page/3` without walking cursors or over-fetching from the start:

  ```ts
  const perPage = 20;
  const { entries, hasMore } = await getEmDashCollection("posts", {
  	limit: perPage,
  	offset: (page - 1) * perPage,
  	orderBy: { published_at: "desc" },
  });
  ```

  Results now include a `hasMore` boolean whenever `limit` is set, so you can show a "next page" link without an extra count query. `offset` is ignored when a `cursor` is supplied — cursor (keyset) pagination still wins.

### Patch Changes

- [#1558](https://github.com/emdash-cms/emdash/pull/1558) [`e659a5c`](https://github.com/emdash-cms/emdash/commit/e659a5c25001ec181c8771e17a8c3264d1498fbf) Thanks [@marcusbellamyshaw-cell](https://github.com/marcusbellamyshaw-cell)! - Fixes EmDash overriding security headers set by the host site ([#1393](https://github.com/emdash-cms/emdash/issues/1393)). The baseline `X-Content-Type-Options`, `Referrer-Policy`, and `Permissions-Policy` headers were applied unconditionally, overwriting stricter values a host had already set on its own routes. These headers are now applied only when the host hasn't set them — matching the existing `Content-Security-Policy` behavior — so a host's own values win while EmDash still provides defaults when none are set.

- [#1636](https://github.com/emdash-cms/emdash/pull/1636) [`d8487f9`](https://github.com/emdash-cms/emdash/commit/d8487f99ba05b9b96e3a200d8b1f0e1902c4ac8c) Thanks [@MA2153](https://github.com/MA2153)! - Fixes `ctx.cron` being undefined during `astro dev` under the `@astrojs/cloudflare` adapter, which silently prevented plugins from scheduling cron tasks and stopped the `cron` hook from ever firing in local dev. The in-process scheduler now keys off Astro's command rather than Vite's, so plugin cron, scheduled publishing, and cleanup run again.

- Updated dependencies [[`f5566e8`](https://github.com/emdash-cms/emdash/commit/f5566e819f3d047a84b3f1f38a50b6707a6dbe9d), [`d063b51`](https://github.com/emdash-cms/emdash/commit/d063b51e2930c5a1c3bb4d24381afdbdf63a2de2), [`43a70d4`](https://github.com/emdash-cms/emdash/commit/43a70d49ebe09dc901a336eb2448185536e00097)]:
  - @emdash-cms/admin@0.24.0
  - @emdash-cms/auth@0.24.0
  - @emdash-cms/gutenberg-to-portable-text@0.24.0

## 0.23.0

### Minor Changes

- [#1349](https://github.com/emdash-cms/emdash/pull/1349) [`bd6cc3a`](https://github.com/emdash-cms/emdash/commit/bd6cc3ad2fe29ee8016843168fb8aa1dc38d33de) Thanks [@MA2153](https://github.com/MA2153)! - **Breaking:** generated TypeScript interface names in `emdash-env.d.ts` now derive from the collection **slug** (singularized) instead of `labelSingular`. This fixes invalid identifiers (labels with spaces/punctuation) and duplicate identifiers (two collections sharing a label), while keeping names singular so each interface reads as a single entry (slug `posts` → `Post`, `blog_posts` → `BlogPost`). Interfaces are renamed wherever the old label-derived name differed from the slug. Users should regenerate `emdash-env.d.ts` (`emdash types` or dev-server start) and update any direct interface references in their code.

### Patch Changes

- [#1593](https://github.com/emdash-cms/emdash/pull/1593) [`b4d7228`](https://github.com/emdash-cms/emdash/commit/b4d7228d5e28d665a32083ac82ce9346baac639a) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes the admin stylesheet leaking onto public routes in `astro dev`. The compiled Kumo/Tailwind theme was injected into every page's `<head>`, overriding host `:root` tokens (`--text-base`, `--text-lg`, ...) and styling otherwise-unstyled pages. The admin shell now loads its stylesheet as a route-scoped `<link>`, so public routes are unaffected — matching production behaviour.

- [#1625](https://github.com/emdash-cms/emdash/pull/1625) [`d74269d`](https://github.com/emdash-cms/emdash/commit/d74269d5a538584a1db4ba82e8ab20113cd955e7) Thanks [@ascorbic](https://github.com/ascorbic)! - Resolves the database connection at use-time for the cron sweep, plugin hook contexts, and media providers instead of capturing it once at startup. This makes scheduled publishing, plugin cron, and database-querying plugin hooks work on connection-backed adapters like Postgres over Cloudflare Hyperdrive, where a connection is bound to the event that opened it. Stateless adapters (D1, Node SQLite) are unaffected.

- [#1617](https://github.com/emdash-cms/emdash/pull/1617) [`e39984f`](https://github.com/emdash-cms/emdash/commit/e39984f9ea688faea01b83a611ffe36b6f984a26) Thanks [@ascorbic](https://github.com/ascorbic)! - Cuts cold-start latency by batching runtime initialization reads into a single round trip. On a fresh isolate (or Worker), the auto-seed check, plugin-state load, and site-info load now run as one batched query on backends that support it (Cloudflare D1, Durable Objects) instead of several serialized round trips. On D1 this roughly halves runtime init time on cold start. Other backends (Node/SQLite) are unaffected.

- [#1559](https://github.com/emdash-cms/emdash/pull/1559) [`280b877`](https://github.com/emdash-cms/emdash/commit/280b8771274b2e8f9d0d54b698592ae162374805) Thanks [@marcusbellamyshaw-cell](https://github.com/marcusbellamyshaw-cell)! - Fixes the editor toolbar leaking into a shared cache ([#1398](https://github.com/emdash-cms/emdash/issues/1398)). When a logged-in editor browsed the public site behind a shared cache (such as Cloudflare), responses carrying the injected toolbar could be cached and then served to anonymous visitors, exposing the toolbar markup and the fact that a session was active. Toolbar-bearing responses are now marked `Cache-Control: private, no-store` so they are never shared-cacheable; responses without an injected toolbar keep their original caching.

- [#1553](https://github.com/emdash-cms/emdash/pull/1553) [`7fca12f`](https://github.com/emdash-cms/emdash/commit/7fca12f0a8fbe3c1c0f6ea0d2a9826eb51a1da57) Thanks [@marcusbellamyshaw-cell](https://github.com/marcusbellamyshaw-cell)! - Byline avatar hydration now includes the media LQIP placeholder fields ([#1457](https://github.com/emdash-cms/emdash/issues/1457)). Content byline credits already folded in the avatar's `avatarStorageKey` and `avatarAlt` via the media join, but dropped the `blurhash`/`dominant_color` placeholder columns, so author avatars couldn't render a low-quality image placeholder while loading even though the media stored one. `BylineSummary` now also carries `avatarBlurhash` and `avatarDominantColor`, populated by `getContentBylines`, `getContentBylinesMany`, and `findByUserIds` (and surfaced in the byline API response), so themes can paint a blurhash/dominant-colour placeholder for byline avatars exactly as they can for other media.

- [#1613](https://github.com/emdash-cms/emdash/pull/1613) [`fd077e0`](https://github.com/emdash-cms/emdash/commit/fd077e0892dedd1eb03c422e07aa54e180ddc0ff) Thanks [@scottbuscemi](https://github.com/scottbuscemi)! - Fixes a build failure in the `EmDashMedia` component. The component-embed branch contained HTML comments (`<!-- ... -->`) inside a JSX expression, which the Astro compiler rejects with "Unexpected token", breaking every production `astro build` and returning 500s in dev on any page that renders media. The note is now a JSX comment.

- [#1389](https://github.com/emdash-cms/emdash/pull/1389) [`9ebb47e`](https://github.com/emdash-cms/emdash/commit/9ebb47e199a86ba13b9555b8b3e4f7c28f241d63) Thanks [@nanangdev](https://github.com/nanangdev)! - Fixes `emdash export-seed --with-content=all` so it exports content from every collection, matching the documented behaviour. Previously the literal string `"all"` was treated as a collection name and matched none, producing an empty `content` block. The bare flag and `--with-content=true` were the only sentinels honoured.

- [#1616](https://github.com/emdash-cms/emdash/pull/1616) [`8c7bc81`](https://github.com/emdash-cms/emdash/commit/8c7bc81690bd1e3b39ef0bfeb234ea7d3ac49f39) Thanks [@MA2153](https://github.com/MA2153)! - Fixes plugins declaring the `media:write` capability receiving a read-only `ctx.media` with no `upload()`. The plugin context only granted a writable media surface when an internal upload-URL provider was wired, which the runtime never supplied — so `ctx.media.upload()` was always `undefined`. Write access is now granted whenever storage is configured (all `upload()` needs), and `getUploadUrl()` is derived from storage when no provider is set. A `media:write` plugin on a site without storage now logs a warning instead of silently degrading to read-only.

- [#1555](https://github.com/emdash-cms/emdash/pull/1555) [`55613e1`](https://github.com/emdash-cms/emdash/commit/55613e1242a7b11c1dd632c9e50b8bd5f57b2baf) Thanks [@marcusbellamyshaw-cell](https://github.com/marcusbellamyshaw-cell)! - Plugin route handlers that call `ctx.request.json()` (or `.text()`, `.formData()`, `.arrayBuffer()`, `.blob()`) now get a clear error pointing them to `ctx.input` instead of the runtime's cryptic "Body has already been read" failure ([#1293](https://github.com/emdash-cms/emdash/issues/1293)). EmDash parses the request body once before the handler runs and exposes it as `ctx.input`, leaving `ctx.request`'s stream consumed; the request handed to handlers now guards those body-reading methods with an actionable message. All other request members (`url`, `method`, `headers`, `signal`, …) are unaffected.

- [#1396](https://github.com/emdash-cms/emdash/pull/1396) [`c5f58b9`](https://github.com/emdash-cms/emdash/commit/c5f58b9a8aeb369baf0b1b0bc2738373c03d2e01) Thanks [@nanangdev](https://github.com/nanangdev)! - fix: render text alignment from rich-text editor end-to-end ([#1201](https://github.com/emdash-cms/emdash/issues/1201))

  The previous fix in `text-align-round-trip` patched only the `packages/core/src/content/converters/` pair but the rich-text editor saves through two other ProseMirror ↔ Portable Text converters that each carried their own copy of the same logic — so reporter and maintainer kept seeing alignment dropped on save:
  - `packages/admin/src/components/PortableTextEditor.tsx` (admin save path)
  - `packages/core/src/components/InlinePortableTextEditor.tsx` (in-page inline editing)

  Both now forward `node.attrs?.textAlign` for paragraphs and headings (only `center`, `right`, `justify` — `left` is the editor default and is omitted so existing content stays byte-identical) and restore it on the reverse path. Each editor's local `PortableTextTextBlock` interface gained the `textAlign?: "left" | "center" | "right" | "justify"` field, mirroring the type in `packages/core/src/content/converters/types.ts`.

  The Portable Text frontend renderer now emits a WordPress-style `has-text-align-{value}` class on the rendered `<p>` / `<h1..h6>` / `<blockquote>` whenever the block carries `textAlign`. A new `Block` component is added under `emdash/ui` for callers composing custom Portable Text components who want to keep the EmDash behaviour. The class allowlist is enforced via `Object.hasOwn`, so a hostile or hand-edited Portable Text block cannot inject arbitrary class names.

  Consolidating the three duplicated converter pairs into a single shared module is a follow-up refactor and intentionally out of scope here.

- [#1619](https://github.com/emdash-cms/emdash/pull/1619) [`c056060`](https://github.com/emdash-cms/emdash/commit/c056060cdbf29b823591c5796e38d03a66fcba70) Thanks [@ascorbic](https://github.com/ascorbic)! - Speeds up content reads by fetching each entry or collection together with its author bylines and taxonomy terms in one database query instead of three. This cuts time-to-first-byte on hosted databases like D1 where every query is a network round trip.

- [#1406](https://github.com/emdash-cms/emdash/pull/1406) [`c43c412`](https://github.com/emdash-cms/emdash/commit/c43c412500e5bc067371f6e680ff3b7b8a726873) Thanks [@SailingGreg](https://github.com/SailingGreg)! - Honor image alignment from WordPress imports at render and in the editor, and surface display-size controls for migrated images.

  The Gutenberg to Portable Text importer already captured image `alignment`, but it was dropped by the renderer and not editable. `Image.astro` now emits `emdash-image--align-*` classes (left/right float, center, wide/full), the admin editor threads `alignment` through the PortableText/TipTap serializer and image node and adds an alignment control that reflects in the node view, and the Display Size panel now shows for migrated images that carry only display dimensions.

- [#1614](https://github.com/emdash-cms/emdash/pull/1614) [`b5ea8e7`](https://github.com/emdash-cms/emdash/commit/b5ea8e70db242472784bd4957e65d5fdb9fecd89) Thanks [@scottbuscemi](https://github.com/scottbuscemi)! - Fixes request-scoped database adapters that hold a real connection (e.g. Postgres over Cloudflare Hyperdrive) so they work on Workers. `locals.emdash.db` is now resolved lazily, so routes get the per-request connection instead of a snapshot of the shared singleton, and a request-scoped connection is now closed only after the response body finishes streaming rather than before — Astro streams HTML while components still query, so closing earlier broke server-rendered pages. No effect on D1 or other stateless bindings.

- [#1396](https://github.com/emdash-cms/emdash/pull/1396) [`c5f58b9`](https://github.com/emdash-cms/emdash/commit/c5f58b9a8aeb369baf0b1b0bc2738373c03d2e01) Thanks [@nanangdev](https://github.com/nanangdev)! - fix(core/converters): persist text alignment from rich-text editor through ProseMirror ↔ Portable Text round-trip ([#1201](https://github.com/emdash-cms/emdash/issues/1201))

  `prosemirrorToPortableText` now reads `node.attrs.textAlign` for paragraphs and headings and forwards it into the Portable Text block. `portableTextToProsemirror` restores it back into ProseMirror node attrs. The `PortableTextTextBlock` type gained an optional `textAlign?: "left" | "center" | "right" | "justify"` field. Left alignment is not persisted (it is TipTap's default and would bloat existing content).

- Updated dependencies []:
  - @emdash-cms/admin@0.23.0
  - @emdash-cms/auth@0.23.0
  - @emdash-cms/gutenberg-to-portable-text@0.23.0

## 0.22.0

### Minor Changes

- [#1540](https://github.com/emdash-cms/emdash/pull/1540) [`cf17c9f`](https://github.com/emdash-cms/emdash/commit/cf17c9f4c8faa46857d92d4b168452d2469dba4b) Thanks [@marcusbellamyshaw-cell](https://github.com/marcusbellamyshaw-cell)! - Add comment reactions

  Visitors can now react to approved comments (positive-only "like" by default,
  extensible to other reaction types). Reactions are deduped per voter via IP hash.

  The `<Comments>` component gains two opt-in props:
  - `reactions` — render a like button per comment and attach live counts.
  - `sort="best"` — order top-level comments by a Reddit-style Wilson score
    lower bound (`sort="oldest"`, the previous behavior, remains the default).

  Posting is progressively enhanced (a tiny inline script, no framework island)
  and emitted only when `reactions` is enabled, so pages that don't use reactions
  ship zero additional JavaScript. Fully additive and backward-compatible: a new
  table, a new route, and new optional props with behavior-preserving defaults.

- [#1484](https://github.com/emdash-cms/emdash/pull/1484) [`d46abfd`](https://github.com/emdash-cms/emdash/commit/d46abfdb739f8d242eddba5ebfda09a8648c8ecf) Thanks [@swissky](https://github.com/swissky)! - Forward declarative `portableTextBlocks` and `fieldWidgets` from standard and sandboxed (from-config) plugins

  Standard- and sandboxed-format plugins could already declare admin pages and dashboard widgets, but their declarative Portable Text block types and field widgets were dropped during adaptation — only native-format plugins surfaced them. Since the admin editor reads these from the manifest, the slash-menu entries and Block Kit forms never appeared for non-native plugins.

  `adaptSandboxEntry` now forwards both for standard plugins and sandboxed plugins resolved from config (the `virtual-modules.ts` codegen path), so those formats can contribute Portable Text blocks and field widgets. The site-side render component (`componentsEntry`) still requires native format, which is unchanged.

  Note: marketplace bundles loaded from R2 are not covered yet — the bundle manifest schema, both `extractManifest()` implementations, and the bundler don't carry these fields, so this is scoped to standard/sandboxed-from-config. Full marketplace support is tracked as a follow-up.

- [#1564](https://github.com/emdash-cms/emdash/pull/1564) [`6a97bac`](https://github.com/emdash-cms/emdash/commit/6a97bacaf6ef8b006b32879e4625ebb48da6f5bd) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds byline management to the MCP server: `byline_list`, `byline_get`, `byline_create`, `byline_update`, `byline_delete`, and `byline_translations` tools, plus a `bylines` argument on `content_create` so credits can be attached at creation time (previously only `content_update` accepted them).

- [#1378](https://github.com/emdash-cms/emdash/pull/1378) [`640e60a`](https://github.com/emdash-cms/emdash/commit/640e60a56e3d3e60925ba4d7a1cf0fbd04b3d5c2) Thanks [@scottbuscemi](https://github.com/scottbuscemi)! - Add an optional distributed object cache for query results.

  Content reads (`getEmDashCollection`, `getEmDashEntry`, `resolveEmDashPath`) and chrome reads (site settings, menus, taxonomies) can now be served from a fast key/value store instead of hitting the database on every request. This sits beneath the per-request cache and above the database, dramatically reducing read pressure on D1/SQLite — especially valuable on Cloudflare, where KV handles far more requests than D1.

  The cache is **off by default** and fully opt-in. Configure a backend in `astro.config.mjs`:

  ```ts
  import { kvCache } from "@emdash-cms/cloudflare"; // Workers KV (distributed)
  import { memoryCache } from "emdash/astro"; // in-isolate (Node / local dev)

  emdash({
  	database: d1({ binding: "DB" }),
  	objectCache: kvCache({ binding: "CACHE" }),
  });
  ```

  with a matching KV binding in `wrangler.jsonc`:

  ```jsonc
  { "kv_namespaces": [{ "binding": "CACHE", "id": "<namespace-id>" }] }
  ```

  Invalidation is epoch-based and automatic: content, byline, taxonomy, menu, and settings writes bump a per-namespace version, instantly orphaning stale entries (no key enumeration needed). Preview and visual-edit requests bypass the cache, so editors previewing see live content; other reads are served from the cache, which only ever stores published content. After an edit, anonymous visitors may see stale content until isolates pick up the bumped epoch — immediate on the in-isolate memory backend, and on KV bounded by KV's edge-cache propagation (eventually consistent, up to ~60s) plus the `revalidate` window (default 1s, configurable).

  New public API: `cachedQuery`, `invalidateObjectCache`, `invalidateCollectionCache`, `contentNamespace`/`contentNamespaces`, `CacheNamespace`, the `ObjectCache*` types (from `emdash`), `memoryCache()` (from `emdash/astro`), and `kvCache()` (from `@emdash-cms/cloudflare`). Existing sites are unaffected until they opt in.

- [#1549](https://github.com/emdash-cms/emdash/pull/1549) [`a623c6b`](https://github.com/emdash-cms/emdash/commit/a623c6b7dbdc82c8562f32a619af23ea147306b6) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes responsive image optimization for storage-backed media on Cloudflare. EmDash now wraps Astro's image endpoint to read media bytes directly from your storage adapter instead of fetching them over HTTP, so `Image` and Portable Text images generate a real responsive `srcset` even when the site is behind Cloudflare Access (previously these 404'd and fell back to a full-size image). This is on by default and also removes an internal HTTP round-trip on Node. Set `images: false` in your `emdash()` config to leave Astro's image endpoint untouched.

### Patch Changes

- [#1579](https://github.com/emdash-cms/emdash/pull/1579) [`0bfab91`](https://github.com/emdash-cms/emdash/commit/0bfab91765514f4a8bd164d7373c8c81e3d5b446) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes a Cloudflare build failure where the bare `zod` import used by the type generator was not externalized, causing the bundler to fail. EmDash sites on Cloudflare now build correctly under Astro 7.

- [#1584](https://github.com/emdash-cms/emdash/pull/1584) [`707edee`](https://github.com/emdash-cms/emdash/commit/707edee3bdf31b53f33507e1f528a0e5803fd150) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes the dev setup-bypass endpoint accumulating duplicate `dev-bypass-token` access tokens. Re-running it (for example after a dev reset) now replaces the previous token with a fresh one instead of adding another row.

- [#1581](https://github.com/emdash-cms/emdash/pull/1581) [`a36b5f3`](https://github.com/emdash-cms/emdash/commit/a36b5f3e1e452d48a690878d4f078f85a6d99715) Thanks [@naota70](https://github.com/naota70)! - Fix the setup probe baking a redirect to `/_emdash/admin/setup` into prerendered pages. On a build whose database is empty (e.g. CI/first deploy), the anonymous setup probe saw a missing migrations table and returned `context.redirect("/_emdash/admin/setup")`; a prerendered route serializes that into static HTML and ships the redirect to production. The probe is now skipped entirely when `context.isPrerendered` is true — there is no live visitor to send to the wizard at build time, and the build database is legitimately empty. Live (SSR) requests are unaffected.

- [#1509](https://github.com/emdash-cms/emdash/pull/1509) [`ed921d8`](https://github.com/emdash-cms/emdash/commit/ed921d80ec33fa114d9c8a7f9221f1fbeb24d658) Thanks [@ascorbic](https://github.com/ascorbic)! - Speeds up public page loads on remote databases (D1, Durable Objects) by eagerly warming site-global layout data (menus, widget areas, taxonomy term lists, settings) at the start of the request, so the layout's per-component reads overlap into roughly one round trip instead of executing serially. Transparent to site code; no template changes needed.

- [#1563](https://github.com/emdash-cms/emdash/pull/1563) [`c219aff`](https://github.com/emdash-cms/emdash/commit/c219aff3b867e178ee267823801db66bbc9b1621) Thanks [@ascorbic](https://github.com/ascorbic)! - Lets the MCP `content_create` and `content_update` tools accept a Markdown string for rich text (portableText) fields, converting it to Portable Text automatically — the same behaviour the EmDash client already has. Passing a Portable Text JSON array still works. Authoring rich text as a single Markdown string avoids the large nested JSON payloads that agents frequently emit as malformed JSON, causing the tool call to fail before it reaches the server. `content_get` and `content_list` gain an optional `markdown` flag (default false) that returns rich text fields as Markdown instead of Portable Text arrays.

- [#1580](https://github.com/emdash-cms/emdash/pull/1580) [`ca47da4`](https://github.com/emdash-cms/emdash/commit/ca47da485ddcf46f7fa7b8efa15c3c20a11c2300) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes query instrumentation (`EMDASH_QUERY_LOG=1`) so the per-query NDJSON log captures queries issued while the page is still streaming, not just those that ran before the response headers were sent. The per-query log now matches the totals already reported by the `[emdash-stream-end]` summary line.

- [#1538](https://github.com/emdash-cms/emdash/pull/1538) [`cb1c689`](https://github.com/emdash-cms/emdash/commit/cb1c68948072c479ed924b52867809bc8ad1c9e5) Thanks [@swissky](https://github.com/swissky)! - Fix logged-in pages hanging indefinitely on Cloudflare Workers ([#1274](https://github.com/emdash-cms/emdash/issues/1274)). A request cancelled mid-`session.get("user")` could leave the session-store read as a promise that never settles, poisoning the isolate so every later session-bearing request hung (0-CPU, multi-minute, `canceled`) — reliably reproducible on fresh isolates right after a deploy. Every session read on the request path (the main middleware, the auth middleware, and the preview-snapshot route) now goes through a shared `resolveSessionUser()` helper that anchors the read with `after()` so a cancelled request still drives it to completion (preventing the isolate poisoning), with a fail-closed timeout backstop that degrades a still-stalled read to "unauthenticated for this request" rather than hanging.

- Updated dependencies [[`f4925b1`](https://github.com/emdash-cms/emdash/commit/f4925b1d2c36b147019335fc8f0de8bead1d47d9)]:
  - @emdash-cms/admin@0.22.0
  - @emdash-cms/auth@0.22.0
  - @emdash-cms/gutenberg-to-portable-text@0.22.0

## 0.21.0

### Minor Changes

- [#1382](https://github.com/emdash-cms/emdash/pull/1382) [`b6a5fac`](https://github.com/emdash-cms/emdash/commit/b6a5fac6d3bc88cc5ab49889de264c37262cc5f7) Thanks [@ascorbic](https://github.com/ascorbic)! - The Astro dev server now prints absolute, clickable URLs for the admin UI and (when enabled) the MCP server, along with a dev-bypass shortcut link that signs you in as a dev admin without going through passkey setup or auth. The startup banner also shows the installed EmDash version. The dev-bypass link is dev-only and the underlying endpoint returns 403 in production.

- [#1508](https://github.com/emdash-cms/emdash/pull/1508) [`e9cd7b7`](https://github.com/emdash-cms/emdash/commit/e9cd7b7821c5a081257cb56bb857b7950e2b1527) Thanks [@swissky](https://github.com/swissky)! - Add a "Gone (410)" rule type. Redirect rules now support `410` (Content Deleted) and `451` (Unavailable For Legal Reasons) as terminal statuses — served directly with no destination — and the 404 log offers a one-click "Mark as Gone (410)" action next to "Create redirect". A 410 tells search engines a URL was intentionally and permanently removed, so it is deindexed faster than a 404.

### Patch Changes

- [#1511](https://github.com/emdash-cms/emdash/pull/1511) [`23c37f3`](https://github.com/emdash-cms/emdash/commit/23c37f35dfe9ce23fca0d48acea228299d25e19e) Thanks [@CacheMeOwside](https://github.com/CacheMeOwside)! - Fixes `emdash doctor` always reporting "could not query users table". The users check now queries the correct table and reports the actual user count.

- [#1530](https://github.com/emdash-cms/emdash/pull/1530) [`997d7ee`](https://github.com/emdash-cms/emdash/commit/997d7eea8f39c16eef28577bb8ace0c0413fc38b) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes admin and content pages intermittently hanging and returning 524 timeouts on Cloudflare Workers. The per-isolate caches for byline custom-field definitions and resolved site secrets could retain a never-settling promise left behind by a cancelled request, which wedged every later request on that isolate until it was evicted. Both caches now cache the resolved value behind a reclaimable single-flight lock, so a cancelled request can no longer stall the isolate.

- [#1386](https://github.com/emdash-cms/emdash/pull/1386) [`37e848b`](https://github.com/emdash-cms/emdash/commit/37e848bf005950a4b312cf5f0a50f7c8820b01fc) Thanks [@auggernaut](https://github.com/auggernaut)! - Skips default robots.txt and sitemap.xml route injection when the host site defines its own root routes.

- Updated dependencies [[`1b10c1d`](https://github.com/emdash-cms/emdash/commit/1b10c1d64d5975c5fef94e61e8cbff251260184c), [`e9cd7b7`](https://github.com/emdash-cms/emdash/commit/e9cd7b7821c5a081257cb56bb857b7950e2b1527)]:
  - @emdash-cms/admin@0.21.0
  - @emdash-cms/auth@0.21.0
  - @emdash-cms/gutenberg-to-portable-text@0.21.0

## 0.20.0

### Minor Changes

- [#1461](https://github.com/emdash-cms/emdash/pull/1461) [`b01aa9b`](https://github.com/emdash-cms/emdash/commit/b01aa9bbb436bcec07516b499eb0516cfbe414b4) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes registry installs failing with "Plugin manifest has changed since you consented" for plugins that declare hook-registration capabilities (email transport, email events, page fragments) or read user records. Plugin bundles now declare their access as a structured `declaredAccess` contract that the registry record, the install-consent dialog, and the sandbox all read consistently, so every capability a plugin declares is shown for consent and enforced — no capability is silently dropped. Re-publish affected plugins to adopt the new bundle format; existing installs are unaffected.

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

- [#1492](https://github.com/emdash-cms/emdash/pull/1492) [`7688f0b`](https://github.com/emdash-cms/emdash/commit/7688f0b6a92ccfdcea6244100c07679e81014161) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes a read-your-writes gap with database read replication: the session bookmark cookie is now persisted even when page rendering throws after a successful write, so an immediately-following request can't read pre-write state from a lagging replica.

- [#1459](https://github.com/emdash-cms/emdash/pull/1459) [`c7166b0`](https://github.com/emdash-cms/emdash/commit/c7166b083eaa2ceb37f8d9682f4a521e5e360a19) Thanks [@mvanhorn](https://github.com/mvanhorn)! - Fix scheduled entries staying hidden after their scheduled time ([#1402](https://github.com/emdash-cms/emdash/issues/1402))

  `isVisible()` read `scheduledAt` via `dataStr`, which returned an empty string for the `Date` the loader produced, so entries whose scheduled time had passed never became visible. The visibility check now reads the scheduled time correctly.

- [#1458](https://github.com/emdash-cms/emdash/pull/1458) [`9c994ad`](https://github.com/emdash-cms/emdash/commit/9c994ada4692d34517ab458f29b8613aa9341ecc) Thanks [@mvanhorn](https://github.com/mvanhorn)! - Fix `npx emdash types` crash caused by the schema endpoint envelope ([#1188](https://github.com/emdash-cms/emdash/issues/1188))

  The `/schema` route returned an enveloped JSON body while `client.request()` already unwraps the `.data` field, so `emdash types` received `undefined` and crashed. The route now returns the un-enveloped shape the client expects.

- [#1489](https://github.com/emdash-cms/emdash/pull/1489) [`eddaf91`](https://github.com/emdash-cms/emdash/commit/eddaf91a6a818cad12bc8f5e14ee16f8189cc073) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes admin pages hanging indefinitely (and eventually returning 524 timeouts) on Cloudflare Workers. The worker-lifetime caches for site settings and search-index health could be left holding a request that never completed (for example when a visitor's request was cancelled mid-load), which then stalled every later request served by that worker until it was recycled. These caches now keep resolved values rather than in-flight requests, so a cancelled or interrupted request can no longer wedge the rest.

- [#1481](https://github.com/emdash-cms/emdash/pull/1481) [`afc3a0f`](https://github.com/emdash-cms/emdash/commit/afc3a0f6f3f0fa831b6c2e7e8ddebb4a7c631007) Thanks [@MA2153](https://github.com/MA2153)! - Fixes collection `where` filters to apply every taxonomy key instead of silently dropping all but the first. Filtering by two or more taxonomies (e.g. `{ category: ["news"], region: ["emea"] }`) now returns the intersection — entries tagged in each taxonomy — matching how field and byline filters already compose.

- [#1498](https://github.com/emdash-cms/emdash/pull/1498) [`3d423a7`](https://github.com/emdash-cms/emdash/commit/3d423a796d7d000160dc7d8d0a582ba7734f214f) Thanks [@ascorbic](https://github.com/ascorbic)! - Reduces redundant database queries when rendering content pages: widget areas are now request-cached, taxonomy term usage-counts are fetched once per request instead of once per taxonomy widget, and `getTermsForEntries` reuses already-hydrated terms instead of re-querying. Fewer round trips per page on every backend.

- [#1492](https://github.com/emdash-cms/emdash/pull/1492) [`7688f0b`](https://github.com/emdash-cms/emdash/commit/7688f0b6a92ccfdcea6244100c07679e81014161) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds an `rpc.count` Server-Timing metric reporting physical database round trips, distinct from `db.count` (logical queries). Backends that batch (the new Durable Objects SQL driver coalesces same-turn reads into one round trip) can now surface how many round trips a request actually made.

- [#1504](https://github.com/emdash-cms/emdash/pull/1504) [`8807701`](https://github.com/emdash-cms/emdash/commit/880770148329fa14ccb1c35d438ae6e53c8e2c97) Thanks [@swissky](https://github.com/swissky)! - Adds image entries to per-collection sitemaps. When a content entry has an SEO image, the sitemap now emits it as a Google `<image:image>` entry, helping Google discover and index page images for Google Images.

- Updated dependencies [[`141aa11`](https://github.com/emdash-cms/emdash/commit/141aa11213206d9ea5e14d1f1cd75c07cfacae7b), [`ddf8f0d`](https://github.com/emdash-cms/emdash/commit/ddf8f0d40fdc4d9138c00cc6bc718cff9e5a4ed3), [`68840a9`](https://github.com/emdash-cms/emdash/commit/68840a9326ff275519eafea9dfe0cebaebaf664a), [`eaedec0`](https://github.com/emdash-cms/emdash/commit/eaedec0cac0780da13d0184534364f5c3291ba8a), [`8bb20c4`](https://github.com/emdash-cms/emdash/commit/8bb20c4a48b6f1137c6d9e05d60603c2f6db1091), [`fb31240`](https://github.com/emdash-cms/emdash/commit/fb31240d649e874e5148d468b857da0598edc487), [`022fd66`](https://github.com/emdash-cms/emdash/commit/022fd66e27396cace47032153acb2d8024ca472e), [`5d8358b`](https://github.com/emdash-cms/emdash/commit/5d8358b408ac4a85fb7156963a15de3862ffe28f), [`ce96271`](https://github.com/emdash-cms/emdash/commit/ce9627190e84f2f4df4c1c405dc60a790bae38d0), [`b2e65ac`](https://github.com/emdash-cms/emdash/commit/b2e65acc7e11294dede51b2d2642db6c00654141), [`589d07f`](https://github.com/emdash-cms/emdash/commit/589d07fc620e41a14d4aa2bdecf4db9d82f118eb), [`d6269e7`](https://github.com/emdash-cms/emdash/commit/d6269e7eb69af3390dae302641e03d7687df19d4), [`325c673`](https://github.com/emdash-cms/emdash/commit/325c6737bf59913d2a50b7f5add306c5cd57d1f0), [`af4af50`](https://github.com/emdash-cms/emdash/commit/af4af50ff7d22c057063a436f3e7a408e33a3d7b), [`c48604b`](https://github.com/emdash-cms/emdash/commit/c48604bb71e20cef58eb2d12bcb5a8e49575477d), [`52ea731`](https://github.com/emdash-cms/emdash/commit/52ea731ace97cb4e429365f0ec844d0e9286130c), [`acfeb89`](https://github.com/emdash-cms/emdash/commit/acfeb89060eec29b50cd076b9099bb20d40e7380), [`6c1fe5c`](https://github.com/emdash-cms/emdash/commit/6c1fe5ccb9ebe530d6c30defaeaec8f260b5b386), [`6246774`](https://github.com/emdash-cms/emdash/commit/624677408362e1c9e8153b1d742e93667e42511a), [`b01aa9b`](https://github.com/emdash-cms/emdash/commit/b01aa9bbb436bcec07516b499eb0516cfbe414b4), [`3e344af`](https://github.com/emdash-cms/emdash/commit/3e344af2c162e37dfa389b9cb88c2c826590b678), [`5f7cd11`](https://github.com/emdash-cms/emdash/commit/5f7cd11a06791dcb25e02a962429ca3dcf66fb1e), [`263392f`](https://github.com/emdash-cms/emdash/commit/263392fc08cd91013e406d014e69fe44b5ffdf00), [`eddadf8`](https://github.com/emdash-cms/emdash/commit/eddadf86bce4dad713a605f5ec7df1922b9affe1)]:
  - @emdash-cms/admin@0.20.0
  - @emdash-cms/registry-client@0.3.2
  - @emdash-cms/plugin-types@0.1.0
  - @emdash-cms/auth@0.20.0
  - @emdash-cms/gutenberg-to-portable-text@0.20.0

## 0.19.0

### Minor Changes

- [#1442](https://github.com/emdash-cms/emdash/pull/1442) [`e96587f`](https://github.com/emdash-cms/emdash/commit/e96587f8ff393939355d3d643a322fe7b2c07c86) Thanks [@ascorbic](https://github.com/ascorbic)! - Add status, author, and date-range filtering to the admin content list ([#1288](https://github.com/emdash-cms/emdash/issues/1288)). The content list API gains `authorId`, `dateField`, `dateFrom`, and `dateTo` query params (all additive and optional), and a new `GET /_emdash/api/content/{collection}/authors` endpoint lists the distinct authors of a collection's content (gated on `content:read`). Filtering runs server-side, so it works across the whole collection rather than only the loaded page.

- [#1439](https://github.com/emdash-cms/emdash/pull/1439) [`023893a`](https://github.com/emdash-cms/emdash/commit/023893a0fa966b95aad4ff533fc2966b3e3dfe03) Thanks [@ascorbic](https://github.com/ascorbic)! - Add content filtering by byline credit. `getEmDashCollection` now accepts a reserved `byline` key in `where` that returns entries credited to a byline in any position, including co-authored entries where the byline is a secondary credit. This makes author archive pages possible without querying the database directly. Pass a single byline translation group or an array to match any of several.

  ```ts
  const byline = await getBylineBySlug("jane-doe");
  const { entries } = await getEmDashCollection("posts", {
  	where: { byline: byline.translationGroup ?? byline.id },
  	orderBy: { published_at: "desc" },
  });
  ```

  A `getEntriesByByline(collection, byline, options)` helper wraps the same filter, mirroring `getEntriesByTerm`.

- [#1367](https://github.com/emdash-cms/emdash/pull/1367) [`f41092b`](https://github.com/emdash-cms/emdash/commit/f41092bd847f1eb161034f1d2c67976e8473e794) Thanks [@MA2153](https://github.com/MA2153)! - Add content-reference database schema: `_emdash_relations` (relationship-type definitions, row-per-locale) and `_emdash_content_references` (directed, locale-agnostic edges between content entries linked by `translation_group`). Additive, forward-only migration `043`; no existing tables change. Groundwork for reference fields — no field type, API, or admin UI yet.

- [#1438](https://github.com/emdash-cms/emdash/pull/1438) [`850c1b7`](https://github.com/emdash-cms/emdash/commit/850c1b7e23eb1b083c0fcb753762effa1d3a207a) Thanks [@ascorbic](https://github.com/ascorbic)! - Generate responsive `srcset`s for media rendered with the `Image` and Portable Text image components. EmDash now routes locally/R2-stored media through Astro's configured image service (`astro:assets`) -- the Cloudflare Images binding on Workers, sharp on Node -- producing width-appropriate candidates and modern formats (e.g. WebP) instead of a single full-size `<img>`.

  This works automatically:
  - Media served from a configured storage `publicUrl` (R2 custom domain, S3/CDN) is authorized and optimized.
  - Same-origin proxied media (local storage, or R2 without a public URL) is optimized when `siteUrl` is set; the matching `image.remotePatterns` entry is registered for you, scoped to the media route.
  - In `astro dev` it works out of the box without configuration.

  When optimization isn't possible (no image service available, an unauthorized host, or unknown dimensions) the components fall back to a plain `<img>`, so existing sites keep rendering exactly as before. No template changes are required.

- [#1312](https://github.com/emdash-cms/emdash/pull/1312) [`c39789c`](https://github.com/emdash-cms/emdash/commit/c39789c383e94125d8874a516988c7d9ca6f5484) Thanks [@ascorbic](https://github.com/ascorbic)! - Drive scheduled publishing from a real heartbeat instead of request side effects ([#1303](https://github.com/emdash-cms/emdash/issues/1303)).

  Content scheduled via the admin now actually transitions to `published` when its time arrives. Previously nothing promoted the row — `status` stayed `scheduled` and `published_at` stayed null forever.

  A new sweep (`publishDueContent`) promotes due content and runs alongside the existing cron tick and system cleanup:
  - **Node / single-process:** the timer-based scheduler already drives it — no action needed.
  - **Cloudflare Workers:** a `scheduled()` handler driven by a Cron Trigger now runs the sweep. The request-driven `PiggybackScheduler` is gone, so there are no maintenance side effects on visitor requests.

  `@emdash-cms/cloudflare` ships a Worker entry that wraps Astro's handler with the `scheduled()` handler (`@emdash-cms/cloudflare/worker`, plus `createScheduledHandler()` for hand-assembled Workers). When a cache provider is configured, the handler also purges edge-cache tags for whatever it published, so stale snapshots produced before the scheduled time are evicted.

  **Migration for existing Cloudflare sites.** New sites get this from the templates. Existing deployments must update two files:

  ```ts
  // src/worker.ts
  export { default, PluginBridge } from "@emdash-cms/cloudflare/worker";
  ```

  ```jsonc
  // wrangler.jsonc
  "triggers": { "crons": ["* * * * *"] }
  ```

  Without the Cron Trigger, scheduled publishing and plugin cron do not run on Workers.

  Scheduled publishing matches manual publishing exactly: it fires `content:afterPublish` hooks (search indexing, webhooks, syndication), and records the _scheduled_ time as `published_at` on first publication rather than the (later) sweep time. The sweep claims each row atomically before promoting it, so an entry unscheduled or rescheduled just before its time is never published, and overlapping sweeps can't double-publish. Local `astro dev` keeps running the timer-driven sweep even under the Cloudflare adapter (where production relies on the Cron Trigger).

  Each tick promotes at most 100 items per collection (a large backlog drains over successive ticks) so a single Worker invocation can't exhaust its CPU/subrequest budget, and edge-cache tags are purged incrementally after each collection's batch rather than only at the end. On Node, the maintenance interval is capped at 60s so scheduled-publish latency matches the Cloudflare Cron Trigger cadence instead of lagging up to five minutes when no plugin cron is due.

### Patch Changes

- [#1307](https://github.com/emdash-cms/emdash/pull/1307) [`cedfcc5`](https://github.com/emdash-cms/emdash/commit/cedfcc527d47131baaa5dcfb29fb7b4a966265d5) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Read `?locale=` in content write routes (DELETE, publish, unpublish, discard-draft, schedule, unschedule) and forward it to `handleContentGet` for locale-aware slug resolution ([#1242](https://github.com/emdash-cms/emdash/issues/1242))

- [#1420](https://github.com/emdash-cms/emdash/pull/1420) [`c63f9ca`](https://github.com/emdash-cms/emdash/commit/c63f9ca56a8fc0cf4e1843887291fee0d78d89a2) Thanks [@swissky](https://github.com/swissky)! - `getTaxonomyTerms()` now returns the term `description` for flat
  (non-hierarchical) taxonomies ([#1419](https://github.com/emdash-cms/emdash/issues/1419))

  The query already fetched the `data` column, but the non-hierarchical branch
  dropped it when mapping rows to `TaxonomyTerm` — only hierarchical taxonomies
  (via `buildTree`) parsed the description. Descriptions set in the admin UI are
  now returned for both kinds of taxonomies.

- [#1426](https://github.com/emdash-cms/emdash/pull/1426) [`61ea3c9`](https://github.com/emdash-cms/emdash/commit/61ea3c9fee5b0f11974895a278d8297c56abec0b) Thanks [@MA2153](https://github.com/MA2153)! - Fix seed CLI hardcoding `en` as the default locale ([#1421](https://github.com/emdash-cms/emdash/issues/1421))

  `emdash export-seed` now emits a top-level `defaultLocale` for single-locale
  projects, and `emdash seed` (`applySeed`) honors it when backfilling the locale
  of menus, taxonomies, and content rows that omit an explicit `locale`. Previously
  an `export-seed` → `seed` round-trip silently rewrote a non-`en` default locale
  (e.g. `de`) to `en`, since the CLI runs outside the Astro runtime and the
  fallback collapsed to `en`. Projects whose default locale is `en` are unaffected.

- [#1445](https://github.com/emdash-cms/emdash/pull/1445) [`a4c2af2`](https://github.com/emdash-cms/emdash/commit/a4c2af20ee27fef891290a442f7a20d4db64600d) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix `getEmDashEntry` / `getEmDashCollection` hydrating taxonomy terms in the request-context or default locale instead of the entry's resolved locale ([#1441](https://github.com/emdash-cms/emdash/issues/1441)). When querying with an explicit `locale` (or via a localized route), `entry.data.terms` could return default-locale term variants even though the content row was correctly localized. Term hydration now uses the same resolved locale as the content query.

- Updated dependencies [[`e96587f`](https://github.com/emdash-cms/emdash/commit/e96587f8ff393939355d3d643a322fe7b2c07c86), [`cedfcc5`](https://github.com/emdash-cms/emdash/commit/cedfcc527d47131baaa5dcfb29fb7b4a966265d5), [`7e70abc`](https://github.com/emdash-cms/emdash/commit/7e70abcc1434dc2fd94c1f51c8c8c76acc9aa536), [`783e663`](https://github.com/emdash-cms/emdash/commit/783e66365d5800e01ab445cbb411237240ff2ab4), [`157237d`](https://github.com/emdash-cms/emdash/commit/157237d6b3db0301f059534c9390bdef0a02b0cf)]:
  - @emdash-cms/admin@0.19.0
  - @emdash-cms/auth@0.19.0
  - @emdash-cms/gutenberg-to-portable-text@0.19.0

## 0.18.0

### Patch Changes

- [#1391](https://github.com/emdash-cms/emdash/pull/1391) [`8a766b8`](https://github.com/emdash-cms/emdash/commit/8a766b876117bbb2b7a2179615e83666cdc769e8) Thanks [@mvvmm](https://github.com/mvvmm)! - Add `fetchpriority="high"` to priority EmDash images so above-the-fold images can be requested eagerly and prioritized by the browser.

- [#1405](https://github.com/emdash-cms/emdash/pull/1405) [`bdabff7`](https://github.com/emdash-cms/emdash/commit/bdabff7e4b5fb699ef25002508b7edd3ed184061) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixed a bug where a visitor disconnecting at the wrong moment during a cold start could leave that server instance permanently broken: every subsequent request to it would hang until the platform timed it out (a 524 error on Cloudflare, after 100 seconds), and the instance stayed broken until it was recycled. Sites no longer get stuck — startup now recovers automatically, and in the worst case a request fails fast with an error instead of hanging.

- [#1408](https://github.com/emdash-cms/emdash/pull/1408) [`afc065c`](https://github.com/emdash-cms/emdash/commit/afc065c12e6b9a19c30d2cf179fd1ba9667c5b17) Thanks [@ascorbic](https://github.com/ascorbic)! - Faster cold starts. The first request a fresh server instance handles — after a deploy, or when traffic picks up again after a quiet spell — now runs its startup steps concurrently instead of one at a time, shaving database and storage round trips off that first page load. Especially noticeable on Cloudflare, where new instances spin up frequently.

- [#1409](https://github.com/emdash-cms/emdash/pull/1409) [`7ee9467`](https://github.com/emdash-cms/emdash/commit/7ee94677193fb8dd39b87a23b69883f7055ab296) Thanks [@ascorbic](https://github.com/ascorbic)! - Pages render with fewer database round trips:
  - Tag and category archive pages load faster — `getTerm()` fetches its details in parallel instead of one query at a time.
  - Pages with several menus (header, footer, …) no longer repeat the same lookup for each menu.
  - Entries fetched with `getEmDashEntry`/`getEmDashCollection` already include their taxonomy terms — you can now read `entry.data.terms?.tag` directly (it's typed in your generated `emdash-env.d.ts`) instead of making a separate `getEntryTerms()` call. The bundled templates have been updated to do this.

- [#1407](https://github.com/emdash-cms/emdash/pull/1407) [`f9362d7`](https://github.com/emdash-cms/emdash/commit/f9362d7a89db14420a4a8f7af4e6568f15905ea7) Thanks [@ascorbic](https://github.com/ascorbic)! - Query instrumentation (`EMDASH_QUERY_LOG=1`) now captures the whole request, not just the part before the response headers are sent. Queries issued by components while the page is still streaming were previously invisible to the Server-Timing numbers; a final `[emdash-stream-end]` log line now reports the complete query count, database time, and cache hits for each request, so you can see where a slow page really spends its time. No effect when instrumentation is off.

- Updated dependencies [[`d2829e3`](https://github.com/emdash-cms/emdash/commit/d2829e36c0e568db4ec92f500b166e03f0c36973)]:
  - @emdash-cms/admin@0.18.0
  - @emdash-cms/auth@0.18.0
  - @emdash-cms/gutenberg-to-portable-text@0.18.0

## 0.17.2

### Patch Changes

- [#1356](https://github.com/emdash-cms/emdash/pull/1356) [`4e11daa`](https://github.com/emdash-cms/emdash/commit/4e11daaaf7c07b20903527626391e31799675da8) Thanks [@ascorbic](https://github.com/ascorbic)! - Scope Postgres table/column introspection to the connection's active schema instead of hardcoding `public`. `tableExists` and `listTablesLike` (`database/dialect-helpers.ts`) and two idempotency checks in the `019_i18n` migration queried `information_schema` with `table_schema = 'public'`, so a Postgres deployment using a non-public schema (per-tenant or shared-cluster setups) would see tables from the wrong schema or none at all, causing collection/schema operations to misbehave and the i18n migration to skip its column additions. These now use `current_schema()`, matching the already-correct `indexExists`/`columnExists` helpers and migration `038`.

- [#1167](https://github.com/emdash-cms/emdash/pull/1167) [`fe6bc78`](https://github.com/emdash-cms/emdash/commit/fe6bc78e74ecbc41bcae495e070eec9f25e23da2) Thanks [@abhishekshankar](https://github.com/abhishekshankar)! - fix(seo): buildMediaUrl handles root-relative paths without doubling the API prefix

- [#1345](https://github.com/emdash-cms/emdash/pull/1345) [`80f2925`](https://github.com/emdash-cms/emdash/commit/80f2925bfbc5f4418363c499c36e0a1c1af04242) Thanks [@scottbuscemi](https://github.com/scottbuscemi)! - Fix frontend pages redirecting to `/_emdash/admin/setup` on a fully set-up site. The anonymous fast-path "setup probe" in the Astro middleware queries `_emdash_migrations` to detect a fresh, un-migrated database, but its `catch` block treated **every** error as "fresh install" — so a transient DB failure (D1 connection loss, replica unavailable, query timeout, cold-start race, locked SQLite) wrongly bounced real visitors to the setup wizard. The probe now only redirects when the error is a genuinely-missing table (via the shared `isMissingTableError` helper) and otherwise renders the page normally. The `setupVerified` flag is also moved onto a `globalThis` `Symbol.for` singleton so it isn't duplicated across SSR chunks, which had caused the probe to re-run far more often than intended (and each re-run was another chance to hit the bug).

- Updated dependencies [[`4ee75f8`](https://github.com/emdash-cms/emdash/commit/4ee75f851da4461a599f892c820152377625ef70)]:
  - @emdash-cms/admin@0.17.2
  - @emdash-cms/auth@0.17.2
  - @emdash-cms/gutenberg-to-portable-text@0.17.2

## 0.17.1

### Patch Changes

- [#1328](https://github.com/emdash-cms/emdash/pull/1328) [`149fc49`](https://github.com/emdash-cms/emdash/commit/149fc4904326174075d100ccb4f203b2a250ec64) Thanks [@MA2153](https://github.com/MA2153)! - Fix `emdash export-seed` omitting bylines. The exporter now emits byline profiles as the root `bylines[]` array (one entry per translation group, since `SeedByline` has no locale axis) and, when content is exported, attaches each entry's ordered byline credits as `bylines[]` referencing those profiles. Credits are read straight from `_emdash_content_bylines` (whose `byline_id` already stores the translation group), so the exported seed round-trips back through `applySeed` with profiles and credits intact.

- [#1336](https://github.com/emdash-cms/emdash/pull/1336) [`64d5675`](https://github.com/emdash-cms/emdash/commit/64d56759250016fb4bfb2a2ab83106407ffd61a7) Thanks [@ascorbic](https://github.com/ascorbic)! - Pre-bundle EmDash's auth, MCP, and admin-shell dependencies so `astro dev` on Cloudflare no longer triggers a re-optimize + full-reload cascade on the first authenticated/admin/MCP request.

  These deps (`@oslojs/crypto/{hmac,subtle,rsa}`, `arctic`, the MCP server entrypoints, `@lingui/react`, `@cloudflare/kumo/primitives`, `astro/assets/services/noop`) are only imported on routes the initial Vite scan never reaches, so the workerd runtime discovered them one at a time. Each discovery invalidated the optimize cache mid-flight, producing `The file does not exist at ".../deps_ssr/chunk-*.js"` errors and repeated full reloads on cold start. Adding them to the Cloudflare SSR `optimizeDeps.include` list front-loads them into a single startup optimize pass.

- [#1331](https://github.com/emdash-cms/emdash/pull/1331) [`77fff0a`](https://github.com/emdash-cms/emdash/commit/77fff0a36cd4d6dc242c1d8dd58934ca14cd6dbd) Thanks [@MA2153](https://github.com/MA2153)! - Fix `emdash export-seed` collapsing locale variants into duplicate seed ids on i18n projects. The CLI never initializes the runtime i18n config, so `isI18nEnabled()` was always `false` and the exporter stripped the `:locale` suffix from taxonomy, menu, and content seed ids — merging every locale variant into one bare id and producing duplicates that `validateSeed` rejected. The exporter now derives locale-awareness from the data (a project is multi-locale when its i18n-aware tables hold more than one distinct locale), so multi-locale exports keep their per-locale suffixes and `translationOf` links while genuinely single-locale projects still export bare ids.

- [#1340](https://github.com/emdash-cms/emdash/pull/1340) [`87c40d3`](https://github.com/emdash-cms/emdash/commit/87c40d34b3a0130f67bf7d31caf40572f14135e6) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fix `getEmDashCollection` pagination losing `nextCursor` with Astro 6 live collections. Astro's `getLiveCollection` repacks loader results and drops the `nextCursor` field before it reaches the caller. The wrapper now over-fetches by one entry whenever a `limit` is provided, slices the extra row locally, and synthesizes `nextCursor` via the existing `encodeEntryCursor` helper — matching the strategy already used by the bucketing path.

- Updated dependencies [[`83daa41`](https://github.com/emdash-cms/emdash/commit/83daa4149ed0d1ccf23d9f90304ef6ba3545d46f), [`dfabafe`](https://github.com/emdash-cms/emdash/commit/dfabafeb5db9c27c861015e7d426eb40d6ed940a)]:
  - @emdash-cms/admin@0.17.1
  - @emdash-cms/auth@0.17.1
  - @emdash-cms/gutenberg-to-portable-text@0.17.1

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

- [#1298](https://github.com/emdash-cms/emdash/pull/1298) [`cd2dcc6`](https://github.com/emdash-cms/emdash/commit/cd2dcc6a56d19f38d6e13ba55e8563ceaab90ef8) Thanks [@ascorbic](https://github.com/ascorbic)! - Byline hydration now resolves the author avatar's storage key in the same query. `getEmDashCollection` / `getEmDashEntry` populate `entry.data.bylines[].byline.avatarStorageKey` (and `avatarAlt`) via a `LEFT JOIN` on the media table, so list pages can build a direct avatar URL without a per-byline `MediaRepository.findById`. Previously the byline summary exposed only `avatarMediaId` (a bare ULID with no file extension), forcing sites that want direct storage URLs into an N+1 media lookup. A page rendering 20 posts by distinct authors paid ~20 extra queries. The new fields are additive and null on the plain byline finders (`findById`, `findBySlug`), which do not join media; rely on the content-credit hydration path for them.

- [#1197](https://github.com/emdash-cms/emdash/pull/1197) [`62c170f`](https://github.com/emdash-cms/emdash/commit/62c170f11403d76370d6c89f8fa25b0bbcf003fd) Thanks [@scottbuscemi](https://github.com/scottbuscemi)! - Persist welcome-dismissed flag in database instead of session. Previously the welcome modal would be shown every time a user logged-in.

- [#1295](https://github.com/emdash-cms/emdash/pull/1295) [`ee67273`](https://github.com/emdash-cms/emdash/commit/ee67273df089d7ed858542fb0df16650f80cbb15) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - fix(core/redirects): match exact redirects regardless of trailing slash ([#1271](https://github.com/emdash-cms/emdash/issues/1271))

  Exact redirect rules now match requests with or without a trailing slash. A redirect stored with source `/old/` will also match a request for `/old`, and a redirect stored with source `/old` will also match `/old/`. The stored source is preserved unchanged; the fallback happens at lookup time.

- [#1226](https://github.com/emdash-cms/emdash/pull/1226) [`9422d6a`](https://github.com/emdash-cms/emdash/commit/9422d6a744b17f477a3966c3c7e07a087a3345e6) Thanks [@scottbuscemi](https://github.com/scottbuscemi)! - Make content list search work on large collections ([#1219](https://github.com/emdash-cms/emdash/issues/1219)). The admin content list previously filtered only the rows already loaded on the current page, so an entry far back in a big collection could not be found until you navigated near it. The list endpoint now accepts a `q` parameter and performs a case-insensitive substring search across the collection's title/name/slug columns server-side (LIKE wildcards in the query are escaped), and the admin search box drives that query (debounced) instead of filtering in memory. Also adds locale-aware composite indexes (`idx_{table}_loc_upd` / `idx_{table}_loc_crt`) so locale-filtered content lists stay index-served on large, i18n-enabled tables.

- [#1302](https://github.com/emdash-cms/emdash/pull/1302) [`1f8190d`](https://github.com/emdash-cms/emdash/commit/1f8190d2dee2f93a0a64ddfbe4f481cb6892ce2b) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Fixes locale-aware content updates so REST, CLI, client, and MCP callers can safely update content by slug when multiple locales share the same slug.

- [#1224](https://github.com/emdash-cms/emdash/pull/1224) [`67f5992`](https://github.com/emdash-cms/emdash/commit/67f5992aec23d02c724505632ce951e5b7af9cdb) Thanks [@scottbuscemi](https://github.com/scottbuscemi)! - Fix taxonomy terms not being locale-aware in the content editor ([#1218](https://github.com/emdash-cms/emdash/issues/1218)). Term assignments are stored against the per-locale content row while the term's `translation_group` spans every locale, so resolving terms for an entry must scope to the entry's locale. The content terms endpoint (`/content/:collection/:id/terms/:taxonomy`) now derives the entry's locale server-side and passes it to `getTermsForEntry`, and the admin `TaxonomySidebar` threads the entry locale through its fetch/save calls (and into its React Query keys, so switching translations refetches). Previously a localized post showed and applied every locale variant of a tag instead of just the variant for its own locale.

- [#1227](https://github.com/emdash-cms/emdash/pull/1227) [`a40e455`](https://github.com/emdash-cms/emdash/commit/a40e455a8de730a61291798a3fe0ee32dde24ed0) Thanks [@scottbuscemi](https://github.com/scottbuscemi)! - Add search and filtering to the media library ([#1221](https://github.com/emdash-cms/emdash/issues/1221)). The media list endpoint now accepts a `q` parameter for a case-insensitive filename substring search (which also matches extensions, with LIKE wildcards escaped), alongside the existing `mimeType` filter. The Media Library page gains a filename search box and a type filter (images / video / audio / documents), and the media picker in the content editor now searches the local library by filename too. Previously neither surface could search or filter local media, which made large libraries hard to navigate.

- [#1319](https://github.com/emdash-cms/emdash/pull/1319) [`69bdc97`](https://github.com/emdash-cms/emdash/commit/69bdc97e3e4b69a111b3e5210900e23f35134f8d) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix `require is not defined` crash on every EmDash API route under `astro dev` on Cloudflare Workers ([#1292](https://github.com/emdash-cms/emdash/issues/1292)).

  `@emdash-cms/registry-client` listed `semver` (CommonJS) in `dependencies`, which the build externalizes -- so consumers loaded a nested CJS copy. Vite's SSR module runner (workerd) evaluates modules with no `require` binding, so semver's internal `require()` threw and took down any route whose import graph reached registry-client (schema, plugins, env compatibility checks). semver is now bundled into the ESM output, so nothing CommonJS reaches the worker.

- [#1285](https://github.com/emdash-cms/emdash/pull/1285) [`5e7f835`](https://github.com/emdash-cms/emdash/commit/5e7f83571dbc4832e91881aafbb470407c19b482) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix SEO fields (noindex toggle, canonical URL) not affecting rendered pages. The content loader now surfaces per-entry SEO metadata on `entry.data.seo`, so `getSeoMeta()` reflects values set in the admin SEO panel. SEO is folded into the existing entry query via a LEFT JOIN, adding no extra database round-trips.

- [#1298](https://github.com/emdash-cms/emdash/pull/1298) [`cd2dcc6`](https://github.com/emdash-cms/emdash/commit/cd2dcc6a56d19f38d6e13ba55e8563ceaab90ef8) Thanks [@ascorbic](https://github.com/ascorbic)! - Seed files can now attach an avatar to a byline. `bylines[].avatar` takes a `storageKey` (plus optional `alt`, `filename`, `mimeType`, `width`, `height`) for a file that already exists in the configured storage; applying the seed creates a `media` row and links it to the byline via `avatarMediaId`. Unlike a content `$media` reference, nothing is downloaded or uploaded, which suits seeding bylines alongside a media migration.

- Updated dependencies [[`cccf4f2`](https://github.com/emdash-cms/emdash/commit/cccf4f2b40451efa724136e815158ebca189a135), [`28432b9`](https://github.com/emdash-cms/emdash/commit/28432b9b5a045c9227d59f7762bf9cb37067a950), [`886f2d1`](https://github.com/emdash-cms/emdash/commit/886f2d1e4969403787cc39dfbda6dcdfe034372c), [`a5dafb3`](https://github.com/emdash-cms/emdash/commit/a5dafb32b75358c96be5f2a2487bf323a0045bb8), [`9422d6a`](https://github.com/emdash-cms/emdash/commit/9422d6a744b17f477a3966c3c7e07a087a3345e6), [`67f5992`](https://github.com/emdash-cms/emdash/commit/67f5992aec23d02c724505632ce951e5b7af9cdb), [`a40e455`](https://github.com/emdash-cms/emdash/commit/a40e455a8de730a61291798a3fe0ee32dde24ed0), [`69bdc97`](https://github.com/emdash-cms/emdash/commit/69bdc97e3e4b69a111b3e5210900e23f35134f8d), [`34afc14`](https://github.com/emdash-cms/emdash/commit/34afc1448440f8ffab956f096322d67ec42127cb), [`590b2f9`](https://github.com/emdash-cms/emdash/commit/590b2f97367d6881d8c59e5f0a88e7ad69138acb), [`019d9e4`](https://github.com/emdash-cms/emdash/commit/019d9e44c5331d92abad78d7f9abfe2aefa4d1fe), [`ba0f3d4`](https://github.com/emdash-cms/emdash/commit/ba0f3d4f1d13d30d540895225556560bee176026), [`aacdf20`](https://github.com/emdash-cms/emdash/commit/aacdf207b6e31b98debacf12d52138d74371869f), [`7d55db6`](https://github.com/emdash-cms/emdash/commit/7d55db6ca3291eac1c2cfda865e1b0e507fdece5)]:
  - @emdash-cms/admin@0.17.0
  - @emdash-cms/registry-client@0.3.1
  - @emdash-cms/auth@0.17.0
  - @emdash-cms/gutenberg-to-portable-text@0.17.0

## 0.16.1

### Patch Changes

- Updated dependencies [[`2c36d55`](https://github.com/emdash-cms/emdash/commit/2c36d5514f317d5c01a19def93956922d3b0557c), [`930d23b`](https://github.com/emdash-cms/emdash/commit/930d23bb0e3c3a860904996ef7ddd6c239572203)]:
  - @emdash-cms/admin@0.16.1
  - @emdash-cms/auth@0.16.1
  - @emdash-cms/gutenberg-to-portable-text@0.16.1

## 0.16.0

### Minor Changes

- [#1195](https://github.com/emdash-cms/emdash/pull/1195) [`47a8350`](https://github.com/emdash-cms/emdash/commit/47a83502fef22d837eb1269ac107858c59cb13e3) Thanks [@ascorbic](https://github.com/ascorbic)! - The per-collection sitemap (`/sitemap-{collection}.xml`) is now i18n-aware. When Astro i18n is enabled, each translation row is emitted as its own `<url>` with the correct locale prefix (resolved via Astro's own `getRelativeLocaleUrl`, so `prefixDefaultLocale` and custom `path` mappings are honoured). Every entry also lists its sibling translations as `<xhtml:link rel="alternate" hreflang="...">` (plus `x-default` for the default-locale variant), grouped by `translation_group`. Sites with a single locale or no i18n configured are unaffected -- their sitemap XML is unchanged.

- [#1238](https://github.com/emdash-cms/emdash/pull/1238) [`60c0b2e`](https://github.com/emdash-cms/emdash/commit/60c0b2eeab7726471b313d0c453de82df1e08558) Thanks [@ascorbic](https://github.com/ascorbic)! - Registry plugins can now declare environment requirements. A plugin's manifest may set a release-level `requires` block (e.g. `{ "env:emdash": ">=1.0.0", "env:astro": ">=4.16" }`), which is published into the release record. When browsing a registry plugin, the admin compares those constraints against the running EmDash and Astro versions: if the host doesn't satisfy them, it shows a compatibility warning and disables the Install button. The server enforces the same check on install and update, refusing an incompatible release with `ENV_INCOMPATIBLE` so the gate can't be bypassed.

- [#1239](https://github.com/emdash-cms/emdash/pull/1239) [`1a4918f`](https://github.com/emdash-cms/emdash/commit/1a4918ff989d57b4f12e44b647542e406dce7cb9) Thanks [@ascorbic](https://github.com/ascorbic)! - Plugins published to the experimental registry can now ship icon, screenshot, and banner images. Declare them in `emdash-plugin.jsonc` under `release.artifacts` as file refs; `emdash-plugin publish --artifact-base-url <url>` measures each image's dimensions, uploads it, and records it in the release. The admin plugin detail page renders the icon, banner, and a screenshot gallery, fetched through a server-side image proxy. The proxy resolves each artifact's URL server-side from the validated release record (the client sends only the artifact's coordinates, never a URL), then applies SSRF defences and an image content-type allowlist before serving the bytes. Supported image types are PNG, JPEG, WebP, GIF, and AVIF; SVG is rejected at both publish and proxy because it is active content.

- [#1064](https://github.com/emdash-cms/emdash/pull/1064) [`33f76b8`](https://github.com/emdash-cms/emdash/commit/33f76b863542a5d040f0e3882cab036e1a410eca) Thanks [@Glacier-Luo](https://github.com/Glacier-Luo)! - Adds field-level and range filtering to `getEmDashCollection`'s `where` option. Previously, only taxonomy-based keys were processed via JOIN; non-taxonomy field names were silently discarded. Now the `where` clause supports exact match (`string`), multi-value match (`string[]`), and range comparisons (`{ gt?, gte?, lt?, lte? }`) on any content table column, all executed at the SQL layer with parameterized queries.

### Patch Changes

- [#1159](https://github.com/emdash-cms/emdash/pull/1159) [`e312528`](https://github.com/emdash-cms/emdash/commit/e312528c4560946a43e2e65bd5617733cd98ea75) Thanks [@jp-knj](https://github.com/jp-knj)! - Fix scheduled posts missing from snapshot export on SQLite/D1 until UTC midnight.

- [#1166](https://github.com/emdash-cms/emdash/pull/1166) [`668c5e1`](https://github.com/emdash-cms/emdash/commit/668c5e1a9d2465d1d255ac00375b3d49d67538ba) Thanks [@OrangeManLi](https://github.com/OrangeManLi)! - Fixes `portableTextToProsemirror` flattening nested lists whose subtree mixes `listItem` types. The outer run-grouping broke on the first nested type switch (e.g. an `orderedList` child under a `bulletList` parent), so an input like `[bullet L1, number L2, bullet L1]` was emitted as three separate top-level lists instead of one bullet list with a numbered sub-list under the first item. Internal `convertList`/`convertListItem` recursion was already correct — only the outer grouping needed to be widened to include `level > 1` blocks regardless of `listItem` type.

- [#1160](https://github.com/emdash-cms/emdash/pull/1160) [`f62c004`](https://github.com/emdash-cms/emdash/commit/f62c0042a2ded0265aed1157054c7326beb125ac) Thanks [@CacheMeOwside](https://github.com/CacheMeOwside)! - Fixes Postgres server bundles importing `better-sqlite3`, which crashed production starts (`pnpm preview`, `pnpm start`) with `ERR_MODULE_NOT_FOUND` because the SQLite driver is not installed in Postgres-only deployments. Moved `EmDashDatabaseError` into a new SQLite driver-free `database/errors.ts` and re-exported it from there, so the `better-sqlite3` import doesn't leak into the Postgres build.

- [#985](https://github.com/emdash-cms/emdash/pull/985) [`5456514`](https://github.com/emdash-cms/emdash/commit/54565143205035e475dabb16075e09ade046a74c) Thanks [@ppppangu](https://github.com/ppppangu)! - Fixes public form embeds during SSR by allowing frontend plugin components to call public plugin routes without self-fetching.

- [#1157](https://github.com/emdash-cms/emdash/pull/1157) [`7554bd3`](https://github.com/emdash-cms/emdash/commit/7554bd3ba81477383d2616df209050cb29e6ad17) Thanks [@jp-knj](https://github.com/jp-knj)! - Fix scheduled posts not appearing on SQLite/D1 until UTC midnight.

- [#1196](https://github.com/emdash-cms/emdash/pull/1196) [`e9877e1`](https://github.com/emdash-cms/emdash/commit/e9877e15e4e4ab6906f06342d3e1dbe4532a8acc) Thanks [@Rimander](https://github.com/Rimander)! - Fix WordPress import leaving `featured_image` (and other image/file fields) pointing at the original WordPress URL after media download. The rewrite step passed the whole stored MediaValue JSON to the URL matcher instead of its inner `src`, so the field was never rewritten to the local R2 URL even though the file existed in the media table. Inline content images were unaffected.

- Updated dependencies [[`62619c2`](https://github.com/emdash-cms/emdash/commit/62619c2d7eeb0ea1ff4178ec4090c2872df51073), [`3d540da`](https://github.com/emdash-cms/emdash/commit/3d540daf4b2c89c408038ae55799e2513c1ef9c9), [`b89e988`](https://github.com/emdash-cms/emdash/commit/b89e988da2a930450ae237ae55b2594bbf395770), [`4612749`](https://github.com/emdash-cms/emdash/commit/4612749770dba13ac6e01e8953854f318b9913dd), [`60c0b2e`](https://github.com/emdash-cms/emdash/commit/60c0b2eeab7726471b313d0c453de82df1e08558), [`1a4918f`](https://github.com/emdash-cms/emdash/commit/1a4918ff989d57b4f12e44b647542e406dce7cb9), [`d2f2679`](https://github.com/emdash-cms/emdash/commit/d2f26792bc8f053693bfb0a6a9d65a7403753f0a)]:
  - @emdash-cms/admin@0.16.0
  - @emdash-cms/registry-client@0.3.0
  - @emdash-cms/auth@0.16.0
  - @emdash-cms/gutenberg-to-portable-text@0.16.0

## 0.15.0

### Minor Changes

- [#426](https://github.com/emdash-cms/emdash/pull/426) [`02ed8ba`](https://github.com/emdash-cms/emdash/commit/02ed8ba32ef1f4301d84465b934430eee08eef74) Thanks [@BenjaminPrice](https://github.com/BenjaminPrice)! - Adds workerd-based plugin sandboxing for Node.js deployments.
  - **emdash**: Adds `isHealthy()` to `SandboxRunner` interface, `SandboxUnavailableError` class, `sandbox: false` config option, `mediaStorage` field on `SandboxOptions`, and exports `createHttpAccess`/`createUnrestrictedHttpAccess`/`PluginStorageRepository`/`UserRepository`/`OptionsRepository` for platform adapters.
  - **@emdash-cms/cloudflare**: Implements `isHealthy()` on `CloudflareSandboxRunner`. Fixes `storageQuery()` and `storageCount()` to honor `where`, `orderBy`, and `cursor` options (previously ignored, causing infinite pagination loops and incorrect filtered counts). Adds `storageConfig` to `PluginBridgeProps` so `PluginStorageRepository` can use declared indexes.
  - **@emdash-cms/sandbox-workerd**: New package. `WorkerdSandboxRunner` for production (workerd child process + capnp config + authenticated HTTP backing service) and `MiniflareDevRunner` for development.

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

- [#1139](https://github.com/emdash-cms/emdash/pull/1139) [`88f544d`](https://github.com/emdash-cms/emdash/commit/88f544db4b8e2f30060a3b4d670ff72aa8760d61) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Upgrades `kysely` to `^0.29.0` (was `^0.27.0`) to resolve three high-severity advisories fixed in `>=0.28.17`:
  - GHSA-wmrf-hv6w-mr66 – SQL injection via unsanitized JSON path keys
  - GHSA-pv5w-4p9q-p3v2 – JSON-path traversal injection via `JSONPathBuilder.key()` / `.at()`
  - GHSA-8cpq-38p9-67gx – MySQL SQL injection via `sql.lit(string)`

  Also updates import paths for `Migrator` and `Migration` types to `kysely/migration` to comply with kysely 0.29 export changes.

- Updated dependencies [[`cf3c706`](https://github.com/emdash-cms/emdash/commit/cf3c706a65087696eb6cca5844b7668a50e4a090), [`b9cc08e`](https://github.com/emdash-cms/emdash/commit/b9cc08e7556ccdbcbbcea6d3c06cae6abef18766), [`11b3001`](https://github.com/emdash-cms/emdash/commit/11b300100e066c6b3463070a9b65fba868f37e9b), [`fae97ee`](https://github.com/emdash-cms/emdash/commit/fae97ee5465934365864557e9fa3ee8754cfd49c), [`88f544d`](https://github.com/emdash-cms/emdash/commit/88f544db4b8e2f30060a3b4d670ff72aa8760d61), [`393dd26`](https://github.com/emdash-cms/emdash/commit/393dd26fd4e6fc38ed2584cbb5f29d5f69fb1dad), [`9a30607`](https://github.com/emdash-cms/emdash/commit/9a30607791a2f27473b1d2fe7700291e0be1ea1c), [`d0ff94b`](https://github.com/emdash-cms/emdash/commit/d0ff94bd476e7fd4b5d18c94904cfb5c071fea92)]:
  - @emdash-cms/registry-client@0.2.0
  - @emdash-cms/admin@0.15.0
  - @emdash-cms/auth-atproto@0.2.8
  - @emdash-cms/auth@0.15.0
  - @emdash-cms/gutenberg-to-portable-text@0.15.0

## 0.14.0

### Patch Changes

- [#1100](https://github.com/emdash-cms/emdash/pull/1100) [`f753dba`](https://github.com/emdash-cms/emdash/commit/f753dba340dca791d4cf34a78c29ed6a0d552cd4) Thanks [@jcheese1](https://github.com/jcheese1)! - Resolve bare local media IDs in media fields before falling back to external URLs.

- [#1101](https://github.com/emdash-cms/emdash/pull/1101) [`e539731`](https://github.com/emdash-cms/emdash/commit/e539731451994206bf60824a31815a8a925c7252) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes experimental registry navigation and allows the configured registry aggregator through the admin CSP.

- [#1112](https://github.com/emdash-cms/emdash/pull/1112) [`3756168`](https://github.com/emdash-cms/emdash/commit/37561682224447c7280648dc770ab408afc4186a) Thanks [@ascorbic](https://github.com/ascorbic)! - Validates aggregator responses at the read-side trust boundary in `DiscoveryClient`. Two layers run:
  - **Response envelope** (`uri`, `cid`, `did`, `slug`, `version`, …): `DiscoveryClient` now routes every call through `@atcute/client`'s schema-validating `.call()` against the aggregator method's output lexicon. Request params are validated too. A non-conforming envelope throws `ClientValidationError`.
  - **Embedded signed `profile` / `release` records** (typed `unknown` by the aggregator lexicon because they are relayed verbatim from publisher repos under a different lexicon namespace): now `safeParse`'d against `com.emdashcms.experimental.package.profile` / `release`. A conforming record is returned as the typed lexicon shape; a non-conforming one is surfaced as `null` so one bad record doesn't fail an entire search page.

  Refines the return types from `unknown` to `PackageProfile.Main | null` / `PackageRelease.Main | null` (new exported `ValidatedPackageView` / `ValidatedReleaseView` / `ValidatedSearchPackages` / `ValidatedListReleases` types). Callers must null-check. The registry install handler now fails closed when the aggregator returns a release record that does not conform to its lexicon.

  Validation is structural only — the lexicon's `uri` format permits non-HTTP schemes, so UI rendering these URLs still applies its own scheme allow-list.

- Updated dependencies [[`cf85941`](https://github.com/emdash-cms/emdash/commit/cf85941c1c631d355ca4df216e790ecf75420bbe), [`3756168`](https://github.com/emdash-cms/emdash/commit/37561682224447c7280648dc770ab408afc4186a), [`3756168`](https://github.com/emdash-cms/emdash/commit/37561682224447c7280648dc770ab408afc4186a)]:
  - @emdash-cms/admin@0.14.0
  - @emdash-cms/registry-client@0.1.0
  - @emdash-cms/auth@0.14.0
  - @emdash-cms/gutenberg-to-portable-text@0.14.0
  - @emdash-cms/auth-atproto@0.2.7

## 0.13.0

### Minor Changes

- [#1057](https://github.com/emdash-cms/emdash/pull/1057) [`c0ce915`](https://github.com/emdash-cms/emdash/commit/c0ce915c555b8658245d465255e2ec89b361c57f) Thanks [@ascorbic](https://github.com/ascorbic)! - **BREAKING (plugin authors):** Reworks how sandboxed plugins are defined. The `definePlugin()` helper is removed for sandboxed-format plugins; the new shape is a bare default export with a `satisfies SandboxedPlugin` annotation. A new type-only subpath `emdash/plugin` provides the types.

  This affects anyone _writing_ a sandboxed plugin. Sites that _use_ plugins are unaffected (see the per-plugin changesets for the import-shape change in published plugins).

  ```diff
  - import { definePlugin, type ContentHookEvent, type PluginContext } from "emdash";
  + import type { SandboxedPlugin } from "emdash/plugin";

  - export default definePlugin({
  + export default {
       hooks: {
           "content:beforeSave": {
  -			handler: async (event: ContentHookEvent, ctx: PluginContext) => {
  +			handler: async (event, ctx) => {
                   // ...
                   return event.content;
               },
           },
       },
  - });
  + } satisfies SandboxedPlugin;
  ```

  Three changes:
  1. **Drop `import { definePlugin } from "emdash"`** and the `definePlugin(...)` wrapping call. Sandboxed plugins now default-export the bare object.
  2. **`import type { SandboxedPlugin } from "emdash/plugin"`** and add `satisfies SandboxedPlugin` to the default export. The `emdash/plugin` subpath is type-only — the bundler erases the import, so no runtime resolution of `emdash` is needed (and the heavy `emdash` runtime no longer enters the plugin bundle).
  3. **Drop handler parameter annotations** like `event: ContentSaveEvent, ctx: PluginContext`. The strict mapped type on `SandboxedPlugin` infers them per hook name, with the full canonical event type. If you need to reference an event type by name (e.g. in a helper function), `emdash/plugin` re-exports them: `import type { ContentHookEvent, PluginContext } from "emdash/plugin"`.

  **Why:** the old `definePlugin` was an identity function whose only job was to alias `emdash` to a Proxy shim at build time so the import would resolve. With the new shape, sandboxed plugins have _no_ runtime `emdash` import — only type-only imports from `emdash/plugin`. The bundler doesn't need to alias anything; the build pipeline is simpler; and authors get strict per-hook event/return type inference for free.

  The trade-off: previously you could narrow an event type locally (e.g. `interface ContentSaveEvent { content: ... & { id: string } }`). Under the strict mapped type, the canonical event type wins (TypeScript's contravariance on function parameters means narrowing isn't assignable). Authors validate fields at runtime with `typeof` / `isRecord` checks instead — which is the right pattern for input that comes from outside the type system anyway.

  **Routes** follow the same simplification. The two-arg `(routeCtx, ctx)` shape is unchanged; only the annotations disappear:

  ```ts
  export default {
  	routes: {
  		health: async (routeCtx, ctx) => {
  			// routeCtx: SandboxedRouteContext, ctx: PluginContext — both inferred.
  			return new Response("ok");
  		},
  	},
  } satisfies SandboxedPlugin;
  ```

  `SandboxedRouteContext` exposes `{ input, request, requestMeta? }`. `request` is typed as `SandboxedRequest` — a `{ url, method, headers }` record that's portable across in-process and isolate execution (Worker Loader can't pass real `Request` objects across the boundary).

  **Native plugins are unaffected.** This change applies only to sandboxed-format plugins. Native plugins continue to use `definePlugin()` from `emdash` and the existing `PluginDefinition` shape.

  **Type rename:** `SandboxedPlugin` on the `emdash` package now refers to the new author-facing source-shape type. The runtime-side handle type (returned by `SandboxRunner.load`, held in the runtime's plugin cache) is renamed to `SandboxedPluginInstance`. If you import `SandboxedPlugin` from `emdash` to type a sandbox runner implementation or hold runtime plugin handles, update those imports to `SandboxedPluginInstance`. Public consumers of this type are mostly limited to `@emdash-cms/cloudflare` and other sandbox runner adapters; standard plugin / site code is unaffected.

  **Removed types:** `StandardPluginDefinition`, `StandardHookHandler`, `StandardHookEntry`, `StandardRouteHandler`, `StandardRouteEntry` are no longer exported from `emdash`. These were authoring-helper aliases under the old permissive `definePlugin` standard overload. Use `SandboxedPlugin` from `emdash/plugin` for the same purpose under the new shape.

  **Removed function:** `isStandardPluginDefinition` is gone. There's no equivalent — sandboxed plugins are identified by structure (`{ hooks?, routes? }`) and you should treat the default export as already typed via `satisfies SandboxedPlugin`.

- [#1052](https://github.com/emdash-cms/emdash/pull/1052) [`0d5843f`](https://github.com/emdash-cms/emdash/commit/0d5843fc3378936667ab81c56001349198028ebb) Thanks [@Rimander](https://github.com/Rimander)! - Fixes menu REST API consistency:
  - **`POST /menus/:name/items` no longer accepts unknown keys silently.** Sending `custom_url` (snake_case) or `url` used to return 201 with `custom_url: null` because Zod's default `.strip()` quietly dropped them. The schemas now use `.strict()` and return **400 `VALIDATION_ERROR`** with `Unrecognized key: "custom_url"`. The documented camelCase keys (`customUrl`, `sortOrder`, `referenceCollection`, etc.) are unchanged and persist as before. The `type` field is now validated against the canonical enum (`"custom" | "page" | "post" | "taxonomy" | "collection"`); previously any string passed.
  - **Moves per-item writes to `PUT` and `DELETE /menus/:name/items/:id` (path-style).** Every other EmDash resource (`content`, `taxonomies`, `redirects`, `sections`, `widget-areas`) addresses items by URL path; menus were the lone outlier requiring `?id=<id>` in the query string. The legacy query-string form is **removed** (it was undocumented and only used by the admin, which is updated in this PR). Callers should use `PUT /menus/:name/items/:id` / `DELETE /menus/:name/items/:id`.
  - **Menu and menu-item API responses are now camelCase**, aligning with the rest of EmDash's REST surface (`content`, `taxonomies`, `redirects`, …). `created_at` → `createdAt`, `updated_at` → `updatedAt`, `menu_id` → `menuId`, `parent_id` → `parentId`, `sort_order` → `sortOrder`, `reference_collection` → `referenceCollection`, `reference_id` → `referenceId`, `custom_url` → `customUrl`, `title_attr` → `titleAttr`, `css_classes` → `cssClasses`, `translation_group` → `translationGroup`. **Breaking** for direct REST consumers that depend on snake_case keys in the response body. The admin UI is already updated.
  - **Refactors menus to the standard repository pattern.** Adds `MenuRepository` next to `ContentRepository`, `TaxonomyRepository`, `RedirectRepository`, `MediaRepository`, `CommentRepository`. Handlers become thin orchestrators; the repository is now the single place where snake_case rows become camelCase entities.

  These changes do not touch any database schema or migration. Existing data is preserved.

- [#1011](https://github.com/emdash-cms/emdash/pull/1011) [`dbaea9c`](https://github.com/emdash-cms/emdash/commit/dbaea9ccaef6ac48dda14b77c6b2adbe0dc0ff38) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds experimental support for the decentralized plugin registry (see RFC #694). Configure with `experimental.registry.aggregatorUrl` in `astro.config.mjs`; the admin UI then uses the registry instead of the centralized marketplace for browse and install. Marketplace behavior is unchanged when the option is not set.

  The experimental config accepts a `policy.minimumReleaseAge` duration (e.g. `"48h"`) that holds back releases below that age from install and update prompts, with a `policy.minimumReleaseAgeExclude` allowlist for trusted publishers or specific packages. The minimum-release-age check is enforced both client-side (for UX) and server-side (in the install endpoint), so stale browser tabs and deep links still hit the gate.

### Patch Changes

- [#1076](https://github.com/emdash-cms/emdash/pull/1076) [`6e62b90`](https://github.com/emdash-cms/emdash/commit/6e62b90e14615a2012a5885849e6b1d1062e7c0b) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes spurious TypeScript errors in strict projects that consume EmDash. Several subpaths (`emdash/routes/*`, `emdash/api/route-utils`, `emdash/api/schemas`, `emdash/auth/providers/github`, `emdash/auth/providers/google`) previously shipped raw source, so your `tsc` and editor type-checked EmDash's internals against your config and could report errors that weren't yours. These now ship compiled type declarations instead. The `*-admin` providers and `emdash/ui` stay source because they bridge the admin React/Astro runtime your own build processes. Import paths and runtime behaviour are unchanged.

- [#1086](https://github.com/emdash-cms/emdash/pull/1086) [`23597d0`](https://github.com/emdash-cms/emdash/commit/23597d017360673cf95eee8e5d24c873137fc215) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes silent data loss in migration 036 on Cloudflare D1 (#1021). D1 ignores `PRAGMA foreign_keys = OFF` and its replacement `defer_foreign_keys` only defers constraint validation, it doesn't suppress CASCADE actions, so dropping any table during the i18n rebuild fired its child cascades. Three FK relationships were affected:
  - `content_taxonomies.taxonomy_id -> taxonomies(id) ON DELETE CASCADE` wiped all post-taxonomy associations.
  - `taxonomies.parent_id -> taxonomies(id) ON DELETE SET NULL` flattened taxonomy hierarchies.
  - `_emdash_menu_items.menu_id -> _emdash_menus(id) ON DELETE CASCADE` wiped every menu item on the install (along with `parent_id -> _emdash_menu_items(id) ON DELETE CASCADE` mopping up nested items).

  The migration now physically removes those FK relationships before any drop. `content_taxonomies` and `_emdash_menu_items` are rebuilt without their parent FKs as the first steps of up(), and the new `taxonomies` self-FK targets its temporary name (`taxonomies_new`) which SQLite rebinds on RENAME. The FKs from migration 005 on `_emdash_menu_items` are not restored on rollback either: the runtime always deleted child rows explicitly, so the cascade was redundant and reinstating it would only re-create the #1021 hazard on any future migration that drops `_emdash_menus`. Rollback also refuses to run when `content_taxonomies` has rows referencing translation groups with no surviving `taxonomies` row, surfacing dangling data before any destructive work, and the `idx_content_taxonomies_term` index from migration 015 is restored after each rebuild.

  This is forward-fix only. Installs that already lost data when running 036 will need to restore from D1 Time Travel.

- [#1088](https://github.com/emdash-cms/emdash/pull/1088) [`883b75b`](https://github.com/emdash-cms/emdash/commit/883b75b992854a4e339d3896bbd73bec36180b9b) Thanks [@MA2153](https://github.com/MA2153)! - Fixes `EmDashClient.terms()` returning `{ terms }` instead of `{ items }`, which caused `page.items` to be `undefined` for any caller that iterated the result. The API handler returns `{ terms: TermWithCount[] }` but the client was typed and advertised as `ListResult<Term>` — the key name mismatch is now mapped correctly.

- [#751](https://github.com/emdash-cms/emdash/pull/751) [`05440b1`](https://github.com/emdash-cms/emdash/commit/05440b11ef5df609ad7f800143fa96019da22101) Thanks [@edrpls](https://github.com/edrpls)! - Fix the admin collection list pagination denominator so it no longer grows in increments of 5 as the user pages forward.

  The `GET /_emdash/api/content/{collection}` response now includes a `total` field with the full filtered row count (independent of `limit`). The admin uses it as the pagination denominator, so a 143-entry collection reads `1/8` on page 1 instead of `1/5 → 5/10 → 10/15 → …` as successive API pages load.

  The `total` field is optional; pre-upgrade clients that ignore it still work, and the admin falls back to the loaded-item count when an older server doesn't return it.

  Also handles the edge case where the current page exceeds `totalPages` after filtering or deletion — the admin clamps the active page so the table doesn't render empty while waiting for a refetch.

- [#1000](https://github.com/emdash-cms/emdash/pull/1000) [`94fb50b`](https://github.com/emdash-cms/emdash/commit/94fb50b0338d21037a6623de7f350a1621b1b811) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Fixes invite passkey registration behind a TLS-terminating reverse proxy. The invite `register-options` endpoint now resolves the public origin via `getPublicOrigin(url, emdash.config)` before calling `getPasskeyConfig`, matching every other passkey endpoint. Previously the WebAuthn RP ID fell back to `url.hostname` (e.g. `localhost`), causing the browser to reject the registration with "Security error" when the public origin differed from the upstream host.

- [#1013](https://github.com/emdash-cms/emdash/pull/1013) [`0cd8c6d`](https://github.com/emdash-cms/emdash/commit/0cd8c6d4e0f0dc126d66f953afcfdc3d6201d00b) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes the slash command menu's initial selection getting overridden when the menu opens under a stationary pointer. The menu items previously reacted to `mouseenter` unconditionally, so an item rendered beneath the cursor would steal selection from the keyboard default before any user interaction. Mouse-hover-selects still works, but only after the user actually moves the pointer over the menu.

- [#1087](https://github.com/emdash-cms/emdash/pull/1087) [`878a0b6`](https://github.com/emdash-cms/emdash/commit/878a0b689b9475e501f809d81d0fe494a040bfe4) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes two data-loss bugs in the WordPress WXR import path (admin UI Settings, Import, WordPress, i.e. `POST /_emdash/api/import/wordpress/execute`).

  Per-post taxonomy assignments parsed from `<wp:category>`, `<wp:tag>`, `<wp:term>`, and per-item `<category domain="...">` blocks (#1061) are now persisted. The HTTP execute handler previously extracted this data and silently discarded it before any taxonomy or pivot rows were written. Terms are created idempotently in EmDash's seeded `category` and `tag` taxonomies; custom taxonomies such as `genre` are matched against existing EmDash definitions via the runtime's locale fallback chain (`resolveLocaleChain`), so imports against a non-default-locale site reuse defs seeded at the default locale instead of false-failing. Unknown custom taxonomies surface in a new `result.taxonomies.missingTaxonomies` field instead of being silently dropped, so the admin can prompt the user to create the missing definition. Assignments respect each taxonomy definition's `collections` array.

  WPML and Polylang translations (#1080) are now imported under their own per-post locale and linked via `translation_group`. Previously the entire upload shared one `config.locale` and the second post of any translation pair was rejected by the `UNIQUE(slug, locale)` constraint introduced in migration 019. The parser promotes per-post locale from `_icl_lang_code` (WPML), `trid` (WPML's translation group id), `_locale` (Polylang), the `language` taxonomy, or `_translations` postmeta. Terms are mirrored into each translation's locale so per-locale lookups (`getTermsForEntry(..., locale)`) resolve correctly on every translation row. Per-translation taxonomy assignments override anchor-inherited ones per-taxonomy when the translator picked different terms, matching WPML "Translate Independently" mode. Taxonomies the translation did not touch keep their inherited assignments, matching WPML "Sync" mode and Polylang's default.

  Adds `result.taxonomies` to the import response (additive). Existing consumers continue to work unchanged.

  Scope note: this fixes the HTTP import path, which is what the admin UI calls. The standalone `emdash import wordpress` CLI command writes JSON files to disk and has its own slug-only output path that does not carry locale, so it can still clobber two translations with the same `post_name`. That is a separate fix and not addressed here.

- [#768](https://github.com/emdash-cms/emdash/pull/768) [`121f173`](https://github.com/emdash-cms/emdash/commit/121f1735f06520468d1532efd9f9fba88ff5d295) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Fixes `SQLITE_CORRUPT_VTAB` (`database disk image is malformed`) when editing or publishing content on collections that have search enabled, and on restore-from-trash, permanent-delete, and edit-while-trashed flows.

  The FTS5 sync triggers used the contentless-table form (`DELETE FROM fts WHERE rowid = OLD.rowid`) on what is actually an external-content FTS5 table. After an UPDATE on `ec_<collection>`, FTS5 then read NEW column values from the (already updated) content table while trying to remove OLD tokens from the inverted index, drifting the index out of sync until SQLite refused further reads. Rewrites the triggers to use the documented external-content-safe `INSERT INTO fts(fts, rowid, ...) VALUES('delete', OLD.rowid, OLD.col1, ...)` pattern, gated on `OLD.deleted_at IS NULL` so we don't try to remove rows that were never indexed (which would itself raise `SQLITE_CORRUPT_VTAB` on restore-from-trash and permanent-delete).

  Adds migration `039_fix_fts5_triggers` that rebuilds the FTS index for every search-enabled collection on upgrade, replacing the broken triggers and recovering from any latent index corruption left behind by earlier mutations. The migration runs once at startup before the first request can hit the affected paths, so upgrading sites get the fix on their next deploy without depending on a search-endpoint visit to trigger lazy auto-repair.

- [#1077](https://github.com/emdash-cms/emdash/pull/1077) [`f4a9711`](https://github.com/emdash-cms/emdash/commit/f4a9711d7e715b6f71129bf60665113052a52d60) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes `Astro.locals.emdash` typing. The shipped type declaration referenced a build artifact that does not exist, so `locals.emdash` silently fell back to `any` in every EmDash site — losing autocomplete and type-checking on the handlers API in your pages and endpoints. It is now correctly typed as `EmDashHandlers`.

- [#1019](https://github.com/emdash-cms/emdash/pull/1019) [`5681eb2`](https://github.com/emdash-cms/emdash/commit/5681eb2e43fbe57c535e5f828c1c8eba06b3eb89) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes a Zod type-incompatibility between trusted plugins and core. Without a workspace-level pin, emdash's `zod: ^4.3.5` could resolve to a different patch than Astro's bundled Zod, and Zod 4 embeds the version in the type — so schemas imported via `astro/zod` in trusted plugins (e.g. `@emdash-cms/plugin-forms`) were not assignable to `definePlugin`'s `PluginRoute<TInput>['input']`. Pins Zod in the pnpm catalog so the entire workspace dedupes on one instance.

- [#1074](https://github.com/emdash-cms/emdash/pull/1074) [`ed917d9`](https://github.com/emdash-cms/emdash/commit/ed917d9d534751241dafb9126fd0beddbd5ed593) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes stored config sharing when the runtime module is loaded as both compiled `dist` and raw `src` in the same process (Vite SSR / dual-package). The integration config is now keyed on a global `Symbol.for` registry entry instead of a typed `globalThis` var, matching the existing isolate-singleton pattern, so `getStoredConfig()` resolves consistently across both module copies.

- [#1076](https://github.com/emdash-cms/emdash/pull/1076) [`6e62b90`](https://github.com/emdash-cms/emdash/commit/6e62b90e14615a2012a5885849e6b1d1062e7c0b) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes a type error in the shipped WordPress-plugin import source: the analyze-endpoint error body from `response.json()` is `unknown` under `@cloudflare/workers-types` and was read without narrowing. This file ships as raw source via the `emdash/routes/*` export, so the error surfaced in strict consumer typechecks (issue #1053). The body is now typed before `.message` is read; runtime behaviour is unchanged.

- Updated dependencies [[`05440b1`](https://github.com/emdash-cms/emdash/commit/05440b11ef5df609ad7f800143fa96019da22101), [`484e7ab`](https://github.com/emdash-cms/emdash/commit/484e7ab66a9d7910bcb56b3385babb28a8ff0986), [`0d5843f`](https://github.com/emdash-cms/emdash/commit/0d5843fc3378936667ab81c56001349198028ebb), [`0cd8c6d`](https://github.com/emdash-cms/emdash/commit/0cd8c6d4e0f0dc126d66f953afcfdc3d6201d00b), [`d014b48`](https://github.com/emdash-cms/emdash/commit/d014b483e438a52fb27fcfa47ed6ef64a24e21df), [`dbaea9c`](https://github.com/emdash-cms/emdash/commit/dbaea9ccaef6ac48dda14b77c6b2adbe0dc0ff38), [`5681eb2`](https://github.com/emdash-cms/emdash/commit/5681eb2e43fbe57c535e5f828c1c8eba06b3eb89)]:
  - @emdash-cms/admin@0.13.0
  - @emdash-cms/auth@0.13.0
  - @emdash-cms/auth-atproto@0.2.6
  - @emdash-cms/gutenberg-to-portable-text@0.13.0

## 0.12.0

### Minor Changes

- [#997](https://github.com/emdash-cms/emdash/pull/997) [`7b45cba`](https://github.com/emdash-cms/emdash/commit/7b45cba66143c3a75bbd880abff85303c1fd6072) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds support for a site-wide default Open Graph image. The setting is exposed in the admin SEO settings page (Settings -> SEO -> Default Social Image), resolved to a URL on read by `getSiteSettings()`, and automatically emitted as `og:image` / `twitter:image` (and BlogPosting JSON-LD `image`) by `EmDashHead.astro` whenever a page has no image of its own. Per-page images still take precedence.

  This wires up an existing data model that was previously defined in the schema and MCP tools but never used: stored values were not resolved and no template path read the setting.

  Emitted URLs are absolutized using `SiteSettings.url`, the page's `siteUrl`, or the request origin so crawlers and JSON-LD consumers that reject relative URLs work correctly.

  Also adds a `localOnly` prop to `MediaPickerModal` that suppresses the "Insert from URL" input and external provider tabs. Used by SEO settings to ensure the picker only returns locally-stored media (since the setting only persists a local `mediaId`).

  Media metadata updates and deletes now invalidate the worker-scoped site-settings cache, so resolved logo/favicon/default-social-image URLs and dimensions stay in sync with the underlying media row.

### Patch Changes

- [#1004](https://github.com/emdash-cms/emdash/pull/1004) [`35791ff`](https://github.com/emdash-cms/emdash/commit/35791ff9f68c10c6d3ff15ee0ab407baef09c2aa) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes a stale ref race in the slash command menu's keyboard handlers. The state ref was synced via `useEffect` (post-commit), so TipTap's Suggestion plugin could read stale state when invoking `onKeyDown` synchronously -- causing Enter to occasionally fail to execute commands and arrow navigation to skip selections on slower runs.

- Updated dependencies [[`19576be`](https://github.com/emdash-cms/emdash/commit/19576be43134359596ca7705f84fd645bd2f3824), [`35791ff`](https://github.com/emdash-cms/emdash/commit/35791ff9f68c10c6d3ff15ee0ab407baef09c2aa), [`7b45cba`](https://github.com/emdash-cms/emdash/commit/7b45cba66143c3a75bbd880abff85303c1fd6072)]:
  - @emdash-cms/admin@0.12.0
  - @emdash-cms/auth@0.12.0
  - @emdash-cms/gutenberg-to-portable-text@0.12.0
  - @emdash-cms/auth-atproto@0.2.5

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
