# @emdash-cms/registry-cli

## 0.12.0

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

- [#3117](https://github.com/emdash-cms/emdash/pull/3117) [`54377c8`](https://github.com/emdash-cms/emdash/commit/54377c82fd223da68e29d958e2957cca24564583) Thanks [@ascorbic](https://github.com/ascorbic)! - Improves package-profile and release publishing output: commands use the `@handle/slug` registry identifier, link to the eventual public plugin page, and let `info --version <version> --watch` track effective label checks without exposing unapproved aggregator metadata. Missing manifests point to the plugin directory, GitHub repository prompts use a detected `origin` remote, setup failures omit stack traces, and a published profile shows both manual and GitHub Actions release commands.

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

- [#3236](https://github.com/emdash-cms/emdash/pull/3236) [`26e035d`](https://github.com/emdash-cms/emdash/commit/26e035d856a1b480dcb964348ae3d367a1a81390) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes plugin builds failing when MCP tools use Zod schemas. The plugin CLI now evaluates those schemas when it extracts registry metadata, then omits schema code used only by MCP metadata from the sandbox runtime bundle. Hooks and routes can continue to use Zod at runtime, and plugin authors do not need to change their source.

- [#3173](https://github.com/emdash-cms/emdash/pull/3173) [`7aa12b3`](https://github.com/emdash-cms/emdash/commit/7aa12b37adc98ef3b07d6a7132833e72e33c6cc7) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `ctx.settings` for plugin configuration and encrypts fields declared as `type: "secret"` before writing them to the database. Native plugins, Cloudflare Worker Loader plugins, and Node/workerd plugins share the same versioned AES-GCM envelope and plugin-scoped API. `@emdash-cms/plugin-test` can update generated settings through the runtime host and inspect their raw persisted envelope.
  
  Set `EMDASH_ENCRYPTION_KEY` in the runtime process environment before saving secret settings. A standalone Node server does not load `.env` automatically. To rotate the key, place the new key first in a comma-separated list and retain old keys until every plugin secret has been saved again. EmDash does not currently report which key IDs remain in use, so track each resaved credential and verify its integration before removing an old key. Restores need both the database and every encryption key referenced by its stored envelopes.
  
  Cloudflare sites using `nodejs_compat` with a compatibility date before `2025-04-01` must also add `nodejs_compat_populate_process_env` before saving secrets through the generated admin form. Cloudflare enables that behavior by default for later compatibility dates.
  
  Existing plaintext secrets remain readable and are encrypted when saved again. The `ctx.kv.get("settings:<key>")` compatibility alias remains available throughout the EmDash 0.x release line; new plugin code should use `ctx.settings.get("<key>")`.
  
  Only fields declared as `type: "secret"` in `admin.settingsSchema` use this encryption path. Arbitrary plugin KV and state values are unchanged; credentials stored by the bundled AT Protocol and webhook notifier plugins are not migrated by this release.

- [#3248](https://github.com/emdash-cms/emdash/pull/3248) [`3cec6f9`](https://github.com/emdash-cms/emdash/commit/3cec6f94bba0293f84488c3dab9d2584e27812f2) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes registry plugins appearing in discovery but failing installation when their signed profiles predated repository metadata.
  
  Profiles without the optional repository extension permit releases without provenance. Manual publishing adds an available canonical HTTPS repository with optional provenance, preserves explicit profile policies on later releases, and refuses manual releases when the publisher requires provenance. EmDash routes installation verification correctly and shows site administrators actionable publisher guidance when signed records fail verification.

- [#3285](https://github.com/emdash-cms/emdash/pull/3285) [`71572ba`](https://github.com/emdash-cms/emdash/commit/71572bafdace8051d685e1f4e96c2463eb6eeccb) Thanks [@ascorbic](https://github.com/ascorbic)! - Updates `emdash-plugin profile setup` and `release setup` to ask whether releases require verifiable provenance. Interactive setup pre-fills a repository discovered from Git and defaults to required provenance. Non-interactive runs can select `--provenance required|optional`, and rerunning setup updates the existing signed policy without replacing its repository, approvers, or package metadata.

- [#3152](https://github.com/emdash-cms/emdash/pull/3152) [`a823276`](https://github.com/emdash-cms/emdash/commit/a823276384cdd3fbf60f01fac5ffb22de6e73dba) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes standard sandboxed plugins so lifecycle, content, media, comment, email, cron, and page metadata hooks run through the same ordered, capability-gated host pipeline as trusted plugins on Cloudflare Workers and Node.js.
  
  Sandbox contexts now expose canonical capabilities, database-backed `ctx.cron`, complete content metadata and filtering, and a real `Response` shape from `ctx.http.fetch()`. Cloudflare response bodies still cross the bridge as text. Admin-managed settings now share the `ctx.kv` settings namespace, lifecycle hooks run once at the correct install/enable boundary, and uninstall cleanup runs before plugin data or bundles are removed.
  
  Plugin builds also preserve hook, route permission and cache, MCP, settings, and field-widget metadata in registry bundles and npm descriptors.

- [#3285](https://github.com/emdash-cms/emdash/pull/3285) [`71572ba`](https://github.com/emdash-cms/emdash/commit/71572bafdace8051d685e1f4e96c2463eb6eeccb) Thanks [@ascorbic](https://github.com/ascorbic)! - Updates generated delegated-release workflows to use the current pinned `actions/checkout` v7.0.0 commit with a matching version comment.

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
- Updated dependencies [[`71901fc`](https://github.com/emdash-cms/emdash/commit/71901fc92b5a09bd5c1321759b2db1aaa9b0e730), [`4fef109`](https://github.com/emdash-cms/emdash/commit/4fef1090732a181f718c2398fbf04c05d40cf5f5), [`80ccfaf`](https://github.com/emdash-cms/emdash/commit/80ccfaf198307e7f1760f3406db60f41851a40f2), [`46784e1`](https://github.com/emdash-cms/emdash/commit/46784e10d9bef7f4e3dd3e41c0d78232691d0870), [`3538bb8`](https://github.com/emdash-cms/emdash/commit/3538bb86c7801edf8634af2656cbe3dd194bca50), [`dbd77ef`](https://github.com/emdash-cms/emdash/commit/dbd77ef387cf1b0ea22018e442d88450578c8f0c), [`2818e66`](https://github.com/emdash-cms/emdash/commit/2818e669e1f51f4a3314165eb9b4360b707a67ba), [`3cec6f9`](https://github.com/emdash-cms/emdash/commit/3cec6f94bba0293f84488c3dab9d2584e27812f2), [`1e13daa`](https://github.com/emdash-cms/emdash/commit/1e13daa3d0987a57da0a84f87cebda3a0a6461a4), [`c029134`](https://github.com/emdash-cms/emdash/commit/c029134b8c9e3fb4d19791c1f5d9450089d12f74), [`a823276`](https://github.com/emdash-cms/emdash/commit/a823276384cdd3fbf60f01fac5ffb22de6e73dba), [`6daffea`](https://github.com/emdash-cms/emdash/commit/6daffea679d3104fd94781f0cd706756c4da6289), [`8ad06e9`](https://github.com/emdash-cms/emdash/commit/8ad06e9c3317f97a6c8c553b310325c229c0986d)]:
  - @emdash-cms/registry-lexicons@0.6.0
  - @emdash-cms/plugin-types@0.4.0
  - @emdash-cms/registry-verification@0.3.2
  - @emdash-cms/registry-client@0.6.1

## 0.11.0

### Minor Changes

- [#3081](https://github.com/emdash-cms/emdash/pull/3081) [`da171b3`](https://github.com/emdash-cms/emdash/commit/da171b3d8d918066e91aa6068e72adbbcd3678de) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds repository-level automated plugin releases. `emdash-plugin release setup` writes one shared `.github/workflows/emdash-release.yml` at the Git repository root, including when setup runs from a nested package. The workflow resolves `<slug>@<version>` tags to a unique plugin manifest, rejects version mismatches before attestation, and requests its first repository connection through GitHub OpenID Connect without an Actions secret.
  
  Prepare later packages with `emdash-plugin profile setup --dir <package-directory>`. Their first release reuses approved repository workflow scopes when the signed package profile names the same repository. Tag and manual-run scopes accumulate after publisher confirmation instead of replacing each other. Existing package approvals remain package-scoped until the publisher explicitly confirms a repository connection; existing generated workflows and the legacy optional connection-invitation input remain supported.

- [#3081](https://github.com/emdash-cms/emdash/pull/3081) [`da171b3`](https://github.com/emdash-cms/emdash/commit/da171b3d8d918066e91aa6068e72adbbcd3678de) Thanks [@ascorbic](https://github.com/ascorbic)! - Updates `emdash-plugin init` to produce a validated, package-manager-aware plugin project. Interactive setup shows the resolved publisher, author, security contact, repository, target, and package manager before writing. Non-interactive setup requires explicit ownership flags unless `--use-detected` opts into the active publisher session and local Git metadata.
  
  Generated projects pin the plugin CLI version, use bounded EmDash dependencies, include validation and publishing scripts, and add `AGENTS.md` with a local `creating-plugins` skill. `.agents/skills` and `.claude/skills` link to the same canonical skill directory, while `.claude/CLAUDE.md` links to `AGENTS.md`. pnpm projects include the reviewed `esbuild` install policy and use an explicit `SandboxedPlugin` annotation so declaration output remains portable. The scaffolder validates the complete manifest and parent paths before writing and stages new projects atomically.

- [#3084](https://github.com/emdash-cms/emdash/pull/3084) [`b581ff8`](https://github.com/emdash-cms/emdash/commit/b581ff80af9d9ad73b11374b194da59ccf71d43d) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds a workerd-backed Vitest host for sandboxed plugin tests and includes it in projects created by `emdash-plugin init`. `emdashPluginTest()` builds the plugin and configures D1, Worker Loader, and the production `PluginBridge`; `createPluginTestHost()` invokes hooks and routes through the production sandbox boundary and provides helpers for content fixtures, plugin storage, and KV assertions.

- [#3093](https://github.com/emdash-cms/emdash/pull/3093) [`ea2ccd5`](https://github.com/emdash-cms/emdash/commit/ea2ccd548f7aba9883bc1c9d0cf3c6f642c10a62) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds Changesets-aware automated plugin releases. `emdash-plugin release setup` detects a root `.changeset/config.json` and offers to follow Changesets releases, `<slug>@<version>` tags, or manual runs. Use `--trigger auto|changesets|tags|manual` in non-interactive setup.
  
  The Changesets variant accepts the official Changesets Action published-package JSON through a reusable workflow. It supports mixed monorepos where npm package names differ from EmDash plugin IDs, ignores ordinary npm packages, verifies every reported plugin version, and publishes matching plugins as a matrix. Private EmDash-only packages produce a setup warning unless Changesets versions and tags them.

### Patch Changes

- Updated dependencies [[`da171b3`](https://github.com/emdash-cms/emdash/commit/da171b3d8d918066e91aa6068e72adbbcd3678de), [`befce6d`](https://github.com/emdash-cms/emdash/commit/befce6dcbbedcf2766d6540214a65f3bbb9e745a), [`4cc150e`](https://github.com/emdash-cms/emdash/commit/4cc150e931313644a96b796627e5ec74b46c0aec)]:
  - @emdash-cms/registry-client@0.6.0
  - @emdash-cms/registry-lexicons@0.5.0

## 0.10.0

### Minor Changes

- [#2892](https://github.com/emdash-cms/emdash/pull/2892) [`66aeecd`](https://github.com/emdash-cms/emdash/commit/66aeecd1feded23c2ee607b799500c390a04eb92) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds interactive package-profile setup for delegated plugin releases. `emdash-plugin release setup` now creates a missing profile or adds delegated-release settings to an existing valid profile before writing the GitHub Actions workflow. Run `emdash-plugin profile setup` to prepare only the profile.

  Interactive setup asks for the GitHub repository when it is absent from `emdash-plugin.jsonc`, lets you choose when releases require approval, and confirms the profile write. Non-interactive callers must pass `--yes` when a profile change is required.

  The release service returns `PACKAGE_PROFILE_REQUIRED` before accepting artifact uploads when the signed profile is missing, lacks delegated-release settings, or names a different GitHub repository. Existing release intents also terminate with an actionable reason if their authoritative profile becomes invalid.

- [#2747](https://github.com/emdash-cms/emdash/pull/2747) [`3b124f2`](https://github.com/emdash-cms/emdash/commit/3b124f23126fead8884884b9f3d53e3be5d41bd3) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds typed clients for the experimental delegated release service. `ReleaseServiceClient` submits, polls, and cancels GitHub OpenID Connect release intents; manages publisher workload policies and retained delegation; and lets publishers check whether profile-listed approvers have an active passkey and inspect publisher-scoped audit events through a publisher session. `ReleaseServiceOperatorClient` exposes the Cloudflare Access status and sanitized audit, sharded publisher and approver inventory, pause, suspension, revocation, cancellation, reconciliation, resumable encryption-key rotation, Workflow-backed fleet verification, audited key retirement, encrypted R2 archive, and fail-safe publisher restore and abort operations.

  `ReleaseServiceClient` can request, poll, list, and confirm GitHub workflow connections. The first permanent release run records GitHub's signed repository, workflow, ref, and environment as a pending request and returns a browser approval URL. The publisher must confirm those details before the service creates a workload policy. Tag-based connections can cover the current tag or all version tags while keeping the repository and workflow path exact.

  Both clients validate response envelopes and return stable `ReleaseServiceError` codes with retry metadata. Mutation helpers require idempotency keys, and workload polling requests a fresh token from the configured provider for each call.

  The plugin CLI adds `emdash-plugin release dry-run`, `release submit`, `release status`, and `release cancel` for GitHub Actions jobs. The first `release submit` requests browser approval for the permanent workflow and waits for confirmation before creating an intent. Dry-run verifies existing workload admission without creating a connection request, intent, consuming rate budget, or reserving a version. The commands request audience-bound OIDC tokens from the runner, support JSON output, and use the GitHub run identity as the default idempotency key where a mutation occurs.

  Delegated submissions use a URL-source release record: each package or listing-image artifact supplies a checksum-bound HTTPS URL and no blob. The service stages and uploads those bytes through the publisher's delegation, then creates a blob-only release record. Submit and dry-run reject mixed or blob-backed source inputs before requesting GitHub OIDC.

  Interactive `release delegate`, `revoke`, `workload`, `enrol`, `approve`, and `reject` commands print validated browser handoffs. Publisher application sessions, OAuth credentials, and passkey assertions remain at the release-service origin instead of entering the terminal process.

- [#2749](https://github.com/emdash-cms/emdash/pull/2749) [`920e1f3`](https://github.com/emdash-cms/emdash/commit/920e1f3fe6a7c7bf725c85e26f81e588e1201243) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `emdash-plugin release setup` to create the permanent GitHub Actions workflow for delegated plugin releases. The generated workflow builds and attests the plugin, waits for first-run browser authorization, and uploads its exact bundle and provenance through GitHub OIDC before publishing.

  `ReleaseServiceClient.uploadReleaseArtifact()` supports custom workflows that need to stage checksum-bound bundle, image, or provenance bytes. Existing URL-source `release submit` workflows remain supported.

### Patch Changes

- [#2864](https://github.com/emdash-cms/emdash/pull/2864) [`ecdba4d`](https://github.com/emdash-cms/emdash/commit/ecdba4d1338447e1a267a3498764f9a1de2a0636) Thanks [@camc314](https://github.com/camc314)! - Updates Zod to 4.5 while keeping EmDash and native plugin schemas on one compatible version. Existing minute-precision ISO datetimes remain valid, and URL content fields continue to enforce configured length and pattern rules.

- [#2743](https://github.com/emdash-cms/emdash/pull/2743) [`d99a0e8`](https://github.com/emdash-cms/emdash/commit/d99a0e835628edca896e304700746707e1bf56e7) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes saved OAuth sessions failing to refresh or revoke after the original loopback callback server closes. New logins retain the loopback client registration needed to recreate the same OAuth client.

  Sessions created before this fix do not contain that registration metadata and cannot be resumed. Sign in again after upgrading.

- [#2894](https://github.com/emdash-cms/emdash/pull/2894) [`3b106f6`](https://github.com/emdash-cms/emdash/commit/3b106f6f87e24a665ecd9007e4001905700b1554) Thanks [@ascorbic](https://github.com/ascorbic)! - Updates `emdash-plugin release setup` to generate workflows that use the hosted release service at `https://releases.emdashcms.com`.

- [#2848](https://github.com/emdash-cms/emdash/pull/2848) [`e0e60ba`](https://github.com/emdash-cms/emdash/commit/e0e60ba17b93d2022411afb8a3187c08e5142c18) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds publisher-created workflow connection invitations to delegated releases. First-time or unmatched GitHub workflows must use a package-bound, single-use invitation before they can request publisher approval; connected workflows continue without one.

  Create the invitation in the publisher dashboard or with `createWorkflowConnectionInvitation()`, then save its value as the repository's `EMDASH_CONNECTION_INVITATION` GitHub Actions secret. The generated release workflow passes this secret to the release Action automatically. Custom workflows can pass `invitationToken` to `requestWorkflowConnection()`, and publishers can reject pending requests with `rejectWorkflowConnection()`.

- Updated dependencies [[`ecdba4d`](https://github.com/emdash-cms/emdash/commit/ecdba4d1338447e1a267a3498764f9a1de2a0636), [`66aeecd`](https://github.com/emdash-cms/emdash/commit/66aeecd1feded23c2ee607b799500c390a04eb92), [`52fffdc`](https://github.com/emdash-cms/emdash/commit/52fffdc3556396f48a5320a0213da1a03337f642), [`3b124f2`](https://github.com/emdash-cms/emdash/commit/3b124f23126fead8884884b9f3d53e3be5d41bd3), [`920e1f3`](https://github.com/emdash-cms/emdash/commit/920e1f3fe6a7c7bf725c85e26f81e588e1201243), [`e0e60ba`](https://github.com/emdash-cms/emdash/commit/e0e60ba17b93d2022411afb8a3187c08e5142c18), [`c7b6fdf`](https://github.com/emdash-cms/emdash/commit/c7b6fdfd1f5dd9a168f5d0f6bfa9b7b9ff343145)]:
  - @emdash-cms/plugin-types@0.3.1
  - @emdash-cms/registry-client@0.5.0

## 0.9.0

### Minor Changes

- [#2765](https://github.com/emdash-cms/emdash/pull/2765) [`9d92b55`](https://github.com/emdash-cms/emdash/commit/9d92b55b0c6b1e8d0506ea11887f18738989c414) Thanks [@ascorbic](https://github.com/ascorbic)! - Updates plugin publishing to host package bundles, icons, banners, and screenshots as blobs on the publisher's Personal Data Server by default. Run `emdash-plugin publish` from the plugin directory; the CLI builds the bundle, checks the stored OAuth grant, uploads the artifacts, and writes CID-bound checksums into the release record.

  Existing scripts can keep externally hosted package bundles with `emdash-plugin publish --url <https-url>`. The CLI still downloads that URL to validate and hash the served bytes. Listing images are uploaded as publisher blobs on both paths.

  The experimental aggregator release envelope replaces `mirrors` with typed `artifactCaches`. The field is optional during rolling upgrades, and updated clients treat an omitted field as an empty cache list. A record-scoped cache descriptor supplies its service endpoint; clients derive `/r/{did}/{collection}/{rkey}/{recordCid}/{blobCid}` so cache admission is bound to the exact release revision.

  Install and update verify raw cache, PDS, and external fallback bytes against the signed checksum and blob metadata. The authenticated image proxy may serve a transformed record-scoped cache rendition; if that cache is unavailable, it falls back to checksum-verified PDS or external bytes. Listing images remain capped at 1 MiB.

  Sites must upgrade EmDash before installing a release whose package artifact is available only as a PDS blob. Older EmDash versions require an external package URL.

  #### What should I do?

  Remove `--artifact-base-url` from publish scripts and stop pre-uploading listing images. The CLI rejects the removed option with migration guidance. Replace any experimental `releaseView.mirrors` access with `releaseView.artifactCaches ?? []`. If an existing granular login reports `MISSING_BLOB_SCOPE`, run `emdash-plugin logout` and log in again to grant `blob:application/gzip` and `blob:image/*`.

### Patch Changes

- Updated dependencies [[`9d92b55`](https://github.com/emdash-cms/emdash/commit/9d92b55b0c6b1e8d0506ea11887f18738989c414), [`6178888`](https://github.com/emdash-cms/emdash/commit/61788888bf5933e2a9ac310a931f1c241fa63878), [`e3ad082`](https://github.com/emdash-cms/emdash/commit/e3ad0823121704c508cd104783a59fccd3f6a44e)]:
  - @emdash-cms/registry-client@0.4.0
  - @emdash-cms/registry-lexicons@0.4.0

## 0.8.1

### Patch Changes

- [#2504](https://github.com/emdash-cms/emdash/pull/2504) [`cd4268d`](https://github.com/emdash-cms/emdash/commit/cd4268d1d114e827124810a09fe4edc27aa5f784) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes image processing hangs caused by malformed ICNS, HEIF, and JXL headers in media and plugin artifacts.

## 0.8.0

### Minor Changes

- [#2002](https://github.com/emdash-cms/emdash/pull/2002) [`e52dea9`](https://github.com/emdash-cms/emdash/commit/e52dea9b72b043d62348f8d01eefade2ce66484c) Thanks [@jcheese1](https://github.com/jcheese1)! - Adds explicitly declared, administrator-enabled plugin MCP tools with per-route permissions, plugin-scoped token access, install and update consent, structured output schemas, and invocation auditing.

### Patch Changes

- Updated dependencies [[`07c9f21`](https://github.com/emdash-cms/emdash/commit/07c9f210db300803f49ecf2b8a18fe173e459a28), [`e52dea9`](https://github.com/emdash-cms/emdash/commit/e52dea9b72b043d62348f8d01eefade2ce66484c), [`3f8b778`](https://github.com/emdash-cms/emdash/commit/3f8b77822bf8e89b065884c53c7e8b7676788c48), [`07c9f21`](https://github.com/emdash-cms/emdash/commit/07c9f210db300803f49ecf2b8a18fe173e459a28)]:
  - @emdash-cms/registry-lexicons@0.3.0
  - @emdash-cms/plugin-types@0.3.0
  - @emdash-cms/registry-client@0.3.4

## 0.7.0

### Minor Changes

- [#1719](https://github.com/emdash-cms/emdash/pull/1719) [`7c5de08`](https://github.com/emdash-cms/emdash/commit/7c5de08f6370ea88500b7ec425d58b2c82443260) Thanks [@swissky](https://github.com/swissky)! - Adds a `taxonomies:read` plugin capability with read-only taxonomy access: plugins that declare it get `ctx.taxonomies` to list taxonomy definitions (`getAll()`), fetch the terms of a taxonomy (`getTerms()`), and read the terms assigned to a content entry (`getEntryTerms()`) — in-process and in both sandbox runners.

### Patch Changes

- Updated dependencies [[`7c5de08`](https://github.com/emdash-cms/emdash/commit/7c5de08f6370ea88500b7ec425d58b2c82443260)]:
  - @emdash-cms/plugin-types@0.2.0
  - @emdash-cms/registry-lexicons@0.2.0
  - @emdash-cms/registry-client@0.3.3

## 0.6.0

### Minor Changes

- [#1461](https://github.com/emdash-cms/emdash/pull/1461) [`b01aa9b`](https://github.com/emdash-cms/emdash/commit/b01aa9bbb436bcec07516b499eb0516cfbe414b4) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes registry installs failing with "Plugin manifest has changed since you consented" for plugins that declare hook-registration capabilities (email transport, email events, page fragments) or read user records. Plugin bundles now declare their access as a structured `declaredAccess` contract that the registry record, the install-consent dialog, and the sandbox all read consistently, so every capability a plugin declares is shown for consent and enforced — no capability is silently dropped. Re-publish affected plugins to adopt the new bundle format; existing installs are unaffected.

### Patch Changes

- [#1447](https://github.com/emdash-cms/emdash/pull/1447) [`141aa11`](https://github.com/emdash-cms/emdash/commit/141aa11213206d9ea5e14d1f1cd75c07cfacae7b) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes `@atcute` peer dependency warnings on install ([#1435](https://github.com/emdash-cms/emdash/issues/1435))

  Installing EmDash pulled in mismatched `@atcute` package versions, so `pnpm install` / `npm install` reported unmet peer warnings for `@atcute/identity` and `@atcute/lexicons`. The bundled `@atcute` dependencies are now aligned on v2 and installs are clean. If your project also depends on `@atcute` packages directly, note they have moved to v2 (`@atcute/client` 5, `@atcute/lexicons` 2, `@atcute/atproto` 4, `@atcute/oauth-node-client` 2).

- Updated dependencies [[`141aa11`](https://github.com/emdash-cms/emdash/commit/141aa11213206d9ea5e14d1f1cd75c07cfacae7b), [`b01aa9b`](https://github.com/emdash-cms/emdash/commit/b01aa9bbb436bcec07516b499eb0516cfbe414b4)]:
  - @emdash-cms/registry-client@0.3.2
  - @emdash-cms/registry-lexicons@0.1.1
  - @emdash-cms/plugin-types@0.1.0

## 0.5.1

### Patch Changes

- Updated dependencies [[`69bdc97`](https://github.com/emdash-cms/emdash/commit/69bdc97e3e4b69a111b3e5210900e23f35134f8d)]:
  - @emdash-cms/registry-client@0.3.1

## 0.5.0

### Minor Changes

- [#1238](https://github.com/emdash-cms/emdash/pull/1238) [`60c0b2e`](https://github.com/emdash-cms/emdash/commit/60c0b2eeab7726471b313d0c453de82df1e08558) Thanks [@ascorbic](https://github.com/ascorbic)! - Registry plugins can now declare environment requirements. A plugin's manifest may set a release-level `requires` block (e.g. `{ "env:emdash": ">=1.0.0", "env:astro": ">=4.16" }`), which is published into the release record. When browsing a registry plugin, the admin compares those constraints against the running EmDash and Astro versions: if the host doesn't satisfy them, it shows a compatibility warning and disables the Install button. The server enforces the same check on install and update, refusing an incompatible release with `ENV_INCOMPATIBLE` so the gate can't be bypassed.

- [#1239](https://github.com/emdash-cms/emdash/pull/1239) [`1a4918f`](https://github.com/emdash-cms/emdash/commit/1a4918ff989d57b4f12e44b647542e406dce7cb9) Thanks [@ascorbic](https://github.com/ascorbic)! - Plugins published to the experimental registry can now ship icon, screenshot, and banner images. Declare them in `emdash-plugin.jsonc` under `release.artifacts` as file refs; `emdash-plugin publish --artifact-base-url <url>` measures each image's dimensions, uploads it, and records it in the release. The admin plugin detail page renders the icon, banner, and a screenshot gallery, fetched through a server-side image proxy. The proxy resolves each artifact's URL server-side from the validated release record (the client sends only the artifact's coordinates, never a URL), then applies SSRF defences and an image content-type allowlist before serving the bytes. Supported image types are PNG, JPEG, WebP, GIF, and AVIF; SVG is rejected at both publish and proxy because it is active content.

- [#1253](https://github.com/emdash-cms/emdash/pull/1253) [`d2f2679`](https://github.com/emdash-cms/emdash/commit/d2f26792bc8f053693bfb0a6a9d65a7403753f0a) Thanks [@ascorbic](https://github.com/ascorbic)! - Plugins published to the experimental registry can now ship long-form profile sections. Declare them in `emdash-plugin.jsonc` under a top-level `sections` block with any of `description`, `installation`, `faq`, `changelog`, and `security`. Each value is either inline CommonMark Markdown or a `{ file: "./path.md" }` ref read relative to the manifest at load time. Every section is capped at 20000 bytes and 2000 graphemes, enforced locally (inline strings during schema validation, file refs once their content is read) so `emdash-plugin validate`/`publish` fails with a clear message instead of a 400 from the PDS. File refs are resolved within the manifest directory; paths that escape it (via `..` or an absolute path) are rejected. Sections are profile-level: written to the package profile record on first publish and editable afterward with `emdash-registry update-package`, like the other profile fields.

### Patch Changes

- [#1247](https://github.com/emdash-cms/emdash/pull/1247) [`245f8dc`](https://github.com/emdash-cms/emdash/commit/245f8dc221913853d720963d899a8b2d62053985) Thanks [@mvanhorn](https://github.com/mvanhorn)! - Fixes plugin builds on Windows by importing the probe artifact through a file URL.

- Updated dependencies [[`60c0b2e`](https://github.com/emdash-cms/emdash/commit/60c0b2eeab7726471b313d0c453de82df1e08558)]:
  - @emdash-cms/registry-client@0.3.0

## 0.4.0

### Minor Changes

- [#1126](https://github.com/emdash-cms/emdash/pull/1126) [`cf3c706`](https://github.com/emdash-cms/emdash/commit/cf3c706a65087696eb6cca5844b7668a50e4a090) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `emdash-plugin update-package`, a CLI command for editing an already-published plugin's registry record (license, authors, security contacts, name, description, keywords) without cutting a new release. Without `--yes` it prints a diff and exits without writing; with `--yes` it writes the updated record to the publisher's PDS using atproto's `swapRecord` precondition (concurrent writes surface as `STALE_RECORD` instead of silently overwriting each other) and bumps `lastUpdated`. Optional fields use a "manifest absent = no change" policy: removing a key from the manifest doesn't wipe the published value, matching `publish` semantics. Renaming a plugin via the manifest now surfaces a "looks like a rename" message listing the publisher's existing packages instead of a generic not-found, so publishers don't accidentally orphan releases under the old slug.

  The publishing client (`@emdash-cms/registry-client`) gains a `swapRecord` parameter on `putRecord` and `unsafePutRecord` for callers needing optimistic-concurrency writes.

### Patch Changes

- [#1145](https://github.com/emdash-cms/emdash/pull/1145) [`463c7a2`](https://github.com/emdash-cms/emdash/commit/463c7a23036d55fee3f5105c1a878c9abdee2e1f) Thanks [@ascorbic](https://github.com/ascorbic)! - Refactors the build pipeline's runtime validation of the probed plugin's
  default export to use a Zod schema. Error messages keep the same format
  (`hook "X" must be a function or { handler, ... }`, `hook "X" has
invalid FIELD VALUE (...)`). Exotic-object entries (Date, RegExp,
  Promise, class instances) now produce the wrong-shape error instead of
  falling through to a misleading "missing handler" error. BigInt /
  cyclic-object / function / symbol field values are rendered safely in
  error messages instead of crashing with a TypeError.
- Updated dependencies [[`cf3c706`](https://github.com/emdash-cms/emdash/commit/cf3c706a65087696eb6cca5844b7668a50e4a090)]:
  - @emdash-cms/registry-client@0.2.0

## 0.3.0

### Minor Changes

- [#1112](https://github.com/emdash-cms/emdash/pull/1112) [`3756168`](https://github.com/emdash-cms/emdash/commit/37561682224447c7280648dc770ab408afc4186a) Thanks [@ascorbic](https://github.com/ascorbic)! - Publishes the full profile block from `emdash-plugin.jsonc`. First publish now writes `name`, `description`, `keywords`, multiple authors, and multiple security contacts to the package profile record, plus the source `repo` URL to the release record — previously only `license` and a single author/security contact were sent.

  Deprecates the `--license`, `--author-*`, and `--security-*` flags in favour of declaring these in `emdash-plugin.jsonc`. The flags still work and override the manifest when both are present; a deprecation warning is printed when they are used.

### Patch Changes

- Updated dependencies [[`3756168`](https://github.com/emdash-cms/emdash/commit/37561682224447c7280648dc770ab408afc4186a)]:
  - @emdash-cms/registry-client@0.1.0

## 0.2.0

### Minor Changes

- [#1040](https://github.com/emdash-cms/emdash/pull/1040) [`e6f7311`](https://github.com/emdash-cms/emdash/commit/e6f731163d7595a99b12105652aa0459e4dc8c7f) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `emdash-plugin.jsonc` manifest support. Plugin authors can now declare profile fields (license, author, security contact, name, description, keywords, repo) once in a hand-edited JSONC file instead of passing them as flags on every publish. The CLI loads `./emdash-plugin.jsonc` automatically; explicit flags still win for CI use.

  New `emdash-plugin validate` command checks a manifest against the schema offline with `tsc`-style file:line:column diagnostics.

  The manifest's optional `publisher` field pins the publishing identity. On first successful publish, the CLI writes the active session's DID back to the manifest. Subsequent publishes verify the active session matches the pinned publisher and refuse on mismatch to prevent accidental cross-account publishes.

  JSON Schema for IDE completion ships in the package at `schemas/emdash-plugin.schema.json`; reference it via `"$schema": "./node_modules/@emdash-cms/plugin-cli/schemas/emdash-plugin.schema.json"`.

- [#1057](https://github.com/emdash-cms/emdash/pull/1057) [`c0ce915`](https://github.com/emdash-cms/emdash/commit/c0ce915c555b8658245d465255e2ec89b361c57f) Thanks [@ascorbic](https://github.com/ascorbic)! - Renames `@emdash-cms/registry-cli` to `@emdash-cms/plugin-cli` and the binary from `emdash-registry` to `emdash-plugin`. The package's job has outgrown the original name — `init`, `build`, `dev`, `bundle`, `publish`, `search`, `info`, `login`, `logout`, `whoami`, and `switch` cover plugin authoring + identity + discovery, not just registry interaction. Adopt the new name on first install; the old package is no longer published.

  This release also adds `emdash-plugin build` and `emdash-plugin dev` and consolidates the build pipeline so `bundle` is a thin packaging step on top of `build`.

  **`emdash-plugin build`** reads `emdash-plugin.jsonc` and `src/plugin.ts`, then emits:
  - `dist/plugin.mjs` (+ `dist/plugin.d.mts`) — runtime bytes (hooks + routes). The same artifact is consumed both in-process (when the plugin is in `plugins: []`) and by the sandbox loader (when in `sandboxed: []`).
  - `dist/manifest.json` — wire-shape `PluginManifest` including hooks + routes harvested from probing `src/plugin.ts`. `bundle` packs this verbatim into the registry tarball; on the npm path it's metadata that consumers can read without parsing JSONC.
  - `dist/index.mjs` (+ `dist/index.d.mts`) — descriptor module that default-exports a bare `PluginDescriptor` object. Emitted only when a sibling `package.json` exists (registry-only plugins skip this, since nothing would import it).

  **`emdash-plugin dev`** watches `src/**`, `emdash-plugin.jsonc`, and `package.json`, debouncing rebuilds at 150ms. On a failed rebuild it leaves the last good `dist/` in place so a downstream site importing the plugin keeps working until the next successful build. Stop with Ctrl-C.

  A typical plugin `package.json`:

  ```json
  {
  	"scripts": {
  		"build": "emdash-plugin build",
  		"dev": "emdash-plugin dev"
  	}
  }
  ```

  **`version` in `emdash-plugin.jsonc` is now optional.** The build reconciles the manifest's `version` with `package.json#version`:
  - Both set and matching → fine.
  - Both set and different → hard error.
  - One set → that value wins.
  - Neither set → hard error.

  The recommended pattern for npm-distributed plugins is to omit `version` from the manifest and let `package.json` be the source of truth. Registry-only plugins (no `package.json`) must set `version` in the manifest.

  **`emdash-plugin bundle`** has been reduced to a packaging step: it now calls `build` to produce `dist/`, validates the bundle contents (no Node-builtin imports, no oversized files, capability sanity), collects optional assets (README, icon, screenshots), and tarballs. Inside the tarball, `plugin.mjs` is renamed to `backend.js` to match the registry's wire-side filename. `validateOnly` still skips tarball creation but now produces the `dist/` artifacts (since "validate" implies "build first").

### Patch Changes

- [#1091](https://github.com/emdash-cms/emdash/pull/1091) [`6725e91`](https://github.com/emdash-cms/emdash/commit/6725e914319dc0f0e6a4b0442694fa9e9757e4af) Thanks [@ascorbic](https://github.com/ascorbic)! - Renames the multi-word flags on `build`, `dev`, and `bundle` from camelCase to kebab-case for consistency with `publish` and standard Unix CLI convention.
  - `--outDir` -> `--out-dir`
  - `--validateOnly` -> `--validate-only`

  The short alias `-o` for `--out-dir` is unchanged.

- [#1092](https://github.com/emdash-cms/emdash/pull/1092) [`6788829`](https://github.com/emdash-cms/emdash/commit/67888292c85c56dda3b39450a020353fb0f17cc8) Thanks [@ascorbic](https://github.com/ascorbic)! - Renames the `--aggregator` flag on `search` and `info` to `--registry-url` for consistency with the `EMDASH_REGISTRY_URL` env var and the rest of the user-facing surface. Internally the override still selects the aggregator service to query — the rename only affects what users type.

  Old:

  ```sh
  emdash-plugin search "image" --aggregator https://registry.example.com
  ```

  New:

  ```sh
  emdash-plugin search "image" --registry-url https://registry.example.com
  ```

## 0.1.0

### Minor Changes

- [#978](https://github.com/emdash-cms/emdash/pull/978) [`27e6d58`](https://github.com/emdash-cms/emdash/commit/27e6d58ec1ba547ece4736ac0a87309812a95681) Thanks [@ascorbic](https://github.com/ascorbic)! - Enforces the sandboxed plugin bundle size caps from RFC 0001 §"Bundle size limits" in both the `bundle` and `publish` CLI flows: total decompressed ≤ 256 KB, per-file decompressed ≤ 128 KB, and at most 20 files per bundle. The previous bundle command capped only the total at 5 MB; the publish command now also re-validates the decompressed tarball before signing the release record so a publisher hits the same cap locally that aggregators enforce at ingest. Bundles between 256 KB and the old 5 MB ceiling will now be rejected — usually a sign the plugin is bundling host-provided dependencies or assets that belong in a CDN rather than the plugin payload.

### Patch Changes

- [#929](https://github.com/emdash-cms/emdash/pull/929) [`5464b55`](https://github.com/emdash-cms/emdash/commit/5464b551f0100d33fe9adbdd74d3444d37321209) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes the CLI hanging indefinitely after a successful `login` or `logout`. `run()` was returning correctly, but something in the OAuth path left a ref'd handle alive that prevented Node's event loop from draining. Workaround: force-exit at the top level once `runMain` resolves. The underlying handle leak is unidentified.

- [#929](https://github.com/emdash-cms/emdash/pull/929) [`5464b55`](https://github.com/emdash-cms/emdash/commit/5464b551f0100d33fe9adbdd74d3444d37321209) Thanks [@ascorbic](https://github.com/ascorbic)! - Switches the login flow to request granular OAuth scopes derived from the `@emdash-cms/registry-lexicons` lexicon set instead of the broad `transition:generic`: `repo:` for every record-shaped lexicon (package profile, package release, publisher profile, publisher verification) and `rpc:<nsid>?aud=*` for every aggregator query (`getLatestRelease`, `getPackage`, `listReleases`, `resolvePackage`, `searchPackages`). Display name resolution no longer goes through `com.atproto.server.getSession`; the handle is read from the DID document via `LocalActorResolver` so the CLI doesn't need an `rpc:com.atproto.*` scope and isn't affected by PDS-side DPoP/Bearer compatibility quirks. If the PDS rejects the granular scopes with `invalid_scope`, login automatically retries once with `transition:generic` and prints a notice. Existing sessions continue working with their original scope until they're revoked or re-issued.

- [#929](https://github.com/emdash-cms/emdash/pull/929) [`5464b55`](https://github.com/emdash-cms/emdash/commit/5464b551f0100d33fe9adbdd74d3444d37321209) Thanks [@ascorbic](https://github.com/ascorbic)! - Improves `login` error reporting for OAuth response failures. Previously, transient PDS errors surfaced as a bare `unknown_error` with a stack trace; the CLI now prints the HTTP status, endpoint, OAuth error code/description, a body snippet when the response wasn't OAuth-shaped JSON, and a hint to retry on 5xx responses.

- [#923](https://github.com/emdash-cms/emdash/pull/923) [`943df46`](https://github.com/emdash-cms/emdash/commit/943df46d62043df386eef4664fbba4710be16c31) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `@emdash-cms/registry-cli`: standalone CLI for the experimental plugin registry. Subcommands for `login`, `logout`, `whoami`, `switch`, `search`, `info`, `bundle`, and `publish`. Atproto OAuth via loopback callback server. The `publish` flow fetches the tarball from the URL, verifies a sha256 multihash, extracts and validates `manifest.json`, locally validates each lexicon record, and atomically writes profile + release records (with the EmDash declaredAccess trust extension) via a single atproto `applyWrites`. Distributes via `npx @emdash-cms/registry-cli` to keep atproto deps out of the core CMS install.

- Updated dependencies [[`943df46`](https://github.com/emdash-cms/emdash/commit/943df46d62043df386eef4664fbba4710be16c31), [`943df46`](https://github.com/emdash-cms/emdash/commit/943df46d62043df386eef4664fbba4710be16c31), [`5464b55`](https://github.com/emdash-cms/emdash/commit/5464b551f0100d33fe9adbdd74d3444d37321209), [`943df46`](https://github.com/emdash-cms/emdash/commit/943df46d62043df386eef4664fbba4710be16c31)]:
  - @emdash-cms/plugin-types@0.0.1
  - @emdash-cms/registry-client@0.0.1
  - @emdash-cms/registry-lexicons@0.1.0
