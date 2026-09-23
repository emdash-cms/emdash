# Storage and KV

Sandboxed plugins have three plugin-scoped data APIs:

| API                        | Use                                                     |
| -------------------------- | ------------------------------------------------------- |
| `ctx.storage.<collection>` | Queryable records declared in `emdash-plugin.jsonc`     |
| `ctx.settings`             | User-configurable settings, including encrypted secrets |
| `ctx.kv`                   | Cursors, cached values, and other key-value state       |

All three stores use the host database and are isolated by runtime plugin ID. None needs a capability.

## Declare storage collections

Declare every collection and query index in the manifest:

```jsonc title="emdash-plugin.jsonc"
{
	"storage": {
		"submissions": {
			"indexes": ["formId", "status", "createdAt", ["formId", "createdAt"]],
			"uniqueIndexes": ["externalId"],
		},
	},
}
```

An undeclared collection is rejected by the sandbox bridge. Fields in `uniqueIndexes` are already queryable; do not repeat them in `indexes`.

## Collection operations

Every declared collection exposes this portable API in native, Cloudflare-sandboxed, and Node/workerd-sandboxed execution:

```typescript
interface StorageCollection<T = unknown> {
	get(id: string): Promise<T | null>;
	put(id: string, data: T): Promise<void>;
	delete(id: string): Promise<boolean>;
	exists(id: string): Promise<boolean>;

	getVersioned(id: string): Promise<{ value: T; revision: string } | null>;
	compareAndSet(
		id: string,
		expectedRevision: string | null,
		data: T,
	): Promise<{ applied: true; revision: string } | { applied: false }>;
	compareAndDelete(id: string, expectedRevision: string): Promise<{ applied: boolean }>;
	updateIf(id: string, args: UpdateIfArgs<T>): Promise<UpdateIfResult<T>>;

	getMany(ids: string[]): Promise<Map<string, T>>;
	putMany(items: Array<{ id: string; data: T }>): Promise<void>;
	deleteMany(ids: string[]): Promise<number>;

	query(options?: QueryOptions): Promise<{
		items: Array<{ id: string; data: T }>;
		cursor?: string;
		hasMore: boolean;
	}>;
	count(where?: WhereClause): Promise<number>;
}
```

The Node/workerd wrapper also contains content batch methods. They are not part of `StorageCollection`; storage batch methods in the interface above are portable across both runners.

## Basic and batch writes

```typescript
const submissions = ctx.storage.submissions as StorageCollection<Submission>;

await submissions.put("sub_123", {
	formId: "contact",
	status: "pending",
	createdAt: new Date().toISOString(),
});

const item = await submissions.get("sub_123");
const exists = await submissions.exists("sub_123");

const items = await submissions.getMany(["sub_123", "sub_456"]);
await submissions.putMany([
	{ id: "sub_456", data: { formId: "contact", status: "pending" } },
	{ id: "sub_789", data: { formId: "sales", status: "pending" } },
]);
const deleted = await submissions.deleteMany(["sub_456", "sub_789"]);
```

`getMany()` returns a `Map`, including after crossing either sandbox bridge.

## Revision-based compare and set

Use `getVersioned()`, `compareAndSet()`, and `compareAndDelete()` when concurrent requests may replace the same whole value.

```typescript
const current = await submissions.getVersioned("sub_123");
if (!current) throw new Error("Submission not found");

const result = await submissions.compareAndSet("sub_123", current.revision, {
	...current.value,
	status: "processing",
});

if (!result.applied) {
	// Another request changed or deleted the value. Read it again before retrying.
}
```

The operations have these preconditions:

| Operation                             | Behavior                                                  |
| ------------------------------------- | --------------------------------------------------------- |
| `getVersioned(key)`                   | Returns `{ value, revision }`, or `null` only when absent |
| `compareAndSet(key, null, value)`     | Creates only when absent                                  |
| `compareAndSet(key, revision, value)` | Replaces only when the current revision matches           |
| `compareAndDelete(key, revision)`     | Deletes only when the current revision matches            |

A stored JSON `null` still returns a versioned envelope. Every successful write changes the revision, including an equal-value `put()` or `set()`. Revisions are opaque, key-specific values; pass them back unchanged.

Conflicts return `applied: false`. Invalid inputs, permission failures, unique-index violations, and database failures reject. After a conflict, re-read and recompute; keep retries bounded. A lost response can leave the write outcome unknown, so CAS is not an exactly-once mechanism for external side effects.

The versioned methods are also available on `ctx.kv`:

```typescript
const current = await ctx.kv.getVersioned<number>("state:completed");
const next = (current?.value ?? 0) + 1;
const result = await ctx.kv.compareAndSet("state:completed", current?.revision ?? null, next);
```

## Predicate-guarded updates

`updateIf()` changes fields of an existing document when its stored data matches a guard. The guard, field replacements, and integer deltas execute atomically for that record.

```typescript
const result = await submissions.updateIf("sub_123", {
	where: { status: "pending", attempts: { lt: 3 } },
	set: { status: "processing", lastAttemptAt: new Date().toISOString() },
	delta: { attempts: { inc: 1 } },
});

if (result.applied) {
	ctx.log.info("Claimed submission", { submission: result.data });
}
```

`updateIf()` returns `{ applied: false }` when the row is absent, the guard fails, the stored document is not an object, or integer arithmetic is unsafe. It never inserts.

Rules:

- `where` is required. An explicit `{}` means “match any existing row.”
- `set` replaces supplied top-level fields and leaves other fields unchanged.
- `delta` contains exactly one safe-integer `inc` or `dec` per field. Missing or `null` counters start at zero.
- A field cannot appear in both `set` and `delta`.
- At least one defined field must remain in `set` or `delta`.
- Pair `dec: n` with a `gte: n` guard when the value must stay nonnegative.

Malformed arguments reject without writing. In native PostgreSQL execution, serialization failures and deadlocks throw `StorageSerializationError` with `code: "STORAGE_SERIALIZATION_FAILURE"` and `retryable: true`. Sandbox transports preserve the safe fields but do not guarantee `instanceof`; check `code` and `retryable`. Restart an entire explicit transaction before retrying it.

## Indexed queries

Only declared index fields can be filtered or ordered:

```typescript
const result = await submissions.query({
	where: {
		formId: "contact",
		status: { in: ["pending", "processing"] },
		createdAt: { gte: "2026-01-01" },
	},
	orderBy: { createdAt: "desc" },
	limit: 100,
	cursor,
});
```

Supported filters are exact values, `{ in: [...] }`, `{ startsWith: "..." }`, and range objects using `gt`, `gte`, `lt`, or `lte`. A range needs at least one defined bound.

`query()` defaults to 50 items and returns at most 100 per page. Follow `cursor` while `hasMore` is true. `count(where)` accepts the same indexed filters.

Composite index order determines useful query shapes. `['formId', 'createdAt']` supports filtering by `formId` and ordering by `createdAt`; it does not replace a standalone `createdAt` index for queries that omit `formId`.

## KV operations

KV supports unconditional, versioned, delete, and prefix-list operations:

```typescript
interface KVAccess {
	get<T>(key: string): Promise<T | null>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<boolean>;
	list(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
	getVersioned<T>(key: string): Promise<{ value: T; revision: string } | null>;
	compareAndSet(
		key: string,
		expectedRevision: string | null,
		value: unknown,
	): Promise<{ applied: true; revision: string } | { applied: false }>;
	compareAndDelete(key: string, expectedRevision: string): Promise<{ applied: boolean }>;
}
```

Use stable prefixes to keep internal KV keys discoverable:

```typescript
await ctx.settings.set("webhookUrl", url);
await ctx.kv.set("state:lastRun", new Date().toISOString());
await ctx.kv.set("cache:summary", summary);
const settings = await ctx.settings.list();
```

The plugin CLI serializes `admin.settingsSchema`, and both sandbox bridges route `ctx.settings` through the same options records as the generated admin form. Values saved in that form are available through `ctx.settings.get("<key>")`. The complete settings API supports `set`, `delete`, `list`, `getVersioned`, `compareAndSet`, and `compareAndDelete`.

Fields declared as `secret` use a versioned AES-GCM envelope with the plugin ID and setting key as authenticated data. `EMDASH_ENCRYPTION_KEY` may contain a comma-separated rotation list: the first key encrypts new values and the envelope's `kid` selects a key for reads. Missing, wrong, and tampered keys fail closed without exposing plaintext. Existing plaintext secrets remain readable and become encrypted when saved again.

Keep the full encryption-key list with operational backups. Restoring the database without every key referenced by its encrypted settings leaves those values unreadable. `ctx.kv.get("settings:<key>")` remains a compatibility alias throughout EmDash 0.x; new plugins should use `ctx.settings`.
