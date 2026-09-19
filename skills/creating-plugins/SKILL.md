---
name: creating-plugins
description: Create EmDash CMS plugins with sandboxed hooks, routes, storage, media, MCP tools, and declarative admin UI, or native React and Astro extensions. Use when scaffolding or implementing an EmDash plugin.
---

# Creating EmDash plugins

Build against the API that reaches the intended execution mode. Source types and production-boundary tests take precedence over examples in this skill when they disagree.

## Choose a format

| Format    | Runtime source                                      | Admin UI                               | Distribution                 |
| --------- | --------------------------------------------------- | -------------------------------------- | ---------------------------- |
| Sandboxed | `src/plugin.ts` default-exports a `SandboxedPlugin` | Block Kit pages and widgets            | Plugin CLI and registry      |
| Native    | `definePlugin()` / `createPlugin()`                 | React, Block Kit, and Astro components | Trusted site dependency only |

Use a sandboxed plugin unless the feature needs host-process access, React admin code, or Astro rendering components. Native plugins run with the site's authority and cannot be installed from the registry.

## Scaffold a sandboxed plugin

Run the initializer once, then use the pinned CLI from the generated project:

```sh
pnpm dlx @emdash-cms/plugin-cli init my-plugin
cd my-plugin
pnpm install
pnpm run test
```

The generated project uses these sources:

```text
emdash-plugin.jsonc  Identity, capabilities, allowed hosts, storage, and admin navigation
src/plugin.ts        Runtime hooks, routes, and MCP tools
tests/               Workerd tests through the production Cloudflare wrapper and bridge
dist/                Generated descriptor, manifest, and runtime bundle
```

Do not create a separate descriptor factory or `sandbox-entry.ts` in a plugin CLI project. `emdash-plugin build` generates the descriptor and the `./sandbox` export from `emdash-plugin.jsonc` and `src/plugin.ts`.

Author the runtime as a typed default export:

```typescript title="src/plugin.ts"
import type { SandboxedPlugin } from "emdash/plugin";

const plugin: SandboxedPlugin = {
	hooks: {
		"content:afterSave": async (event, ctx) => {
			ctx.log.info("Content saved", { id: event.content.id });
		},
	},
	routes: {
		health: {
			handler: async (_routeCtx, ctx) => ({ ok: true, pluginId: ctx.plugin.id }),
		},
	},
};

export default plugin;
```

Keep imports from `emdash/plugin` type-only. Sandboxed runtime code can use Web APIs but not Node.js built-ins.

## Manifest trust contract

Declare host access in `emdash-plugin.jsonc`. Capabilities, allowed hosts, and storage declarations are reviewed during installation and must match the runtime code.

```jsonc title="emdash-plugin.jsonc"
{
	"slug": "my-plugin",
	"capabilities": ["content:read", "taxonomies:read", "media:write"],
	"allowedHosts": [],
	"storage": {
		"jobs": { "indexes": ["status", "createdAt"] },
	},
	"admin": {
		"pages": [{ "path": "/settings", "label": "Settings" }],
	},
}
```

Use only canonical capability names:

| Capability                       | API or hook registration                                                 |
| -------------------------------- | ------------------------------------------------------------------------ |
| `content:read`                   | `ctx.content.get()`, `list()`, `getTranslations()`, `getPublicUrl()`     |
| `content:revisions:read`         | `ctx.content.listRevisions()`, `getRevision()`; implies content read     |
| `content:write`                  | `ctx.content.create()`, `update()`, `delete()`; implies read             |
| `comments:read`                  | `ctx.comments.get()`, `list()`, `count()`; exposes comment personal data |
| `comments:moderate`              | `ctx.comments.setStatus()` with expected status; implies read            |
| `schema:read`                    | `ctx.schema.listCollections()`, `getCollection()`                        |
| `taxonomies:read`                | `ctx.taxonomies.getAll()`, `getTerms()`, `getEntryTerms()`               |
| `taxonomies:write`               | `createTerm()`, `addEntryTerms()`, `removeEntryTerms()`; implies read    |
| `redirects:read`                 | `ctx.redirects.list()`, `get()`                                          |
| `redirects:write`                | `ctx.redirects.create()`, `update()`, `delete()`; implies read           |
| `media:read`                     | `ctx.media.get()`, `ctx.media.list()`                                    |
| `media:bytes:read`               | `ctx.media.readBytes()` for bounded bytes from ready media               |
| `media:metadata:write`           | `ctx.media.updateMetadata()` for alt, caption, and focal point           |
| `media:write`                    | `ctx.media.upload()`, `ctx.media.delete()`; implies read                 |
| `network:request`                | `ctx.http.fetch()` restricted to `allowedHosts`                          |
| `network:request:unrestricted`   | `ctx.http.fetch()` without a manifest host list                          |
| `users:read`                     | `ctx.users.get()`, `getByEmail()`, `list()`; required by comment hooks   |
| `email:send`                     | `ctx.email.send()` when a transport is configured                        |
| `hooks.email-transport:register` | Exclusive `email:deliver` hook                                           |
| `hooks.email-events:register`    | `email:beforeSend` and `email:afterSend` hooks                           |
| `hooks.page-fragments:register`  | Declares `page:fragments`; sandbox builds warn and the host excludes it  |

The old `read:*`, `write:*`, `network:fetch*`, `email:provide`, `email:intercept`, and `page:inject` names are deprecated. Validation warns about them and publishing rejects them.

Settings, KV, and declared storage need no capability. They are always scoped to the plugin. Installation shows capability consent; updates require renewed approval when declared access grows. MCP tools and routes becoming public have separate consent checks.

Content reads include the entry's author ID, translation group, live and draft revision pointers, and row version. `getPublicUrl()` returns only published, routable URLs and never returns a preview URL. Revision snapshots require `content:revisions:read`; their retained field data can include values that an administrator removed later, but revision author identity is not exposed.

Create a content translation with `ctx.content.create(collection, data, { locale, translationOf })`. `translationOf` is an active entry ID in the same collection. The new row joins its translation group, inherits byline credits and taxonomy assignments, and takes non-translatable field values from the source. Runtime content validation and save hooks still run, except the creating plugin's own `content:afterSave` hook is not re-entered and content created inside a save hook does not run save hooks again. A translation group permits one active row per locale; duplicate locale creates return `CONFLICT`, missing sources return `NOT_FOUND`, invalid locales return `VALIDATION_ERROR`, and hooks can return `SAVE_REJECTED`.

## Portable plugin context

Hooks receive `(event, ctx)`. Sandboxed routes receive `(routeCtx, ctx)`.

```typescript
interface PluginContext {
	plugin: { id: string; version: string };
	storage: Record<string, StorageCollection>;
	settings: SettingsAccess;
	kv: KVAccess;
	log: LogAccess;
	site: SiteInfo;
	url(path: string): string;
	cron?: CronAccess;
	content?: ContentAccess;
	schema?: SchemaAccess;
	taxonomies?: TaxonomyAccess;
	redirects?: RedirectAccess;
	media?: MediaAccess;
	http?: HttpAccess;
	users?: UserAccess;
	email?: EmailAccess;
}
```

Optional properties appear only when the matching capability and host configuration are present.

Taxonomy assignment writes accept term row IDs or translation-group IDs, not term slugs. `addEntryTerms()` and `removeEntryTerms()` apply idempotent deltas, so concurrent additions do not replace one another. The host validates taxonomy attachment, entry existence, term ownership, locale, translations, and hierarchy. `createTerm()` rejects `parentId` for a non-hierarchical taxonomy instead of ignoring it. Taxonomy-definition management, assignment replacement, term updates, and term deletion are not exposed.

## Routes and MCP tools

Routes are private by default. Every private invocation requires authentication, the declared RBAC `permission` (default `plugins:manage`), the `admin` token scope for token calls, and CSRF protection for cookie calls. `routeCtx.user` is the authenticated caller on private routes and is independent of `users:read`. Public routes never receive a caller.

`routeCtx.request` is the portable `{ url, method, headers }` record. `routeCtx.requestMeta` carries `{ ip, userAgent, referer, geo }`, with unavailable values set to `null`. Validate `routeCtx.input`; the sandbox build does not preserve a route-level Zod parser.

Core supports `cacheControl` on successful public `GET` and `HEAD` responses. The plugin CLI preserves it in the bundle manifest and generated descriptor. Private responses and errors remain `private, no-store`.

Expose an MCP tool explicitly under `mcp.tools`. Its route must be private and declare a permission. The tool needs an input Zod schema; the output schema is optional. Mark difficult-to-reverse operations `destructive: true`. Administrators review and enable plugin MCP tools separately, and callers need the route permission plus `mcp:tools` or `mcp:tools:<pluginId>` scope.

Read [API routes](./references/api-routes.md) for complete route and MCP examples.

## Storage and media

Use `ctx.settings` for settings and `ctx.kv` for small internal state. A field declared as `secret` in `admin.settingsSchema` is encrypted before persistence. Use a declared `ctx.storage.<collection>` for records, indexed queries, batch operations, `updateIf()`, and revision-based compare-and-set/delete. Re-read after a CAS conflict and keep retries bounded. Read [Storage, KV, and settings](./references/storage.md) for the full operation list, encryption-key requirements, and concurrency behavior.

Sandboxed plugins cannot follow a presigned upload URL directly. With `media:write`, upload bytes through the bridge:

```typescript
const bytes = await source.arrayBuffer();
const uploaded = await ctx.media!.upload("report.pdf", "application/pdf", bytes);
```

Both sandbox runners write the bytes through the configured media storage adapter and create a ready media record. `getUploadUrl()` is not available inside either sandbox runner. Accepted content types are images, video, audio, and PDF.

Use `media:read` for ready-media metadata. It includes dimensions, alt text, caption, focal point, blurhash, dominant color, folder ID, and an authenticated ID-based asset URL. Authenticated callers with the `media:read` permission can follow the URL; logged-out requests stop before the route reads the media record. Metadata excludes storage keys, author identity, content hashes, and bytes. Content hashes are visible only with `media:bytes:read` because they can reveal whether the site stores a known file.

`ctx.media!.readBytes!(id, { maxBytes })` buffers bytes from the configured storage adapter. The default is 10 MiB and the host maximum is 16 MiB. The host enforces the requested limit while reading the stream, even when stored size metadata is wrong.

With `media:metadata:write`, `ctx.media!.updateMetadata!()` changes only alt text, caption, and a complete focal-point pair. It cannot upload, replace, move, or delete a file. `media:read`, `media:bytes:read`, and `media:metadata:write` are independent declarations; `media:write` retains its existing implication of `media:read`.

## Hooks

Declare hooks in `src/plugin.ts`; declare any required capability in the manifest. Registry-installed and config-managed sandbox plugins enter the same host hook pipeline as trusted plugins while their handlers stay inside the runner isolate. The pipeline applies priority, dependencies, timeout, error policy, enable/disable state, exclusive-provider selection, and capability fencing.

The comment lifecycle is:

1. `comment:beforeCreate` can enrich the event or return `false` to reject it.
2. The exclusive `comment:moderate` provider returns `approved`, `pending`, or `spam`.
3. `comment:afterCreate` runs after storage.
4. `comment:afterModerate` runs after an administrator changes the status.

All four comment hooks require `users:read` because their events contain author and request information. `comments:read` separately exposes stored non-trashed comments through `ctx.comments`, including author email, body, pseudonymous IP hash, user agent, and moderation metadata, but not the linked user-account ID. `comments:moderate` implies read and adds expected-status `setStatus()`; conflicts require a fresh read, successful transitions run `comment:afterModerate` once with plugin origin, and approvals preserve core author notifications. Lifecycle, media, email, comment, cron, content, and `page:metadata` hooks are dispatched to sandboxed plugins. `page:fragments` is the exception: the CLI accepts it with a trusted-only warning, and the sandbox proxy excludes it from host registration.

Read [Hooks](./references/hooks.md) for event and return types.

## Declarative admin UI

Sandboxed pages and dashboard widgets use Block Kit responses from a private `admin` route. The current validated block vocabulary includes `empty` and `accordion`; the element vocabulary includes `repeater` and `media_picker` in addition to the scalar form elements. A `tab` type and builder exist, but `validateBlocks()` currently rejects that block, so do not return it. Read [Block Kit](./references/block-kit.md) for exact shapes and where each element can render.

Core and the admin also have a declarative field-widget path: declare the widget under `admin.fieldWidgets` in `emdash-plugin.jsonc`, then point a schema field at `pluginId:widgetName`. The plugin CLI preserves field widgets in registry manifests and generated descriptors. The field editor currently renders `text_input`, `number_input`, `toggle`, `select`, and `media_picker` elements and combines their values into one object keyed by `action_id`. Use a `json` field for that object; other field types are accepted by the manifest schema but have no end-to-end proof that the composed value can be saved. Other element types show an unsupported-element message.

The registry transport is covered through the generated artifact boundary. The repository's browser E2E coverage still exercises a native React field widget rather than a registry-installed declarative widget, so verify the rendered editor and value persistence for the chosen elements.

Custom Portable Text block definitions and their Astro render components remain native-only for plugin CLI and registry packages. Core can forward declarative block metadata from a config-declared standard descriptor, but the CLI warns that `portableTextBlocks` are ignored and does not serialize them. Do not describe registry Portable Text blocks as supported.

Read [Admin UI](./references/admin-ui.md) and [Portable Text blocks](./references/portable-text-blocks.md) for the two boundaries.

## Runner parity

Both runners execute the same plugin bundle in a V8 isolate and gate host calls through a plugin-scoped bridge.

| Runner     | Isolation and limits                                         | Host bridge                                                                     |
| ---------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Cloudflare | Dynamic Worker Loader; CPU, subrequest, and wall-time limits | Worker entrypoint RPC; D1 and configured R2 media binding                       |
| Node.js    | Managed workerd process; wall-time limit only                | Authenticated local HTTP backing service; configured database and media adapter |

Both runners enforce canonical capability names and return a real WHATWG `Response` from `ctx.http.fetch()`. The Cloudflare bridge reconstructs that response from decoded text, so binary response bodies are not portable; the Node/workerd bridge preserves response bytes. Write against the exported `PluginContext`, not extra methods found in one wrapper. The Node/workerd wrapper still exposes undeclared `ctx.content.createMany()`, `updateMany()`, and `deleteMany()` methods that the Cloudflare wrapper and public types do not provide.

## Remaining sandbox boundaries

The sandbox contract is intentionally smaller than EmDash's full trusted runtime. Read [Sandbox boundaries](./references/sandbox-boundaries.md) before designing content lifecycle, localization, schema, media, comment, route, settings, or admin-editor features. It lists the current cross-runner transport caveats and APIs that do not exist yet; do not invent host calls around those gaps.

## Test the production boundary

Use `@emdash-cms/plugin-test` in `vitest.config.ts` and create a fresh transport host per test:

```typescript
import { createPluginTestHost } from "@emdash-cms/plugin-test";

const host = await createPluginTestHost();
await host.invokeHook("content:afterSave", event);
await host.invokeRoute("health", {}, { user, meta });
await host.dispose();
```

The direct host builds the plugin and invokes it through Cloudflare Worker Loader, the production wrapper, and `PluginBridge`. It preserves hook, route, MCP, settings, and field-widget manifest metadata, supports content fixtures, and exposes KV and declared storage for assertions. Its `invokeHook()` and `invokeRoute()` methods test the transport. They do not prove that a host action emits the hook or applies route authentication, permissions, CSRF, and response caching.

Use `createPluginRuntimeTestHost()` when the test must exercise content, plugin activation, generated settings, media, comments, scheduled tasks, restart, authorization, CSRF, or cache behavior. Its API separates `transport`, `fixtures`, `actions`, `inspect`, `scheduled`, `restart()`, and `dispose()`. Fixtures write initial state without firing hooks, including bylines and taxonomy terms. Actions call production runtime and handler boundaries. Use `actions.plugin.updateSettings()` with `inspect.settings.raw()` to prove that a generated secret-setting save persists an encrypted envelope. Content inspectors can read byline credits and taxonomy assignments without invoking plugin code. Restart preserves D1, plugin storage, media storage, and plugin state while discarding runtime and isolate memory.

Redirect capability tests can establish host state with `host.fixtures.redirect()` and inspect persisted rules with `host.inspect.redirects()`. Trigger the plugin route through `host.actions.routes.request()` when the test must prove authorization and the real host-to-isolate redirect bridge.

The generated project keeps Worker Loader as its default fast test path. Add an opt-in Node/workerd job only for runner-sensitive behavior. Neither host reproduces deployed CPU, memory, and subrequest limits or renders the admin application.

## References

- [Hooks](./references/hooks.md)
- [Storage, KV, and settings](./references/storage.md)
- [Admin UI and field widgets](./references/admin-ui.md)
- [API routes and MCP tools](./references/api-routes.md)
- [Block Kit](./references/block-kit.md)
- [Portable Text blocks](./references/portable-text-blocks.md)
- [Sandbox boundaries](./references/sandbox-boundaries.md)
- [Publishing](./references/publishing.md)
