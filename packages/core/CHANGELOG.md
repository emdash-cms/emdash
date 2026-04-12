# emdash

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
