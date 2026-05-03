---
name: creating-plugins
description: Create EmDash CMS plugins with hooks, storage, settings, admin UI, API routes, and Portable Text block types. Use this skill when asked to build, scaffold, or implement an EmDash plugin, or when creating plugin features like custom block types, admin pages, or content hooks.
---

# Creating EmDash Plugins

EmDash plugins extend the CMS with hooks, storage, settings, admin UI, API routes, and custom Portable Text block types. All plugins are TypeScript packages.

## Plugin Types

EmDash has two plugin formats:

| Type         | Format                                                  | Admin UI           | Where it runs                               |
| ------------ | ------------------------------------------------------- | ------------------ | ------------------------------------------- |
| **Standard** | `definePlugin({ hooks, routes })`                       | Block Kit          | Isolate on Cloudflare, in-process elsewhere |
| **Native**   | `createPlugin()` / `definePlugin()` with `id`+`version` | React or Block Kit | Always in host isolate                      |

**Standard is the default.** Most plugins should use it. Standard plugins can be published to the marketplace and work in both trusted and sandboxed modes.

**Native is an escape hatch** for plugins that need React admin components, direct DB access, or custom Astro components. Native plugins can only run in `plugins: []` -- they cannot be sandboxed or published to the marketplace.

## Plugin Anatomy

Every plugin has two parts that **run in different contexts**:

1. **Plugin descriptor** (`PluginDescriptor`) — returned by the factory function in `index.ts`. Declares metadata (id, version, capabilities, storage). **Runs at build time in Vite** (imported in `astro.config.mjs`). Must be side-effect-free.
2. **Plugin definition** (`definePlugin()`) — contains the runtime logic (hooks, routes). **Runs at request time on the deployed server.** Has access to the full plugin context (`ctx`). Lives in a separate file (typically `sandbox-entry.ts`).

These must be in **separate entrypoints** because they execute in completely different environments:

```
my-plugin/
├── src/
│   ├── index.ts            # Descriptor factory (runs in Vite at build time)
│   ├── sandbox-entry.ts    # Plugin definition with definePlugin() (runs at deploy time)
│   ├── admin.tsx            # Admin UI exports (React) — optional, native only
│   └── astro/               # Site-side rendering components — optional, native only
│       └── index.ts         # Must export `blockComponents`
├── package.json
└── tsconfig.json
```

## Minimal Plugin (Standard Format)

The simplest possible plugin -- just hooks:

```typescript
// src/index.ts — descriptor factory, runs in Vite at build time
import type { PluginDescriptor } from "emdash";

export function myPlugin(): PluginDescriptor {
	return {
		id: "my-plugin",
		version: "1.0.0",
		format: "standard",
		entrypoint: "@my-org/my-plugin/sandbox",
		options: {},
	};
}
```

```typescript
// src/sandbox-entry.ts — plugin definition, runs at request time
import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

export default definePlugin({
	hooks: {
		"content:afterSave": {
			handler: async (event: any, ctx: PluginContext) => {
				ctx.log.info(`Saved ${event.collection}/${event.content.id}`);
			},
		},
	},
});
```

The descriptor is what gets imported in `astro.config.mjs`. The `entrypoint` field points to the module containing the `definePlugin()` default export. For standard plugins, this is the `./sandbox` export from `package.json`.

Key differences from native format:

- No `id`, `version`, or `capabilities` in `definePlugin()` -- those live in the descriptor
- `definePlugin()` is an identity function providing type inference
- Hook handlers use `(event, ctx)` two-arg pattern
- Route handlers use `(routeCtx, ctx)` two-arg pattern
- Exported as `default` (not a factory function)

## Plugin ID Rules

- Lowercase alphanumeric + hyphens only
- Simple (`my-plugin`) or scoped (`@my-org/my-plugin`)
- Unique across all installed plugins

## Registration

The descriptor is imported in `astro.config.mjs` (Vite context):

```typescript
import { myPlugin } from "@my-org/my-plugin";

export default defineConfig({
	integrations: [
		emdash({
			plugins: [myPlugin()], // runs in-process
			// OR
			sandboxed: [myPlugin()], // runs in isolate on Cloudflare
		}),
	],
});
```

Standard plugins work in either array. Native plugins only work in `plugins: []`.

## Trusted vs Sandboxed Plugins

EmDash has two execution modes. Plugin code is identical in both — only the enforcement changes.

|                     | Trusted                                   | Sandboxed                                              |
| ------------------- | ----------------------------------------- | ------------------------------------------------------ |
| **Runs in**         | Main process                              | Isolated V8 isolate (Dynamic Worker Loader)            |
| **Install method**  | `astro.config.mjs` (code change + deploy) | Admin UI (one-click from marketplace)                  |
| **Capabilities**    | Advisory (not enforced)                   | Enforced at runtime via RPC bridge                     |
| **Resource limits** | None                                      | CPU 50ms, 10 subrequests, 30s wall-time, ~128MB memory |
| **Network access**  | Unrestricted                              | Blocked; only via `ctx.http` with `allowedHosts`       |
| **Data access**     | Full database access                      | Scoped to declared capabilities                        |
| **Node.js APIs**    | Full access                               | Not available (V8 isolate only)                        |
| **Available on**    | All platforms                             | Cloudflare Workers only                                |
| **Best for**        | First-party code, reviewed npm packages   | Third-party extensions, marketplace plugins            |

### Trusted Mode

Trusted plugins are npm packages or local files added in `astro.config.mjs`. They run in-process with your Astro site.

- **Capabilities are documentation only.** Declaring `["content:read"]` documents intent but isn't enforced — the plugin has full process access.
- Only install from sources you trust. A malicious trusted plugin has the same access as your application code.

### Sandboxed Mode

Sandboxed plugins run in isolated V8 isolates on Cloudflare Workers via [Dynamic Worker Loader](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/). Each plugin gets its own isolate.

- **Capabilities are enforced.** If a plugin declares `["content:read"]`, it can only call `ctx.content.get()` and `ctx.content.list()`. Attempting `ctx.content.create()` throws a permission error.
- **Network is blocked by default.** Direct `fetch()` calls fail. Plugins must use `ctx.http.fetch()`, which validates against `allowedHosts`.
- **Storage is scoped.** A plugin can only access its own KV and storage collections.
- **Admin UI uses Block Kit.** Sandboxed plugins describe their UI as JSON blocks -- no plugin JavaScript runs in the browser. See [Block Kit reference](./references/block-kit.md).
- **No Portable Text block types.** PT blocks require Astro components for site-side rendering (`componentsEntry`), which are loaded at build time from npm. Sandboxed plugins are installed at runtime and can't ship components. PT blocks are a native-plugin-only feature.
- **Routes work.** Standard plugin routes are available in both trusted and sandboxed modes via the sandbox runner's `invokeRoute()` RPC.

Sandboxing is not available on Node.js. All plugins run in trusted mode on non-Cloudflare platforms.

### Developing for Both Modes

Write the same code. Develop locally in trusted mode (faster iteration, easier debugging). Deploy to sandboxed mode in production without code changes. With the standard format, the same entrypoint serves both modes -- no separate sandbox entry needed.

```typescript
// src/sandbox-entry.ts -- works in both trusted and sandboxed modes
import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

export default definePlugin({
	hooks: {
		"content:afterSave": {
			handler: async (event: any, ctx: PluginContext) => {
				// Trusted: ctx.http present because descriptor declares network:request
				// Sandboxed: ctx.http present and enforced via RPC bridge
				if (!ctx.http) return;
				await ctx.http.fetch("https://api.analytics.example.com/track", {
					method: "POST",
					body: JSON.stringify({ contentId: event.content.id }),
				});
			},
		},
	},
});
```

Key constraint for sandbox compatibility: **no Node.js built-ins** (`fs`, `path`, `child_process`, etc.) in backend code. Use Web APIs instead.

## Capabilities

Capabilities control what APIs are available on `ctx`. Always declare what your plugin needs — even in trusted mode, they document intent and are required for sandboxed execution.

| Capability                       | Grants                                                                 | `ctx` property |
| -------------------------------- | ---------------------------------------------------------------------- | -------------- |
| `content:read`                   | `ctx.content.get()`, `ctx.content.list()`                              | `content`      |
| `content:write`                  | `ctx.content.create()`, `ctx.content.update()`, `ctx.content.delete()` | `content`      |
| `media:read`                     | `ctx.media.get()`, `ctx.media.list()`                                  | `media`        |
| `media:write`                    | `ctx.media.getUploadUrl()`, `ctx.media.delete()`                       | `media`        |
| `network:request`                | `ctx.http.fetch()` (restricted to `allowedHosts`)                      | `http`         |
| `network:request:unrestricted`   | `ctx.http.fetch()` (unrestricted — for user-configured URLs)           | `http`         |
| `users:read`                     | `ctx.users.get()`, `ctx.users.list()`, `ctx.users.getByEmail()`        | `users`        |
| `email:send`                     | `ctx.email.send()` — send email through the pipeline                   | `email`        |
| `hooks.email-transport:register` | Can register `email:deliver` exclusive hook (transport provider)       | —              |
| `hooks.email-events:register`    | Can register `email:beforeSend` / `email:afterSend` hooks              | —              |
| `hooks.page-fragments:register`  | Can register `page:fragments` hook (inject scripts/styles into pages)  | —              |

Storage (`ctx.storage`) and KV (`ctx.kv`) are **always available** — no capability needed. They're automatically scoped to the plugin.

**Email capabilities are distinct:**

- `email:send` — for plugins that _consume_ email (call `ctx.email.send()`)
- `hooks.email-transport:register` — for plugins that _deliver_ email (implement the transport, e.g. Resend, SMTP)
- `hooks.email-events:register` — for plugins that _observe or transform_ email (middleware hooks)

```typescript
// In the descriptor (index.ts)
export function myPlugin(): PluginDescriptor {
	return {
		id: "my-plugin",
		version: "1.0.0",
		format: "standard",
		entrypoint: "@my-org/my-plugin/sandbox",
		options: {},
		capabilities: ["content:read", "network:request"],
		allowedHosts: ["api.example.com", "*.googleapis.com"], // Wildcards supported
	};
}
```

When a marketplace plugin is installed, the admin sees a capability consent dialog listing what the plugin can access. Users must approve before installation.

## Publishing to the Marketplace

Standard plugins can be published to the EmDash Marketplace for one-click installation:

```bash
emdash plugin bundle --dir packages/plugins/my-plugin  # creates .tar.gz
emdash plugin login                                      # authenticate via GitHub
emdash plugin publish --tarball dist/my-plugin-1.0.0.tar.gz
```

See [Publishing Reference](./references/publishing.md) for bundle format, validation, and security audit details.

## Package Exports

Configure `package.json` exports so EmDash can load each entry point:

```json
{
	"name": "@my-org/my-plugin",
	"type": "module",
	"exports": {
		".": "./src/index.ts",
		"./sandbox": "./src/sandbox-entry.ts",
		"./admin": "./src/admin.tsx"
	},
	"peerDependencies": {
		"emdash": "^0.1.0"
	}
}
```

| Export        | Context           | Purpose                                                                |
| ------------- | ----------------- | ---------------------------------------------------------------------- |
| `"."`         | Vite (build time) | Descriptor factory -- imported in `astro.config.mjs`                   |
| `"./sandbox"` | Server (runtime)  | `definePlugin({ hooks, routes })` -- loaded by `entrypoint` at runtime |
| `"./admin"`   | Browser           | React components for admin pages/widgets (native plugins only)         |
| `"./astro"`   | Server (SSR)      | Astro components for site-side block rendering (native plugins only)   |

The `"."` export has the descriptor. The `"./sandbox"` export has the implementation. The descriptor's `entrypoint` field points to `"./sandbox"`. Only include `./admin` and `./astro` exports for native-format plugins.

## Plugin Features

Each feature is optional. Add only what your plugin needs:

| Feature             | Where                        | Standard | Native | Purpose                                               |
| ------------------- | ---------------------------- | -------- | ------ | ----------------------------------------------------- |
| **Hooks**           | `definePlugin({ hooks })`    | Yes      | Yes    | React to content/media/lifecycle events               |
| **Storage**         | descriptor `storage`         | Yes      | Yes    | Document collections with indexed queries             |
| **KV**              | `ctx.kv` in hooks/routes     | Yes      | Yes    | Key-value store for internal state                    |
| **API Routes**      | `definePlugin({ routes })`   | Yes      | Yes    | REST endpoints at `/_emdash/api/plugins/<id>/<route>` |
| **Admin Pages**     | Block Kit `admin` route      | Yes      | Yes    | Admin pages via Block Kit (JSON blocks)               |
| **Widgets**         | Block Kit `admin` route      | Yes      | Yes    | Dashboard cards via Block Kit                         |
| **React Admin**     | `admin.entry` + React export | No       | Yes    | React-based admin pages and widgets (native only)     |
| **PT Blocks**       | `admin.portableTextBlocks`   | No       | Yes    | Custom block types in the Portable Text editor        |
| **Site Components** | `componentsEntry`            | No       | Yes    | Astro components for rendering blocks on the site     |

See the reference files for detailed syntax:

- **[Hooks Reference](./references/hooks.md)** — All hook types, signatures, configuration
- **[Storage & Settings](./references/storage.md)** — Collections, KV, settings schema
- **[Admin UI](./references/admin-ui.md)** — Pages, widgets, entry point structure
- **[API Routes](./references/api-routes.md)** — Route handlers, validation, context
- **[Block Kit](./references/block-kit.md)** — Declarative UI for sandboxed plugins (similar to Slack Block Kit but not identical)
- **[Portable Text Blocks](./references/portable-text-blocks.md)** — Custom block types + frontend rendering
- **[Publishing](./references/publishing.md)** — Bundle format, validation, marketplace publishing

## Complete Example: Standard Plugin with Hooks, Routes, and Storage

```typescript
// src/index.ts — descriptor factory, runs in Vite at build time
import type { PluginDescriptor } from "emdash";

export function submissionsPlugin(): PluginDescriptor {
	return {
		id: "submissions",
		version: "1.0.0",
		format: "standard",
		entrypoint: "@my-org/plugin-submissions/sandbox",
		options: {},
		capabilities: ["content:read"],
		storage: {
			submissions: {
				indexes: ["formId", "status", "createdAt"],
			},
		},
		adminPages: [{ path: "/submissions", label: "Submissions", icon: "list" }],
		adminWidgets: [{ id: "recent-submissions", title: "Recent Submissions", size: "half" }],
	};
}
```

```typescript
// src/sandbox-entry.ts — plugin definition, runs at request time
import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

export default definePlugin({
	hooks: {
		"plugin:install": {
			handler: async (_event: any, ctx: PluginContext) => {
				ctx.log.info("Submissions plugin installed");
				await ctx.kv.set("settings:maxSubmissions", 1000);
			},
		},
	},

	routes: {
		submit: {
			public: true, // No auth required
			handler: async (routeCtx: any, ctx: PluginContext) => {
				const { formId, ...data } = routeCtx.input as Record<string, unknown>;

				const count = await ctx.storage.submissions.count({ formId });
				const max = (await ctx.kv.get<number>("settings:maxSubmissions")) ?? 1000;

				if (count >= max) {
					return { success: false, error: "Submission limit reached" };
				}

				const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
				await ctx.storage.submissions.put(id, {
					formId,
					data,
					status: "pending",
					createdAt: new Date().toISOString(),
				});

				return { success: true, id };
			},
		},

		list: {
			handler: async (routeCtx: any, ctx: PluginContext) => {
				const url = new URL(routeCtx.request.url);
				const limit = Math.max(
					1,
					Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 100),
				);
				const cursor = url.searchParams.get("cursor") || undefined;

				const result = await ctx.storage.submissions.query({
					orderBy: { createdAt: "desc" },
					limit,
					cursor,
				});

				return {
					items: result.items.map((item: any) => ({ id: item.id, ...item.data })),
					cursor: result.cursor,
					hasMore: result.hasMore,
				};
			},
		},

		// Block Kit admin handler for pages and widgets
		admin: {
			handler: async (routeCtx: any, ctx: PluginContext) => {
				const interaction = routeCtx.input as { type: string; page?: string };

				if (interaction.type === "page_load" && interaction.page === "/submissions") {
					const result = await ctx.storage.submissions.query({
						orderBy: { createdAt: "desc" },
						limit: 50,
					});
					return {
						blocks: [
							{ type: "header", text: "Submissions" },
							{
								type: "table",
								blockId: "submissions-table",
								columns: [
									{ key: "formId", label: "Form", format: "text" },
									{ key: "status", label: "Status", format: "badge" },
									{ key: "createdAt", label: "Date", format: "relative_time" },
								],
								rows: result.items.map((item: any) => item.data),
							},
						],
					};
				}

				return { blocks: [] };
			},
		},
	},
});
```

## Plugin Context

All hooks and routes receive `ctx` (PluginContext):

```typescript
interface PluginContext {
	plugin: { id: string; version: string };
	storage: Record<string, StorageCollection>; // Declared collections
	kv: KVAccess; // Key-value store
	log: LogAccess; // Structured logger
	content?: ContentAccess; // If "content:read" capability
	media?: MediaAccess; // If "media:read" capability
	http?: HttpAccess; // If "network:request" capability
	users?: UserAccess; // If "users:read" capability
	cron?: CronAccess; // Always available — scoped to plugin
	email?: EmailAccess; // If "email:send" capability AND a provider is configured
}
```

Capabilities are declared in the **descriptor** (not in `definePlugin()` for standard format):

```typescript
// In the descriptor
export function myPlugin(): PluginDescriptor {
	return {
		id: "my-plugin",
		version: "1.0.0",
		format: "standard",
		entrypoint: "@my-org/my-plugin/sandbox",
		options: {},
		capabilities: ["content:read", "network:request"],
		allowedHosts: ["api.example.com"],
		storage: { events: { indexes: ["timestamp"] } },
	};
}
```

## Output Checklist

When creating a standard-format plugin, provide:

1. **`src/index.ts`** -- Descriptor factory (runs in Vite at build time)
2. **`src/sandbox-entry.ts`** -- `definePlugin({ hooks, routes })` as default export (runs at request time)
3. **`package.json`** -- With exports `"."` (descriptor) and `"./sandbox"` (implementation)
4. **`tsconfig.json`** -- Standard TypeScript config

For native-format plugins (React admin, PT blocks, Astro components), also provide:

5. **`src/admin.tsx`** -- Admin entry point with React components
6. **`src/astro/index.ts`** -- Block components export (if PT blocks)
