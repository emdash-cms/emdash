# @emdash-cms/plugin-test

## 0.2.1

### Patch Changes

- Updated dependencies [[`2787dab`](https://github.com/emdash-cms/emdash/commit/2787dabad9b88db109cd0a4ff2bd06af050fc81a)]:
  - emdash@0.39.1
  - @emdash-cms/cloudflare@0.39.1
  - @emdash-cms/blocks@0.39.1

## 0.2.0

### Minor Changes

- [#3180](https://github.com/emdash-cms/emdash/pull/3180) [`6e151ef`](https://github.com/emdash-cms/emdash/commit/6e151ef4fbe74581f7c66529e3c3de9ee5ed8953) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds binary-safe `ctx.http.fetch()` behavior to sandboxed plugins on Cloudflare Worker Loader and Node/workerd. Request and response bodies are buffered with an 8 MiB decoded limit, and the returned WHATWG `Response` preserves bytes, status text, headers, final URL, redirect state, and clones across both runners.
  
  Redirected requests follow Fetch method and body rules. The Node/workerd runner also applies the installed version's current network capability and host list immediately after a plugin update.
  
  #### Reading binary responses
  
  Read bytes from the buffered response with the standard Response API:
  
  ```ts
  const response = await ctx.http!.fetch("https://api.example.com/report");
  const bytes = new Uint8Array(await response.arrayBuffer());
  ```
  
  #### Testing external HTTP
  
  `createPluginRuntimeTestHost()` adds `http.respond()`, `http.requests()`, and `http.clear()` for deterministic production-bridge tests:
  
  ```ts
  await host.http.respond("https://api.example.com/report", new Response(new Uint8Array([0, 255])));
  await host.transport.invokeRoute("import-report");
  expect(host.http.requests()).toContainEqual(
  	expect.objectContaining({ url: "https://api.example.com/report" }),
  );
  ```

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

- [#3173](https://github.com/emdash-cms/emdash/pull/3173) [`7aa12b3`](https://github.com/emdash-cms/emdash/commit/7aa12b37adc98ef3b07d6a7132833e72e33c6cc7) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `ctx.settings` for plugin configuration and encrypts fields declared as `type: "secret"` before writing them to the database. Native plugins, Cloudflare Worker Loader plugins, and Node/workerd plugins share the same versioned AES-GCM envelope and plugin-scoped API. `@emdash-cms/plugin-test` can update generated settings through the runtime host and inspect their raw persisted envelope.
  
  Set `EMDASH_ENCRYPTION_KEY` in the runtime process environment before saving secret settings. A standalone Node server does not load `.env` automatically. To rotate the key, place the new key first in a comma-separated list and retain old keys until every plugin secret has been saved again. EmDash does not currently report which key IDs remain in use, so track each resaved credential and verify its integration before removing an old key. Restores need both the database and every encryption key referenced by its stored envelopes.
  
  Cloudflare sites using `nodejs_compat` with a compatibility date before `2025-04-01` must also add `nodejs_compat_populate_process_env` before saving secrets through the generated admin form. Cloudflare enables that behavior by default for later compatibility dates.
  
  Existing plaintext secrets remain readable and are encrypted when saved again. The `ctx.kv.get("settings:<key>")` compatibility alias remains available throughout the EmDash 0.x release line; new plugin code should use `ctx.settings.get("<key>")`.
  
  Only fields declared as `type: "secret"` in `admin.settingsSchema` use this encryption path. Arbitrary plugin KV and state values are unchanged; credentials stored by the bundled AT Protocol and webhook notifier plugins are not migrated by this release.

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

- [#3162](https://github.com/emdash-cms/emdash/pull/3162) [`a4af578`](https://github.com/emdash-cms/emdash/commit/a4af5781360edb83811b38347d6d9bd23a6fc498) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `createPluginRuntimeTestHost()` for sandboxed plugin tests that must exercise EmDash orchestration instead of invoking an isolate directly. The host separates direct transport calls, fixtures, production actions, observable-state inspectors, scheduled time control, cold restart, and disposal.
  
  Runtime actions cover the shipped content lifecycle, plugin activation and deactivation, media upload, public comment submission, comment moderation, plugin-route policy, and scheduled task execution. The controlled scheduler clock applies to cron tasks and scheduled publishing. `restart()` retains D1, plugin storage, media storage, and plugin state while replacing runtime and isolate memory. The host captures delivered email for assertions.
  
  `createPluginTestHost()` and its top-level `invokeHook()` and `invokeRoute()` methods remain compatible for fast transport-level tests. `emdashPluginTest()` supplies the runtime modules required by the documented Vitest configuration. Generated plugin projects continue to use Worker Loader by default and describe Node/workerd parity as an opt-in test for runner-sensitive behavior.

- [#3174](https://github.com/emdash-cms/emdash/pull/3174) [`06bad83`](https://github.com/emdash-cms/emdash/commit/06bad83f5f466a32ab52f0c59fab7c2f9a8a76ea) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds structured Block Kit navigation and host-attested administrator locale context for sandboxed plugin pages and dashboard widgets.
  
  Plugins can return `link` elements that target saved content, another page declared by the same plugin, generated plugin settings, or an external HTTP, HTTPS, or `mailto:` URL. EmDash constructs internal admin URLs and opens external links with `noopener noreferrer`. Links never dispatch block actions and cannot appear as form fields.
  
  Block Kit route handlers receive `routeCtx.ui` with the validated surface, administrator locale, and text direction. The host validates every sandboxed page and widget response before rendering it, rejects undeclared plugin-page targets and active URL protocols, and permits external images only over HTTPS to hosts declared in `allowedHosts` under `network:request` consent or under `network:request:unrestricted` consent. Responses are limited to 256 KiB, 20 levels, 2,000 nodes, 1,000 items per array, and 64 KiB per string.
  
  `createPluginRuntimeTestHost()` adds `admin.loadPage()`, `loadWidget()`, `act()`, and `submit()` helpers that exercise the private production route, Worker Loader isolate, host UI context, and response validation.
  
  This is a breaking security tightening for sandboxed plugins that return an external Block Kit image without matching network authority. EmDash rejects the complete page or widget response instead of allowing the administrator's browser to contact an unapproved host.
  
  #### What should I do?
  
  If a plugin returns external Block Kit images, add `network:request` and every image hostname to `allowedHosts`, or add `network:request:unrestricted` when the plugin genuinely requires any hostname. Publish a plugin update so administrators can review and approve the expanded authority. Root-relative images need no manifest change.

- [#3182](https://github.com/emdash-cms/emdash/pull/3182) [`70ab2f8`](https://github.com/emdash-cms/emdash/commit/70ab2f81c101bea441c416caff298820f154889b) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds translation-aware sandboxed plugin content creation through `ctx.content.create(collection, data, { locale, translationOf })`.
  
  The source must be an active entry in the same collection. The new entry joins its translation group, inherits its byline credits and taxonomy assignments, and takes non-translatable field values from the source. Content validation and save hooks run in both the Cloudflare Worker Loader and Node/workerd runners. Save-hook-originated creates do not re-enter save hooks, and the creating plugin's own `content:afterSave` hook is not re-entered.
  
  Each translation group permits one active entry per locale. Duplicate locale creates return `CONFLICT`, missing sources return `NOT_FOUND`, invalid or unconfigured locales return `VALIDATION_ERROR`, and save hooks can return `SAVE_REJECTED`.

- [#3169](https://github.com/emdash-cms/emdash/pull/3169) [`8ad06e9`](https://github.com/emdash-cms/emdash/commit/8ad06e9c3317f97a6c8c553b310325c229c0986d) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds the `taxonomies:write` sandboxed-plugin capability for creating taxonomy terms and adding or removing term assignments through `ctx.taxonomies`.
  
  Assignment methods accept term row IDs or translation-group IDs and apply idempotent deltas, so they do not replace existing assignments and concurrent additions are preserved. EmDash validates collection attachment, entry existence, term ownership, configured locales, translation identity, and hierarchy before changing taxonomy state. Sandboxed `createTerm()` rejects `parentId` for a non-hierarchical taxonomy instead of ignoring it. The capability implies `taxonomies:read` and requires renewed consent when an installed plugin first declares it.
  
  Existing REST and MCP term mutations also reject creating or updating a term with a parent in a non-hierarchical taxonomy. Callers that assign parents must mark the taxonomy as hierarchical before creating or reparenting terms.
  
  This release includes migration `082_taxonomy_translation_locale_unique`, which enforces one term per translation group and locale. If an existing database contains duplicate rows, the migration preserves them as independent term groups and copies their assignments before adding the unique index. It can restart safely after any completed statement.
  
  `@emdash-cms/plugin-test` adds taxonomy fixtures and an assignment inspector for production-boundary tests. Taxonomy definition management, assignment replacement, term updates, and term deletion remain unavailable to sandboxed plugins.

### Patch Changes

- [#3236](https://github.com/emdash-cms/emdash/pull/3236) [`26e035d`](https://github.com/emdash-cms/emdash/commit/26e035d856a1b480dcb964348ae3d367a1a81390) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds a disposable R2 bucket to `emdashPluginTest()` so sandbox plugin tests can exercise `ctx.media.upload()` and `ctx.media.delete()` through the same Worker Loader bridge used in production.
  
  Fixes registry installation rejecting sandbox plugins whose manifests declare `content.publish`, `content.restore`, or `content.policy` access. These permissions now survive bundle-manifest validation and reach the normal installation consent checks.
- Updated dependencies [[`5510725`](https://github.com/emdash-cms/emdash/commit/551072506d9f37e467b71b0448f6eeda70485f54), [`fc4a7be`](https://github.com/emdash-cms/emdash/commit/fc4a7be4ca02cc13e270a4cc90259c9cc46187b1), [`6e151ef`](https://github.com/emdash-cms/emdash/commit/6e151ef4fbe74581f7c66529e3c3de9ee5ed8953), [`4fef109`](https://github.com/emdash-cms/emdash/commit/4fef1090732a181f718c2398fbf04c05d40cf5f5), [`80ccfaf`](https://github.com/emdash-cms/emdash/commit/80ccfaf198307e7f1760f3406db60f41851a40f2), [`46784e1`](https://github.com/emdash-cms/emdash/commit/46784e10d9bef7f4e3dd3e41c0d78232691d0870), [`f6bf82f`](https://github.com/emdash-cms/emdash/commit/f6bf82fe23a783ac9932f4a913b6873349222899), [`3538bb8`](https://github.com/emdash-cms/emdash/commit/3538bb86c7801edf8634af2656cbe3dd194bca50), [`4ebd2a8`](https://github.com/emdash-cms/emdash/commit/4ebd2a8da46ae144714cef7b776aa6d790f92815), [`dbd77ef`](https://github.com/emdash-cms/emdash/commit/dbd77ef387cf1b0ea22018e442d88450578c8f0c), [`9bffbfa`](https://github.com/emdash-cms/emdash/commit/9bffbfa89797524ff8fbb93919707cb752334a32), [`2818e66`](https://github.com/emdash-cms/emdash/commit/2818e669e1f51f4a3314165eb9b4360b707a67ba), [`26e035d`](https://github.com/emdash-cms/emdash/commit/26e035d856a1b480dcb964348ae3d367a1a81390), [`6ce67bb`](https://github.com/emdash-cms/emdash/commit/6ce67bb82b744e829c17b0484db3ebfe1229c618), [`f88db94`](https://github.com/emdash-cms/emdash/commit/f88db94ff26a1a4d09fe4297fb64541d5c1a9b1d), [`9c61f93`](https://github.com/emdash-cms/emdash/commit/9c61f93a67cd297d04439f7ac02d199d817335a2), [`a10f9ca`](https://github.com/emdash-cms/emdash/commit/a10f9ca20d79c1ecfca0584b085bbbbc34144d22), [`ad1dee2`](https://github.com/emdash-cms/emdash/commit/ad1dee288aedda3242a2f456708b53cd2e0b23cd), [`7aa12b3`](https://github.com/emdash-cms/emdash/commit/7aa12b37adc98ef3b07d6a7132833e72e33c6cc7), [`dd885e5`](https://github.com/emdash-cms/emdash/commit/dd885e580c6ed2009a1941bb7fc7166a68b0679c), [`e9c4433`](https://github.com/emdash-cms/emdash/commit/e9c44338794a5f35e016644d8db913bffe6b235d), [`e9c4433`](https://github.com/emdash-cms/emdash/commit/e9c44338794a5f35e016644d8db913bffe6b235d), [`222f329`](https://github.com/emdash-cms/emdash/commit/222f32936ad74e102c1b64d8017625ac913d17dc), [`5129196`](https://github.com/emdash-cms/emdash/commit/5129196a2b0bbbdfbd47a98f02915f650091f061), [`71901fc`](https://github.com/emdash-cms/emdash/commit/71901fc92b5a09bd5c1321759b2db1aaa9b0e730), [`3cec6f9`](https://github.com/emdash-cms/emdash/commit/3cec6f94bba0293f84488c3dab9d2584e27812f2), [`363dd56`](https://github.com/emdash-cms/emdash/commit/363dd56f2c9027b3c6237c7e5f3346181752cd9a), [`3533d2c`](https://github.com/emdash-cms/emdash/commit/3533d2cd7352bc66ed9b08d84233899b59d9aeaf), [`a6b9884`](https://github.com/emdash-cms/emdash/commit/a6b988430b4788d63441073a75b5878ad6e25aec), [`71572ba`](https://github.com/emdash-cms/emdash/commit/71572bafdace8051d685e1f4e96c2463eb6eeccb), [`f0e3817`](https://github.com/emdash-cms/emdash/commit/f0e3817c9b99d7cd53e9a4745f455eedf628d530), [`54377c8`](https://github.com/emdash-cms/emdash/commit/54377c82fd223da68e29d958e2957cca24564583), [`1e13daa`](https://github.com/emdash-cms/emdash/commit/1e13daa3d0987a57da0a84f87cebda3a0a6461a4), [`27e9450`](https://github.com/emdash-cms/emdash/commit/27e9450352c0d7ef1e1308dc31619491837e561f), [`71572ba`](https://github.com/emdash-cms/emdash/commit/71572bafdace8051d685e1f4e96c2463eb6eeccb), [`34e9bb5`](https://github.com/emdash-cms/emdash/commit/34e9bb597d947a54c10acdbe84a0f8ebbfdcb505), [`c029134`](https://github.com/emdash-cms/emdash/commit/c029134b8c9e3fb4d19791c1f5d9450089d12f74), [`1fea699`](https://github.com/emdash-cms/emdash/commit/1fea699007ff3ba31a9f97f9980f75fa0c3e14fc), [`b11095d`](https://github.com/emdash-cms/emdash/commit/b11095d216d0d352bf4a89745a65aed1d5df1bab), [`6e151ef`](https://github.com/emdash-cms/emdash/commit/6e151ef4fbe74581f7c66529e3c3de9ee5ed8953), [`71572ba`](https://github.com/emdash-cms/emdash/commit/71572bafdace8051d685e1f4e96c2463eb6eeccb), [`a823276`](https://github.com/emdash-cms/emdash/commit/a823276384cdd3fbf60f01fac5ffb22de6e73dba), [`5510725`](https://github.com/emdash-cms/emdash/commit/551072506d9f37e467b71b0448f6eeda70485f54), [`a487ae3`](https://github.com/emdash-cms/emdash/commit/a487ae3fff62cc37948d64d19e8a808f61ad4d1c), [`6daffea`](https://github.com/emdash-cms/emdash/commit/6daffea679d3104fd94781f0cd706756c4da6289), [`71572ba`](https://github.com/emdash-cms/emdash/commit/71572bafdace8051d685e1f4e96c2463eb6eeccb), [`71572ba`](https://github.com/emdash-cms/emdash/commit/71572bafdace8051d685e1f4e96c2463eb6eeccb), [`fc32ebf`](https://github.com/emdash-cms/emdash/commit/fc32ebff4b43495e3908cd48eb2a7acc00a6b51d), [`b3433d1`](https://github.com/emdash-cms/emdash/commit/b3433d1e4a9269b16b1c6dfe5536820157ddd119), [`a4af578`](https://github.com/emdash-cms/emdash/commit/a4af5781360edb83811b38347d6d9bd23a6fc498), [`06bad83`](https://github.com/emdash-cms/emdash/commit/06bad83f5f466a32ab52f0c59fab7c2f9a8a76ea), [`a4af578`](https://github.com/emdash-cms/emdash/commit/a4af5781360edb83811b38347d6d9bd23a6fc498), [`808f473`](https://github.com/emdash-cms/emdash/commit/808f473a76141dc048bd527f07749564b445bd12), [`808f473`](https://github.com/emdash-cms/emdash/commit/808f473a76141dc048bd527f07749564b445bd12), [`9ca2de5`](https://github.com/emdash-cms/emdash/commit/9ca2de57b14bebc875fb8c5c124613c14e73f0c9), [`26e035d`](https://github.com/emdash-cms/emdash/commit/26e035d856a1b480dcb964348ae3d367a1a81390), [`dda36bf`](https://github.com/emdash-cms/emdash/commit/dda36bf4fe65c52a52bcc466d20c127caf54ab5f), [`70ab2f8`](https://github.com/emdash-cms/emdash/commit/70ab2f81c101bea441c416caff298820f154889b), [`9e17b18`](https://github.com/emdash-cms/emdash/commit/9e17b183c9aa5b2534f014cb845badf450d8e512), [`8ad06e9`](https://github.com/emdash-cms/emdash/commit/8ad06e9c3317f97a6c8c553b310325c229c0986d), [`7f1a49d`](https://github.com/emdash-cms/emdash/commit/7f1a49d3f670c5e624f0b63ed277b3086bc003e1), [`3030d09`](https://github.com/emdash-cms/emdash/commit/3030d0954dc2e6c3c42283672eaaf15e804043c2), [`93df4e8`](https://github.com/emdash-cms/emdash/commit/93df4e892ba2b737d53ef716755798185db8a142)]:
  - emdash@0.39.0
  - @emdash-cms/cloudflare@0.39.0
  - @emdash-cms/plugin-cli@0.12.0
  - @emdash-cms/blocks@0.39.0
  - @emdash-cms/plugin-types@0.4.0

## 0.1.0

### Minor Changes

- [#3084](https://github.com/emdash-cms/emdash/pull/3084) [`b581ff8`](https://github.com/emdash-cms/emdash/commit/b581ff80af9d9ad73b11374b194da59ccf71d43d) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds a workerd-backed Vitest host for sandboxed plugin tests and includes it in projects created by `emdash-plugin init`. `emdashPluginTest()` builds the plugin and configures D1, Worker Loader, and the production `PluginBridge`; `createPluginTestHost()` invokes hooks and routes through the production sandbox boundary and provides helpers for content fixtures, plugin storage, and KV assertions.

### Patch Changes

- Updated dependencies [[`cd3e391`](https://github.com/emdash-cms/emdash/commit/cd3e3913bb9cbb6dc2ca8e7f4b543de62fcc2e29), [`36a021c`](https://github.com/emdash-cms/emdash/commit/36a021c1185073e77da891d54a406ea9ce810826), [`da171b3`](https://github.com/emdash-cms/emdash/commit/da171b3d8d918066e91aa6068e72adbbcd3678de), [`573230f`](https://github.com/emdash-cms/emdash/commit/573230f539e03ea99e6c22f2cd7f704a4abd25d5), [`2b2f69e`](https://github.com/emdash-cms/emdash/commit/2b2f69e89f25afd9abe08d13fd73b3ad0d39ebc1), [`33cb7f0`](https://github.com/emdash-cms/emdash/commit/33cb7f08de03fb7febccc72c9eb29fcf88b9c248), [`da171b3`](https://github.com/emdash-cms/emdash/commit/da171b3d8d918066e91aa6068e72adbbcd3678de), [`befce6d`](https://github.com/emdash-cms/emdash/commit/befce6dcbbedcf2766d6540214a65f3bbb9e745a), [`cd3e391`](https://github.com/emdash-cms/emdash/commit/cd3e3913bb9cbb6dc2ca8e7f4b543de62fcc2e29), [`3f516f4`](https://github.com/emdash-cms/emdash/commit/3f516f4732da476baaf619e930b9ead2826d063c), [`b73a133`](https://github.com/emdash-cms/emdash/commit/b73a1332324fdef1a60cccad56161c75932f7966), [`b1ccecd`](https://github.com/emdash-cms/emdash/commit/b1ccecd5b036522db28365310c1644ad56a5fab3), [`b581ff8`](https://github.com/emdash-cms/emdash/commit/b581ff80af9d9ad73b11374b194da59ccf71d43d), [`ea2ccd5`](https://github.com/emdash-cms/emdash/commit/ea2ccd548f7aba9883bc1c9d0cf3c6f642c10a62), [`fea6beb`](https://github.com/emdash-cms/emdash/commit/fea6bebfe2d0f26eb7aca45af1a4704e4e7a97bd), [`3bd30da`](https://github.com/emdash-cms/emdash/commit/3bd30da4178f63bafa7aa7147a5cec1d405fa6dd), [`e13fa01`](https://github.com/emdash-cms/emdash/commit/e13fa01118406bba3fc069bb475cb6f13f3bb9ad), [`f9ac286`](https://github.com/emdash-cms/emdash/commit/f9ac286f5a8582809f997aff2999e8a2881c0d74), [`0bcb1d9`](https://github.com/emdash-cms/emdash/commit/0bcb1d9ba13d645009f6624fc08fe2cd3543a127), [`4c89130`](https://github.com/emdash-cms/emdash/commit/4c8913057cdab82c7af66a126722525ee74ba4cb), [`107c3cc`](https://github.com/emdash-cms/emdash/commit/107c3ccdffece10938ccd995b9b2675f3c54a5d7), [`107c3cc`](https://github.com/emdash-cms/emdash/commit/107c3ccdffece10938ccd995b9b2675f3c54a5d7), [`91a4aef`](https://github.com/emdash-cms/emdash/commit/91a4aef76bd2a6c588a22faa44897c7459d81728), [`ef22a2d`](https://github.com/emdash-cms/emdash/commit/ef22a2dc9ffa39844cb7c5caf24eab96e319b07c), [`f0af9a1`](https://github.com/emdash-cms/emdash/commit/f0af9a10b34ea50a14d04ef3fe84c323b6d17ce2), [`dd5ef1a`](https://github.com/emdash-cms/emdash/commit/dd5ef1a23031055e230377480874974dd00d64a2), [`0ae2f26`](https://github.com/emdash-cms/emdash/commit/0ae2f2652281a90813616c146d75029397435436), [`27e432e`](https://github.com/emdash-cms/emdash/commit/27e432e197b592cfe150c9d536cd0696e042a116), [`d409722`](https://github.com/emdash-cms/emdash/commit/d409722ebcb682c767934381a497ccda2b1a068d), [`8b3fd50`](https://github.com/emdash-cms/emdash/commit/8b3fd503d1c8807e785c0696903f5c6d7311dc83), [`1a71c9e`](https://github.com/emdash-cms/emdash/commit/1a71c9e0d88f5e9934fe54329becfa08513d75b9), [`91a4aef`](https://github.com/emdash-cms/emdash/commit/91a4aef76bd2a6c588a22faa44897c7459d81728), [`570333a`](https://github.com/emdash-cms/emdash/commit/570333ac981e4a152fd5aa1405e443d28a491141)]:
  - @emdash-cms/cloudflare@0.38.0
  - emdash@0.38.0
  - @emdash-cms/plugin-cli@0.11.0
