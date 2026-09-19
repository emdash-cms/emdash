# API routes and MCP tools

Sandboxed plugin routes are mounted at `/_emdash/api/plugins/<slug>/<route-name>`. Define them in the typed default export from `src/plugin.ts`.

## Define a route

```typescript title="src/plugin.ts"
import type { SandboxedPlugin } from "emdash/plugin";
import { z } from "zod";

const submissionInput = z.object({
	formId: z.string().min(1),
	limit: z.coerce.number().int().min(1).max(100).default(50),
});

const plugin: SandboxedPlugin = {
	routes: {
		submissions: {
			permission: "content:read",
			handler: async (routeCtx, ctx) => {
				const parsed = submissionInput.safeParse(routeCtx.input);
				if (!parsed.success) return { ok: false, error: "INVALID_INPUT" };

				const result = await ctx.storage.submissions.query({
					where: { formId: parsed.data.formId },
					limit: parsed.data.limit,
				});
				return { ok: true, ...result };
			},
		},
	},
};

export default plugin;
```

The handler receives two arguments:

```typescript
interface SandboxedRouteContext {
	input: unknown;
	request: {
		url: string;
		method: string;
		headers: Record<string, string>;
	};
	requestMeta?: {
		ip: string | null;
		userAgent: string | null;
		referer: string | null;
		geo: { country: string | null; region: string | null; city: string | null } | null;
	};
	user?: UserInfo;
}
```

`routeCtx.request` is a serialized record in both sandbox runners, not a WHATWG `Request`. Header keys are lowercased. Read parsed request data from `routeCtx.input`; the body has already been consumed by the host.

The published authoring type currently declares `requestMeta` as `unknown`, although both runners send the normalized shape shown above. Narrow it before reading fields when TypeScript cannot infer the shape.

## Input sources and validation

The host parses JSON for `POST`, `PUT`, and `PATCH`. It parses the query string for `GET`, `HEAD`, and `DELETE`; repeated keys become arrays. Validate `routeCtx.input` inside the handler.

The plugin CLI probe currently does not retain a route entry's `input` schema, so do not rely on route-level Zod validation for a built sandboxed plugin. An MCP tool still requires its own Zod input schema.

## Authentication, permission, and CSRF

Routes are private unless they set `public: true`.

A private route requires:

- an authenticated session, or a token with the `admin` scope;
- the route's declared EmDash RBAC `permission`, defaulting to `plugins:manage`;
- `X-EmDash-Request: 1` for cookie-authenticated calls, for every HTTP method.

The host resolves these checks before invoking the plugin. `routeCtx.user` then contains the authenticated caller for a user-bound request:

```typescript
interface UserInfo {
	id: string;
	email: string;
	name: string | null;
	role: number;
	createdAt: string;
}
```

Caller identity is not gated by `users:read`; it identifies the current authorized caller. `ctx.users` is a directory lookup and does require `users:read`. `routeCtx.user` is absent on public routes and on machine-token calls without a bound user.

A public route skips authentication, permission, and token-scope checks. It is internet-facing, so validate input, check the intended HTTP method, and verify webhook signatures or shared tokens where applicable.

## HTTP methods

The route name selects one handler for every method. Reject unintended methods before side effects:

```typescript
handler: async (routeCtx, ctx) => {
	if (routeCtx.request.method !== "POST") {
		return { ok: false, error: "POST_REQUIRED" };
	}
	// Validate input, then mutate.
},
```

## Results and errors

Return a JSON-serializable value. The HTTP endpoint wraps it in EmDash's `{ success: true, data }` envelope.

Return a stable application-level error object for expected validation and domain failures. Throw only for unexpected failures, and keep exception messages free of credentials, personal data, paths, and stack traces.

Plugin routes do not expose raw or unwrapped HTTP responses. Do not return or throw a `Response` to select status or headers; the host wraps JSON-serializable results in its API envelope. Authentication, authorization, CSRF, and missing-route statuses are assigned before or around dispatch.

## Public caching

Core accepts `cacheControl` on a public route:

```typescript
routes: {
	catalog: {
		public: true,
		cacheControl: "public, max-age=60, stale-while-revalidate=300",
		handler: async () => ({ items: [] }),
	},
},
```

The value is applied only to successful public `GET` and `HEAD` responses. Private responses, errors, and other methods remain `private, no-store`. The plugin CLI carries `cacheControl` through the probe, bundle manifest, registry artifact, and generated descriptor.

## Request metadata

Both runners send the same normalized metadata:

- `ip`: a trusted client address when the platform or operator configured a trusted proxy header, otherwise `null`;
- `userAgent`: the `User-Agent` value, otherwise `null`;
- `referer`: the `Referer` value, otherwise `null`;
- `geo`: Cloudflare country, region, and city when available, otherwise `null`.

Do not treat `userAgent`, `referer`, or geographic values as authenticated identity. Use `routeCtx.user` for the caller.

## Content reads

With `content:read`, both sandbox runners match the trusted read contract. `ctx.content.get()` and `ctx.content.list()` return content identity, slug, status, locale, data, created/updated/published/scheduled timestamps, and SEO metadata when enabled.

`list()` accepts `limit`, `cursor`, `where`, and `orderBy`. Field filters, status filters, ordering, and cursor pagination reach the host repository on both runners; they are not evaluated inside the plugin isolate. Read only the fields the returned `ContentItem` exposes. Translation discovery and schema listing are separate missing APIs, described in [Sandbox boundaries](./sandbox-boundaries.md).

With `content:publish`, call `getVersioned()` before `publish()`, `unpublish()`, `schedule()`, or `unschedule()`, then pass the returned `_rev`. Each successful mutation returns the item and its next `_rev`. `content:restore` separately provides `getTrashedVersioned()` and `restore()` without granting ordinary content reads. These actions execute through the host runtime, including policy and after-hooks; a stale revision or same-plugin recursive action rejects without changing the entry.

## External HTTP responses

`ctx.http.fetch()` returns a real WHATWG `Response` in both sandbox runners, so `ok`, `status`, `headers`, `text()`, and `json()` use the standard Web API.

The Cloudflare bridge currently transports the upstream response body as decoded text before constructing the `Response`. Binary response methods such as `arrayBuffer()` and `blob()` therefore do not preserve arbitrary bytes on Cloudflare. The Node/workerd bridge base64-encodes response bytes. Use text or JSON responses for portable plugins until the Cloudflare bridge is binary-safe.

## Expose a route as an MCP tool

MCP exposure is explicit. The following tool calls the private route as `<pluginId>__createEvent`:

```typescript title="src/plugin.ts"
import type { SandboxedPlugin } from "emdash/plugin";
import { z } from "zod";

const createEventInput = z.object({
	title: z.string().min(1),
	startsAt: z.string().datetime(),
});

const plugin: SandboxedPlugin = {
	routes: {
		"events/create": {
			permission: "content:create",
			handler: async (routeCtx) => {
				const parsed = createEventInput.safeParse(routeCtx.input);
				if (!parsed.success) return { ok: false, error: "INVALID_EVENT" };
				return { ok: true, id: crypto.randomUUID() };
			},
		},
	},
	mcp: {
		tools: {
			createEvent: {
				description: "Create a calendar event requested by the user.",
				route: "events/create",
				input: createEventInput,
				output: z.object({ ok: z.boolean(), id: z.string().optional() }),
				destructive: false,
			},
		},
	},
};

export default plugin;
```

An MCP tool must:

- use a tool name containing only letters, digits, `_`, or `-`;
- reference an existing private route;
- reference a route with an explicit valid `permission`;
- declare an input Zod schema;
- set `destructive: true` for deletion, overwrite, publishing, charging, or another difficult-to-reverse action.

The optional output schema becomes structured MCP output. The bundle converts both schemas to JSON Schema.

Installation and updates show the exact MCP tools for consent. Adding a tool or changing a route from private to public requires fresh approval. After installation, an administrator separately enables plugin MCP tools. A caller then needs the route permission and either the `mcp:tools` scope or `mcp:tools:<pluginId>`.

The production core parser, shared plugin-types parser, plugin CLI artifact, and generated descriptor preserve MCP declarations and route permission/cache metadata. `@emdash-cms/plugin-test` exposes the parsed manifest so tests can assert that transport. Its `invokeRoute()` still bypasses the HTTP catch-all, so use the host for plugin execution and bridge behavior, not route authorization, response caching, MCP registration, or consent behavior.
