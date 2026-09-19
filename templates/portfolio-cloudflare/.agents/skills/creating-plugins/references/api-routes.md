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

Routes without declarations keep the original input contract: the host parses JSON for `POST`, `PUT`, and `PATCH`, and query strings for `GET`, `HEAD`, and `DELETE`. Repeated query keys become arrays.

Declare `request.body` as `none`, `json`, `text`, `bytes`, or `form-data` for bounded parsing. The default body limit is 1 MiB and `maxBytes` cannot exceed 8 MiB. Use the `pluginRoute()` value helper from `emdash/plugin` to infer query, string, byte, or form-data input; JSON remains `unknown` and requires validation.

Multipart parsing permits at most 100 parts, 1 MiB per part, and 255 UTF-8 bytes per safe filename. The complete request must also fit the route limit.

Declare safe request-header names explicitly. Credentials, cookies, Cloudflare Access, proxy authorization, `Set-Cookie`, and EmDash CSRF headers cannot be declared and never cross the sandbox boundary.

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

A public route skips authentication, permission, and token-scope checks. It is internet-facing, so validate input and verify webhook signatures or shared tokens where applicable. Public exposure is reviewed at installation, and newly public routes require renewed update approval.

## HTTP methods

Declare `methods` to have the host reject other methods with `405 Method Not Allowed` and an `Allow` header before plugin invocation:

```typescript
methods: ["POST"],
handler: async (routeCtx, ctx) => {
	// Validate input, then mutate.
},
```

Routes without `methods` remain method-agnostic for compatibility.

## Results and errors

Return a JSON-serializable value. The HTTP endpoint wraps it in EmDash's `{ success: true, data }` envelope.

Return a stable application-level error object for expected validation and domain failures. Throw only for unexpected failures, and keep exception messages free of credentials, personal data, paths, and stack traces.

For an unwrapped response, declare `response: "raw"` and return `pluginResponse()` from `emdash/plugin` with a text or `Uint8Array` body. Do not return or throw a WHATWG `Response`.

Raw bodies are buffered to 8 MiB. The host retains only documented representation, download, and redirect headers, applies route caching and browser security policy, and rejects active same-origin types including HTML, JavaScript, XHTML, SVG, XML, CSS, WebAssembly, and active multipart formats. Raw routes cannot back MCP tools.

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

## Host APIs used by routes

Routes receive the same capability-gated context as hooks. Read [Content, schema, translations, and publication](./content.md), [Taxonomies and redirects](./taxonomies-and-redirects.md), [Comments](./comments.md), and [Media](./media.md) for those contracts.

## External HTTP responses

`ctx.http.fetch()` returns a buffered WHATWG `Response` in both sandbox runners. Binary bytes, status text, headers, final URL, redirect state, `arrayBuffer()`, `blob()`, and `clone()` are portable. Decoded request and response bodies are each limited to 8 MiB and are buffered rather than streamed.

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
- reference a JSON route, not one with `response: "raw"`;
- declare an input Zod schema;
- set `destructive: true` for deletion, overwrite, publishing, charging, or another difficult-to-reverse action.

The optional output schema becomes structured MCP output. The bundle converts both schemas to JSON Schema.

Installation and updates show the exact MCP tools for consent. Adding a tool or changing a route from private to public requires fresh approval. After installation, an administrator separately enables plugin MCP tools. A caller then needs the route permission and either the `mcp:tools` scope or `mcp:tools:<pluginId>`.

The production core parser, shared plugin-types parser, plugin CLI artifact, and generated descriptor preserve MCP declarations and route permission/cache metadata. `@emdash-cms/plugin-test` exposes the parsed manifest so tests can assert that transport. Its `invokeRoute()` still bypasses the HTTP catch-all, so use the host for plugin execution and bridge behavior, not route authorization, response caching, MCP registration, or consent behavior.
