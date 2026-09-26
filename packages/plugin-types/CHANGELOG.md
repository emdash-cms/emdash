# @emdash-cms/plugin-types

## 0.4.0

### Minor Changes

- [#3188](https://github.com/emdash-cms/emdash/pull/3188) [`4fef109`](https://github.com/emdash-cms/emdash/commit/4fef1090732a181f718c2398fbf04c05d40cf5f5) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds saved-entry panels and actions for sandboxed plugins. Declare collection-filtered `admin.editorPanels` and `admin.editorActions` entries that point to private plugin routes.
  
  Panels load Block Kit only when an editor opens them. Actions support confirmation and can return a toast, request an entry refresh, or navigate through a structured link target. EmDash reloads and ownership-authorizes the saved entry before invocation, then exposes only its canonical identity, locale, and version through `routeCtx.ui`; unsaved editor values never cross the sandbox boundary.
  
  `createPluginRuntimeTestHost()` includes panel and action helpers that exercise the production authorization, response-validation, and Worker Loader path.

- [#3171](https://github.com/emdash-cms/emdash/pull/3171) [`80ccfaf`](https://github.com/emdash-cms/emdash/commit/80ccfaf198307e7f1760f3406db60f41851a40f2) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds capability-gated schema, translation, public URL, and content revision discovery for plugins.
  
  Declare `schema:read` to list collection and field definitions through `ctx.schema`. Existing `content:read` access can inspect safe content identity, discover locale siblings with `getTranslations()`, and resolve published routes with `getPublicUrl()`. Public URL resolution follows the site's collection pattern, locale routing, and trailing-slash policy and returns `null` for content without a public route.
  
  Revision snapshots require the separate `content:revisions:read` capability because retained history can contain field values that an administrator removed later. This capability implies ordinary `content:read` access. Installation and plugin updates show both new authorities for consent, and the native, Cloudflare Worker Loader, and Node.js workerd runtimes expose the same methods.

- [#3184](https://github.com/emdash-cms/emdash/pull/3184) [`46784e1`](https://github.com/emdash-cms/emdash/commit/46784e10d9bef7f4e3dd3e41c0d78232691d0870) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds capability-gated redirect access for sandboxed plugins. Declare `redirects:read` to list redirect rules with cursor pagination and read a rule with an opaque `_rev`. Declare `redirects:write` to create, update, and delete redirect rules; write access implies read access and installation consent states that the plugin can change where visitors are sent.
  
  Redirect mutations use EmDash's redirect validation and cache invalidation path. Writes are serialized across runtimes so duplicate-source and loop validation use a consistent rule graph. The expanded redirect schema remains compatible with writes from previous host processes during rolling deployments. Loop validation runs when a rule is created or its source or destination changes; enabled-only updates retain the host API's existing behavior. Updates and deletes require the latest `_rev`, reject concurrent changes with `CONFLICT`, and do not let plugins set the host-owned automatic redirect marker. The Cloudflare Worker Loader and Node.js workerd runners expose the same API, and `createPluginRuntimeTestHost()` includes redirect fixtures and inspection for production-boundary tests.

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

- [#3169](https://github.com/emdash-cms/emdash/pull/3169) [`8ad06e9`](https://github.com/emdash-cms/emdash/commit/8ad06e9c3317f97a6c8c553b310325c229c0986d) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds the `taxonomies:write` sandboxed-plugin capability for creating taxonomy terms and adding or removing term assignments through `ctx.taxonomies`.
  
  Assignment methods accept term row IDs or translation-group IDs and apply idempotent deltas, so they do not replace existing assignments and concurrent additions are preserved. EmDash validates collection attachment, entry existence, term ownership, configured locales, translation identity, and hierarchy before changing taxonomy state. Sandboxed `createTerm()` rejects `parentId` for a non-hierarchical taxonomy instead of ignoring it. The capability implies `taxonomies:read` and requires renewed consent when an installed plugin first declares it.
  
  Existing REST and MCP term mutations also reject creating or updating a term with a parent in a non-hierarchical taxonomy. Callers that assign parents must mark the taxonomy as hierarchical before creating or reparenting terms.
  
  This release includes migration `082_taxonomy_translation_locale_unique`, which enforces one term per translation group and locale. If an existing database contains duplicate rows, the migration preserves them as independent term groups and copies their assignments before adding the unique index. It can restart safely after any completed statement.
  
  `@emdash-cms/plugin-test` adds taxonomy fixtures and an assignment inspector for production-boundary tests. Taxonomy definition management, assignment replacement, term updates, and term deletion remain unavailable to sandboxed plugins.

### Patch Changes

- [#3152](https://github.com/emdash-cms/emdash/pull/3152) [`a823276`](https://github.com/emdash-cms/emdash/commit/a823276384cdd3fbf60f01fac5ffb22de6e73dba) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes standard sandboxed plugins so lifecycle, content, media, comment, email, cron, and page metadata hooks run through the same ordered, capability-gated host pipeline as trusted plugins on Cloudflare Workers and Node.js.
  
  Sandbox contexts now expose canonical capabilities, database-backed `ctx.cron`, complete content metadata and filtering, and a real `Response` shape from `ctx.http.fetch()`. Cloudflare response bodies still cross the bridge as text. Admin-managed settings now share the `ctx.kv` settings namespace, lifecycle hooks run once at the correct install/enable boundary, and uninstall cleanup runs before plugin data or bundles are removed.
  
  Plugin builds also preserve hook, route permission and cache, MCP, settings, and field-widget metadata in registry bundles and npm descriptors.

## 0.3.1

### Patch Changes

- [#2864](https://github.com/emdash-cms/emdash/pull/2864) [`ecdba4d`](https://github.com/emdash-cms/emdash/commit/ecdba4d1338447e1a267a3498764f9a1de2a0636) Thanks [@camc314](https://github.com/camc314)! - Updates Zod to 4.5 while keeping EmDash and native plugin schemas on one compatible version. Existing minute-precision ISO datetimes remain valid, and URL content fields continue to enforce configured length and pattern rules.

## 0.3.0

### Minor Changes

- [#2002](https://github.com/emdash-cms/emdash/pull/2002) [`e52dea9`](https://github.com/emdash-cms/emdash/commit/e52dea9b72b043d62348f8d01eefade2ce66484c) Thanks [@jcheese1](https://github.com/jcheese1)! - Adds explicitly declared, administrator-enabled plugin MCP tools with per-route permissions, plugin-scoped token access, install and update consent, structured output schemas, and invocation auditing.

- [#1985](https://github.com/emdash-cms/emdash/pull/1985) [`3f8b778`](https://github.com/emdash-cms/emdash/commit/3f8b77822bf8e89b065884c53c7e8b7676788c48) Thanks [@swissky](https://github.com/swissky)! - Adds a `cacheControl` option for public plugin routes: successful GET responses carry the configured `Cache-Control` header, enabling CDN and browser caching for public plugin endpoints. Works for native, standard, and marketplace plugin formats. Private routes and errors keep the `private, no-store` default.

- [#2067](https://github.com/emdash-cms/emdash/pull/2067) [`07c9f21`](https://github.com/emdash-cms/emdash/commit/07c9f210db300803f49ecf2b8a18fe173e459a28) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds plugin manifest schema validation (`pluginManifestSchema`, `reconcileManifestAccess`) and declared-access canonicalization helpers (`canonicalizeDeclaredAccess`, `diffDeclaredAccess`, escalation detection, and the `CanonicalDeclaredAccess` types) for validating plugin manifests and comparing the access a plugin declares.

## 0.2.0

### Minor Changes

- [#1719](https://github.com/emdash-cms/emdash/pull/1719) [`7c5de08`](https://github.com/emdash-cms/emdash/commit/7c5de08f6370ea88500b7ec425d58b2c82443260) Thanks [@swissky](https://github.com/swissky)! - Adds a `taxonomies:read` plugin capability with read-only taxonomy access: plugins that declare it get `ctx.taxonomies` to list taxonomy definitions (`getAll()`), fetch the terms of a taxonomy (`getTerms()`), and read the terms assigned to a content entry (`getEntryTerms()`) — in-process and in both sandbox runners.

## 0.1.0

### Minor Changes

- [#1461](https://github.com/emdash-cms/emdash/pull/1461) [`b01aa9b`](https://github.com/emdash-cms/emdash/commit/b01aa9bbb436bcec07516b499eb0516cfbe414b4) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes registry installs failing with "Plugin manifest has changed since you consented" for plugins that declare hook-registration capabilities (email transport, email events, page fragments) or read user records. Plugin bundles now declare their access as a structured `declaredAccess` contract that the registry record, the install-consent dialog, and the sandbox all read consistently, so every capability a plugin declares is shown for consent and enforced — no capability is silently dropped. Re-publish affected plugins to adopt the new bundle format; existing installs are unaffected.

## 0.0.1

### Patch Changes

- [#923](https://github.com/emdash-cms/emdash/pull/923) [`943df46`](https://github.com/emdash-cms/emdash/commit/943df46d62043df386eef4664fbba4710be16c31) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `@emdash-cms/plugin-types`: shared TypeScript types for the EmDash plugin manifest contract — capability vocabulary (`PluginCapability`, `CAPABILITY_RENAMES`, `isDeprecatedCapability`, `normalizeCapability`), manifest shape (`PluginManifest`, `ManifestHookEntry`, `ManifestRouteEntry`, `PluginAdminConfig`, `PluginStorageConfig`). Consumed by both `emdash` (manifest reader at install/runtime) and `@emdash-cms/registry-cli` (manifest writer at bundle/publish time). After the registry phase 1 cutover removes the legacy bundling code from core, both sides will continue depending on this single source of truth.
