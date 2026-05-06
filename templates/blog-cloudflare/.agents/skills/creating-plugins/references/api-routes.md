# API Routes

Plugin routes work in both standard and native plugins, and in both trusted and sandboxed modes. Sandboxed plugin routes are invoked via the sandbox runner's `invokeRoute()` RPC.

Plugin routes expose REST endpoints at `/_emdash/api/plugins/<plugin-id>/<route-name>`.

## Defining Routes

```typescript
import { definePlugin } from "emdash";
import { z } from "astro/zod";

definePlugin({
	id: "forms",
	version: "1.0.0",

	routes: {
		// Simple route
		status: {
			handler: async (ctx) => {
				return { ok: true };
			},
		},

		// Route with input validation
		submissions: {
			input: z.object({
				formId: z.string().optional(),
				limit: z.number().default(50),
				cursor: z.string().optional(),
			}),
			handler: async (ctx) => {
				const { formId, limit, cursor } = ctx.input;
				const result = await ctx.storage.submissions!.query({
					where: formId ? { formId } : undefined,
					orderBy: { createdAt: "desc" },
					limit,
					cursor,
				});
				return {
					items: result.items,
					cursor: result.cursor,
					hasMore: result.hasMore,
				};
			},
		},

		// Nested path
		"settings/save": {
			input: z.object({
				enabled: z.boolean().optional(),
				apiKey: z.string().optional(),
			}),
			handler: async (ctx) => {
				for (const [key, value] of Object.entries(ctx.input)) {
					if (value !== undefined) {
						await ctx.kv.set(`settings:${key}`, value);
					}
				}
				return { success: true };
			},
		},
	},
});
```

## Route URLs

| Plugin ID | Route Name      | URL                                      |
| --------- | --------------- | ---------------------------------------- |
| `forms`   | `status`        | `/_emdash/api/plugins/forms/status`      |
| `forms`   | `submissions`   | `/_emdash/api/plugins/forms/submissions` |
| `seo`     | `settings/save` | `/_emdash/api/plugins/seo/settings/save` |

## Handler Context

```typescript
interface RouteContext<TInput = unknown> extends PluginContext {
	input: TInput; // Validated input
	request: Request; // Original request
	plugin: { id: string; version: string };
	storage: Record<string, StorageCollection>;
	kv: KVAccess;
	content?: ContentAccess; // If capability declared
	media?: MediaAccess;
	http?: HttpAccess;
	log: LogAccess;
}
```

## Input Validation

Use Zod schemas. Invalid input returns 400.

```typescript
routes: {
	create: {
		input: z.object({
			title: z.string().min(1).max(200),
			email: z.string().email(),
			priority: z.enum(["low", "medium", "high"]).default("medium"),
			tags: z.array(z.string()).optional(),
		}),
		handler: async (ctx) => {
			// ctx.input is typed and validated
			const { title, email, priority } = ctx.input;
			// ...
		},
	},
}
```

Input sources:

- **POST/PUT/PATCH** — Request body (JSON)
- **GET/DELETE** — URL query parameters

## Return Values

Return any JSON-serializable value. Response is always `Content-Type: application/json`.

```typescript
return { success: true, data: items }; // Object
return items; // Array
return 42; // Primitive
```

## Errors

Throw to return error response:

```typescript
throw new Error("Item not found"); // 500 with { error: "Item not found" }

// Custom status code
throw new Response(JSON.stringify({ error: "Not found" }), {
	status: 404,
	headers: { "Content-Type": "application/json" },
});
```

## HTTP Methods

Routes respond to all methods. Check `ctx.request.method`:

```typescript
handler: async (ctx) => {
	switch (ctx.request.method) {
		case "GET":
			return await ctx.storage.items!.get(ctx.input.id);
		case "DELETE":
			await ctx.storage.items!.delete(ctx.input.id);
			return { deleted: true };
		default:
			throw new Response("Method not allowed", { status: 405 });
	}
};
```

## Common Patterns

### Settings CRUD

```typescript
routes: {
	settings: {
		handler: async (ctx) => {
			const settings = await ctx.kv.list("settings:");
			const result: Record<string, unknown> = {};
			for (const entry of settings) {
				result[entry.key.replace("settings:", "")] = entry.value;
			}
			return result;
		},
	},
	"settings/save": {
		handler: async (ctx) => {
			const input = await ctx.request.json();
			for (const [key, value] of Object.entries(input)) {
				if (value !== undefined) await ctx.kv.set(`settings:${key}`, value);
			}
			return { success: true };
		},
	},
}
```

### Paginated List

```typescript
routes: {
	list: {
		input: z.object({
			limit: z.number().min(1).max(100).default(50),
			cursor: z.string().optional(),
			status: z.string().optional(),
		}),
		handler: async (ctx) => {
			const { limit, cursor, status } = ctx.input;
			const result = await ctx.storage.items!.query({
				where: status ? { status } : undefined,
				orderBy: { createdAt: "desc" },
				limit,
				cursor,
			});
			return {
				items: result.items.map((item) => ({ id: item.id, ...item.data })),
				cursor: result.cursor,
				hasMore: result.hasMore,
			};
		},
	},
}
```

### External API Proxy

Requires `network:request` capability and `allowedHosts`:

```typescript
definePlugin({
	capabilities: ["network:request"],
	allowedHosts: ["api.weather.example.com"],

	routes: {
		forecast: {
			input: z.object({ city: z.string() }),
			handler: async (ctx) => {
				const apiKey = await ctx.kv.get<string>("settings:apiKey");
				if (!apiKey) throw new Error("API key not configured");

				const response = await ctx.http!.fetch(
					`https://api.weather.example.com/forecast?city=${ctx.input.city}`,
					{ headers: { "X-API-Key": apiKey } },
				);

				if (!response.ok) throw new Error(`API error: ${response.status}`);
				return response.json();
			},
		},
	},
});
```

## Calling from Admin UI

```typescript
import { usePluginAPI } from "@emdash-cms/admin";

const api = usePluginAPI();
const data = await api.get("status");
await api.post("settings/save", { enabled: true });
```

## Calling Externally

```bash
curl https://your-site.com/_emdash/api/plugins/forms/submissions?limit=10

curl -X POST https://your-site.com/_emdash/api/plugins/forms/create \
  -H "Content-Type: application/json" \
  -d '{"title": "Hello"}'
```

Plugin routes don't have built-in auth. Admin-only routes are protected by the admin session middleware.
