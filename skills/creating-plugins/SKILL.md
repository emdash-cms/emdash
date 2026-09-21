---
name: creating-plugins
description: Create EmDash CMS plugins with sandboxed hooks, routes, storage, content and media APIs, MCP tools, and declarative admin UI, or native React and Astro extensions. Use when scaffolding or implementing an EmDash plugin.
---

# Creating EmDash plugins

Build against the API that reaches the intended execution mode. Source types and production-boundary tests take precedence over examples in this skill when they disagree.

## Choose a format

| Format    | Runtime source                                      | Admin UI                                                  | Distribution                 |
| --------- | --------------------------------------------------- | --------------------------------------------------------- | ---------------------------- |
| Sandboxed | `src/plugin.ts` default-exports a `SandboxedPlugin` | Block Kit pages, widgets, saved-entry panels, and actions | Plugin CLI and registry      |
| Native    | `definePlugin()` / `createPlugin()`                 | React, Block Kit, and Astro components                    | Trusted site dependency only |

Use a sandboxed plugin unless the feature needs host-process access, React admin code, Astro rendering components, raw page fragments, or custom Portable Text block definitions. Native plugins run with the site's authority and cannot be installed from the registry.

## Scaffold a sandboxed plugin

```sh
pnpm dlx @emdash-cms/plugin-cli init my-plugin
cd my-plugin
pnpm install
pnpm run test
```

The manifest is the identity and trust contract. Runtime hooks and routes live in `src/plugin.ts`; the CLI generates descriptors, manifests, and bundles. Do not create a separate descriptor factory or `sandbox-entry.ts`.

```typescript title="src/plugin.ts"
import type { SandboxedPlugin } from "emdash/plugin";

const plugin: SandboxedPlugin = {
	hooks: {
		"content:afterSave": async (event, ctx) => {
			ctx.log.info("Content saved", { id: event.content.id });
		},
	},
};

export default plugin;
```

Import authoring types from `emdash/plugin` with `import type`. Value imports are limited to lightweight helpers such as `pluginRoute()` and `pluginResponse()`, which the CLI bundles. Sandboxed runtime code can use Web APIs but not Node.js built-ins.

## Declare access

Declare every host API in `emdash-plugin.jsonc`. Adding authority, exposing a route publicly, or adding MCP tools requires renewed administrator approval.

| Capability                       | Grants                                                                     |
| -------------------------------- | -------------------------------------------------------------------------- |
| `schema:read`                    | Public collection and field definitions                                    |
| `content:read`                   | Content identity, translations, and published public URLs                  |
| `content:revisions:read`         | Retained revision data; implies content read                               |
| `content:write`                  | Create, update, delete, and translation creation; implies read             |
| `content:publish`                | Revision-fenced publish, unpublish, schedule, and unschedule; implies read |
| `content:restore`                | Revision-fenced reads and restoration of trashed content                   |
| `hooks.content-policy:register`  | Pre-publish, pre-schedule, and pre-unpublish policy hooks                  |
| `taxonomies:read`                | Taxonomy definitions, terms, and entry assignments                         |
| `taxonomies:write`               | Term creation and assignment deltas; implies read                          |
| `redirects:read`                 | Versioned redirect inspection                                              |
| `redirects:write`                | Versioned redirect creation, update, and deletion; implies read            |
| `comments:read`                  | Stored non-trashed comments and their personal data                        |
| `comments:moderate`              | Expected-status moderation; implies read                                   |
| `media:read`                     | Ready-media metadata and authenticated asset URLs                          |
| `media:bytes:read`               | Bounded media bytes and content hashes                                     |
| `media:metadata:write`           | Alt text, caption, and focal-point updates                                 |
| `media:write`                    | Upload and delete; implies media read                                      |
| `network:request`                | `ctx.http.fetch()` restricted to `allowedHosts`                            |
| `network:request:unrestricted`   | `ctx.http.fetch()` without a host list                                     |
| `users:read`                     | User directory lookup; also required by comment hooks                      |
| `email:send`                     | Email delivery when a transport is configured                              |
| `hooks.email-transport:register` | Exclusive `email:deliver` hook                                             |
| `hooks.email-events:register`    | Email before/after hooks                                                   |
| `hooks.page-fragments:register`  | Trusted-only page fragments; excluded from sandbox registration            |

Settings, KV, declared storage, logging, and cron scheduling are plugin-scoped and need no capability. Use `ctx.settings` for user configuration, `ctx.kv` for internal key-value state, and declared `ctx.storage.<collection>` for queryable records.

Read the focused reference for the API being used:

- [Content, schema, translations, and publication](./references/content.md)
- [Taxonomies and redirects](./references/taxonomies-and-redirects.md)
- [Comments](./references/comments.md)
- [Media](./references/media.md)
- [Storage, KV, and encrypted settings](./references/storage.md)

## Routes, HTTP, and MCP

Routes are private by default and require authentication, their declared RBAC permission, token scope or CSRF as appropriate. Public routes are internet-facing and require explicit install consent.

Undeclared routes keep the legacy JSON/query envelope. Declare methods and body modes for host-enforced parsing. Use `pluginResponse()` only on a route that declares a raw response. Outbound `ctx.http.fetch()` responses and declared route bodies are buffered and bounded.

MCP tools reference private JSON routes with explicit permissions and Zod input schemas. Mark difficult-to-reverse operations `destructive: true`. Read [API routes and MCP tools](./references/api-routes.md).

## Hooks

Sandboxed hooks enter the same priority, dependency, timeout, error-policy, enablement, exclusive-provider, and capability pipeline as trusted hooks. Publication policy hooks identify action origin and actor without granting publication authority. Comment moderation invoked through `ctx.comments` reports plugin origin and runs the normal after-hook once. Read [Hooks](./references/hooks.md).

## Declarative admin UI

Sandboxed pages and widgets return validated Block Kit. Structured links use host-resolved targets; `routeCtx.ui` carries host-attested locale, direction, and surface. External images require matching network authority.

Saved-entry panels and actions point to private routes. They receive host-reloaded saved identity and version, never field values or unsaved editor state. Read saved content through capability-gated `ctx.content`.

Declarative field widgets currently compose supported Block Kit elements into a JSON value. Custom Portable Text blocks and Astro render components remain native-only. Read [Admin UI](./references/admin-ui.md), [Block Kit](./references/block-kit.md), and [Portable Text blocks](./references/portable-text-blocks.md).

## Runner parity

Cloudflare Worker Loader and Node/workerd execute the same bundle behind a plugin-scoped bridge. Both return buffered WHATWG responses from `ctx.http.fetch()` with binary bytes preserved and decoded request/response bodies limited to 8 MiB. Write against exported types, not extra methods found in one wrapper.

Read [Sandbox boundaries](./references/sandbox-boundaries.md) before designing around an API not listed here.

## Test the production boundary

Use `createPluginTestHost()` for fast hook, route, manifest, capability, KV, settings, and storage transport tests. Use `createPluginRuntimeTestHost()` when the test must exercise real content actions, plugin activation, media, comments, redirects, scheduling, restart, authorization, CSRF, caching, Block Kit validation, or saved-entry extensions.

Runtime fixtures establish state without firing hooks. Runtime actions call production boundaries; inspectors read observable state. Queue outbound HTTP responses with `host.http.respond()` and inspect requests with `host.http.requests()`. Dispose every host after use. Add Node/workerd parity only for runner-sensitive behavior.

## References

- [Content, schema, translations, and publication](./references/content.md)
- [Taxonomies and redirects](./references/taxonomies-and-redirects.md)
- [Comments](./references/comments.md)
- [Media](./references/media.md)
- [Hooks](./references/hooks.md)
- [Storage, KV, and encrypted settings](./references/storage.md)
- [Admin UI and field widgets](./references/admin-ui.md)
- [API routes and MCP tools](./references/api-routes.md)
- [Block Kit](./references/block-kit.md)
- [Portable Text blocks](./references/portable-text-blocks.md)
- [Sandbox boundaries](./references/sandbox-boundaries.md)
- [Publishing](./references/publishing.md)
