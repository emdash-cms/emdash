# Storage, KV & Settings

Plugins have three data mechanisms:

| Mechanism           | Purpose                                   | Access                 |
| ------------------- | ----------------------------------------- | ---------------------- |
| **Storage**         | Document collections with indexed queries | `ctx.storage`          |
| **KV**              | Key-value pairs for state and settings    | `ctx.kv`               |
| **Settings Schema** | Auto-generated admin UI for configuration | `admin.settingsSchema` |

## Storage Collections

Declare in `definePlugin({ storage })`. EmDash creates the schema automatically — no migrations.

```typescript
definePlugin({
	id: "forms",
	version: "1.0.0",

	storage: {
		submissions: {
			indexes: [
				"formId", // Single-field index
				"status",
				"createdAt",
				["formId", "createdAt"], // Composite index
			],
		},
		forms: {
			indexes: ["slug"],
		},
	},
});
```

Storage is scoped to the plugin — `submissions` in plugin `forms` is separate from `submissions` in another plugin.

### CRUD

```typescript
const { submissions } = ctx.storage;

await submissions.put("sub_123", { formId: "contact", email: "user@example.com" });
const item = await submissions.get("sub_123");
const exists = await submissions.exists("sub_123");
await submissions.delete("sub_123");
```

### Batch Operations

```typescript
const items = await submissions.getMany(["sub_1", "sub_2"]); // Map<string, T>

await submissions.putMany([
	{ id: "sub_1", data: { formId: "contact", status: "new" } },
	{ id: "sub_2", data: { formId: "contact", status: "new" } },
]);

const deletedCount = await submissions.deleteMany(["sub_1", "sub_2"]);
```

### Querying

Only indexed fields can be queried. Non-indexed queries throw.

```typescript
const result = await ctx.storage.submissions.query({
	where: {
		formId: "contact",
		status: "pending",
	},
	orderBy: { createdAt: "desc" },
	limit: 20,
});

// result.items - Array of { id, data }
// result.cursor - Pagination cursor
// result.hasMore - Boolean
```

### Where Operators

```typescript
// Exact match
where: { status: "pending" }

// Range
where: { createdAt: { gte: "2024-01-01" } }
where: { score: { gt: 50, lte: 100 } }

// In
where: { status: { in: ["pending", "approved"] } }

// Starts with
where: { slug: { startsWith: "blog-" } }
```

### Pagination

```typescript
let cursor: string | undefined;
do {
	const result = await ctx.storage.submissions!.query({
		orderBy: { createdAt: "desc" },
		limit: 100,
		cursor,
	});
	// process result.items
	cursor = result.cursor;
} while (cursor);
```

### Counting

```typescript
const total = await ctx.storage.submissions!.count();
const pending = await ctx.storage.submissions!.count({ status: "pending" });
```

### Index Design

| Query Pattern                            | Index Needed              |
| ---------------------------------------- | ------------------------- |
| Filter by `formId`                       | `"formId"`                |
| Filter by `formId`, order by `createdAt` | `["formId", "createdAt"]` |
| Order by `createdAt` only                | `"createdAt"`             |

Composite indexes support filtering on the first field + ordering by the second.

### Type Safety

```typescript
interface Submission {
	formId: string;
	status: "pending" | "approved" | "spam";
	createdAt: string;
}

// Cast in hook/route handlers
const submissions = ctx.storage.submissions as StorageCollection<Submission>;
```

### Full API

```typescript
interface StorageCollection<T = unknown> {
	get(id: string): Promise<T | null>;
	put(id: string, data: T): Promise<void>;
	delete(id: string): Promise<boolean>;
	exists(id: string): Promise<boolean>;
	getMany(ids: string[]): Promise<Map<string, T>>;
	putMany(items: Array<{ id: string; data: T }>): Promise<void>;
	deleteMany(ids: string[]): Promise<number>;
	query(options?: QueryOptions): Promise<PaginatedResult<{ id: string; data: T }>>;
	count(where?: WhereClause): Promise<number>;
}
```

## KV Store

General-purpose key-value store. Use for internal state, cached computations, or programmatic access to settings.

```typescript
interface KVAccess {
	get<T>(key: string): Promise<T | null>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<boolean>;
	list(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
}
```

### Key Naming Conventions

| Prefix      | Purpose                       | Example           |
| ----------- | ----------------------------- | ----------------- |
| `settings:` | User-configurable preferences | `settings:apiKey` |
| `state:`    | Internal plugin state         | `state:lastSync`  |
| `cache:`    | Cached data                   | `cache:results`   |

```typescript
await ctx.kv.set("settings:webhookUrl", url);
await ctx.kv.set("state:lastRun", new Date().toISOString());
const allSettings = await ctx.kv.list("settings:");
```

## Settings Schema

Declare `admin.settingsSchema` to auto-generate a settings form in the admin UI:

```typescript
admin: {
	settingsSchema: {
		siteTitle: {
			type: "string",
			label: "Site Title",
			description: "Used in title tags",
			default: "",
		},
		maxItems: {
			type: "number",
			label: "Max Items",
			default: 100,
			min: 1,
			max: 1000,
		},
		enabled: {
			type: "boolean",
			label: "Enabled",
			default: true,
		},
		theme: {
			type: "select",
			label: "Theme",
			options: [
				{ value: "light", label: "Light" },
				{ value: "dark", label: "Dark" },
			],
			default: "light",
		},
		apiKey: {
			type: "secret",
			label: "API Key",
			description: "Encrypted at rest",
		},
	},
}
```

### Setting Types

| Type      | UI           | Notes                                     |
| --------- | ------------ | ----------------------------------------- |
| `string`  | Text input   | Optional `multiline: true` for textarea   |
| `number`  | Number input | Optional `min`, `max`                     |
| `boolean` | Toggle       |                                           |
| `select`  | Dropdown     | Requires `options: [{ value, label }]`    |
| `secret`  | Masked input | Encrypted at rest, never shown after save |

### Reading Settings

Settings are accessed via KV with `settings:` prefix:

```typescript
const enabled = (await ctx.kv.get<boolean>("settings:enabled")) ?? true;
const apiKey = await ctx.kv.get<string>("settings:apiKey");
```

Schema defaults are UI defaults only — not auto-persisted. Handle missing values with `??` or persist defaults in `plugin:install`:

```typescript
"plugin:install": async (_event, ctx) => {
	await ctx.kv.set("settings:enabled", true);
	await ctx.kv.set("settings:maxItems", 100);
}
```

## When to Use What

| Use Case                                     | Mechanism                         |
| -------------------------------------------- | --------------------------------- |
| Admin-editable preferences                   | `settingsSchema` + KV `settings:` |
| Internal state (timestamps, cursors)         | KV `state:`                       |
| Collections of documents (logs, submissions) | Storage                           |
| Cached computations                          | KV `cache:`                       |
