/**
 * Bridge Handler
 *
 * Handles bridge calls from sandboxed plugin workers.
 * Used in two contexts:
 * - Dev mode: as a miniflare outboundService function (Request -> Response)
 * - Production: called from the backing service HTTP handler
 *
 * Each handler is scoped to a specific plugin with its capabilities.
 * Capability enforcement happens here, not in the plugin.
 *
 * This implementation maintains behavioral parity with the Cloudflare
 * PluginBridge (packages/cloudflare/src/sandbox/bridge.ts). Same inputs
 * must produce same outputs, same return shapes, same error messages.
 */

// @ts-ignore -- value exports used at runtime
import { createHttpAccess, createUnrestrictedHttpAccess } from "emdash";
import type { Database } from "emdash";
import type { SandboxEmailSendCallback } from "emdash";
import { sql, type Kysely } from "kysely";

/** Validates collection/field names to prevent SQL injection */
const COLLECTION_NAME_RE = /^[a-z][a-z0-9_]*$/;

/** System columns that plugins cannot directly write to */
const SYSTEM_COLUMNS = new Set([
	"id",
	"slug",
	"status",
	"author_id",
	"created_at",
	"updated_at",
	"published_at",
	"scheduled_at",
	"deleted_at",
	"version",
	"live_revision_id",
	"draft_revision_id",
]);

export interface BridgeHandlerOptions {
	pluginId: string;
	version: string;
	capabilities: string[];
	allowedHosts: string[];
	storageCollections: string[];
	db: Kysely<Database>;
	emailSend: () => SandboxEmailSendCallback | null;
}

/**
 * Create a bridge handler function scoped to a specific plugin.
 * Returns an async function that takes a Request and returns a Response.
 */
export function createBridgeHandler(
	opts: BridgeHandlerOptions,
): (request: Request) => Promise<Response> {
	return async (request: Request): Promise<Response> => {
		try {
			const url = new URL(request.url);
			const method = url.pathname.slice(1);

			let body: Record<string, unknown> = {};
			if (request.method === "POST") {
				const text = await request.text();
				if (text) {
					body = JSON.parse(text) as Record<string, unknown>;
				}
			}

			const result = await dispatch(opts, method, body);
			return Response.json({ result });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Internal error";
			return new Response(JSON.stringify({ error: message }), {
				status: 500,
				headers: { "Content-Type": "application/json" },
			});
		}
	};
}

// ── Dispatch ─────────────────────────────────────────────────────────────

async function dispatch(
	opts: BridgeHandlerOptions,
	method: string,
	body: Record<string, unknown>,
): Promise<unknown> {
	const { db, pluginId } = opts;

	switch (method) {
		// ── KV (stored in _plugin_storage with collection='__kv') ────────
		case "kv/get":
			return kvGet(db, pluginId, requireString(body, "key"));
		case "kv/set":
			return kvSet(db, pluginId, requireString(body, "key"), body.value);
		case "kv/delete":
			return kvDelete(db, pluginId, requireString(body, "key"));
		case "kv/list":
			return kvList(db, pluginId, (body.prefix as string) ?? "");

		// ── Content ─────────────────────────────────────────────────────
		case "content/get":
			requireCapability(opts, "read:content");
			return contentGet(db, requireString(body, "collection"), requireString(body, "id"));
		case "content/list":
			requireCapability(opts, "read:content");
			return contentList(db, requireString(body, "collection"), body);
		case "content/create":
			requireCapability(opts, "write:content");
			return contentCreate(
				db,
				requireString(body, "collection"),
				body.data as Record<string, unknown>,
			);
		case "content/update":
			requireCapability(opts, "write:content");
			return contentUpdate(
				db,
				requireString(body, "collection"),
				requireString(body, "id"),
				body.data as Record<string, unknown>,
			);
		case "content/delete":
			requireCapability(opts, "write:content");
			return contentDelete(db, requireString(body, "collection"), requireString(body, "id"));

		// ── Media ───────────────────────────────────────────────────────
		case "media/get":
			requireCapability(opts, "read:media");
			return mediaGet(db, requireString(body, "id"));
		case "media/list":
			requireCapability(opts, "read:media");
			return mediaList(db, body);
		case "media/delete":
			requireCapability(opts, "write:media");
			return mediaDelete(db, requireString(body, "id"));

		// ── HTTP ────────────────────────────────────────────────────────
		case "http/fetch":
			requireCapability(opts, "network:fetch");
			return httpFetch(requireString(body, "url"), body.init as RequestInit | undefined, opts);

		// ── Email ───────────────────────────────────────────────────────
		case "email/send": {
			requireCapability(opts, "email:send");
			const message = body.message as {
				to: string;
				subject: string;
				text: string;
				html?: string;
			};
			if (!message?.to || !message?.subject || !message?.text) {
				throw new Error("email/send requires message with to, subject, and text");
			}
			const emailSend = opts.emailSend();
			if (!emailSend) throw new Error("Email is not configured. No email provider is available.");
			await emailSend(message, pluginId);
			return null;
		}

		// ── Users ───────────────────────────────────────────────────────
		case "users/get":
			requireCapability(opts, "read:users");
			return userGet(db, requireString(body, "id"));
		case "users/getByEmail":
			requireCapability(opts, "read:users");
			return userGetByEmail(db, requireString(body, "email"));
		case "users/list":
			requireCapability(opts, "read:users");
			return userList(db, body);

		// ── Storage (document store, scoped to declared collections) ────
		case "storage/get":
			validateStorageCollection(opts, requireString(body, "collection"));
			return storageGet(db, pluginId, requireString(body, "collection"), requireString(body, "id"));
		case "storage/put":
			validateStorageCollection(opts, requireString(body, "collection"));
			return storagePut(
				db,
				pluginId,
				requireString(body, "collection"),
				requireString(body, "id"),
				body.data,
			);
		case "storage/delete":
			validateStorageCollection(opts, requireString(body, "collection"));
			return storageDelete(
				db,
				pluginId,
				requireString(body, "collection"),
				requireString(body, "id"),
			);
		case "storage/query":
			validateStorageCollection(opts, requireString(body, "collection"));
			return storageQuery(db, pluginId, requireString(body, "collection"), body);
		case "storage/count":
			validateStorageCollection(opts, requireString(body, "collection"));
			return storageCount(db, pluginId, requireString(body, "collection"));
		case "storage/getMany":
			validateStorageCollection(opts, requireString(body, "collection"));
			return storageGetMany(db, pluginId, requireString(body, "collection"), body.ids as string[]);
		case "storage/putMany":
			validateStorageCollection(opts, requireString(body, "collection"));
			return storagePutMany(
				db,
				pluginId,
				requireString(body, "collection"),
				body.items as Array<{ id: string; data: unknown }>,
			);
		case "storage/deleteMany":
			validateStorageCollection(opts, requireString(body, "collection"));
			return storageDeleteMany(
				db,
				pluginId,
				requireString(body, "collection"),
				body.ids as string[],
			);

		// ── Logging ─────────────────────────────────────────────────────
		case "log": {
			const level = requireString(body, "level") as "debug" | "info" | "warn" | "error";
			const msg = requireString(body, "msg");
			console[level](`[plugin:${pluginId}]`, msg, body.data ?? "");
			return null;
		}

		default:
			throw new Error(`Unknown bridge method: ${method}`);
	}
}

// ── Validation ───────────────────────────────────────────────────────────

function requireString(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value !== "string") throw new Error(`Missing required string parameter: ${key}`);
	return value;
}

function requireCapability(opts: BridgeHandlerOptions, capability: string): void {
	if (capability === "read:content" && opts.capabilities.includes("write:content")) return;
	if (capability === "read:media" && opts.capabilities.includes("write:media")) return;
	if (!opts.capabilities.includes(capability)) {
		throw new Error(`Plugin ${opts.pluginId} does not have capability: ${capability}`);
	}
}

function validateStorageCollection(opts: BridgeHandlerOptions, collection: string): void {
	if (!opts.storageCollections.includes(collection)) {
		throw new Error(`Plugin ${opts.pluginId} does not declare storage collection: ${collection}`);
	}
}

function validateCollectionName(collection: string): void {
	if (!COLLECTION_NAME_RE.test(collection)) {
		throw new Error(`Invalid collection name: ${collection}`);
	}
}

// ── Value serialization (matches Cloudflare bridge) ──────────────────────

function serializeValue(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (typeof value === "object") return JSON.stringify(value);
	return value;
}

/**
 * Transform a raw DB row into the content item shape returned to plugins.
 * Matches the Cloudflare bridge's rowToContentItem.
 */
function rowToContentItem(
	collection: string,
	row: Record<string, unknown>,
): {
	id: string;
	type: string;
	data: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
} {
	const data: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		if (!SYSTEM_COLUMNS.has(key)) {
			if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
				try {
					data[key] = JSON.parse(value);
				} catch {
					data[key] = value;
				}
			} else if (value !== null) {
				data[key] = value;
			}
		}
	}

	return {
		id: typeof row.id === "string" ? row.id : String(row.id),
		type: collection,
		data,
		createdAt: typeof row.created_at === "string" ? row.created_at : new Date().toISOString(),
		updatedAt: typeof row.updated_at === "string" ? row.updated_at : new Date().toISOString(),
	};
}

// ── KV Operations ────────────────────────────────────────────────────────
// Uses _plugin_storage with collection='__kv' (matching Cloudflare bridge)

async function kvGet(db: Kysely<Database>, pluginId: string, key: string): Promise<unknown> {
	const row = await db
		.selectFrom("_plugin_storage" as keyof Database)
		.where("plugin_id", "=", pluginId)
		.where("collection", "=", "__kv")
		.where("id", "=", key)
		.select("data")
		.executeTakeFirst();
	if (!row) return null;
	try {
		return JSON.parse(row.data as string);
	} catch {
		return row.data;
	}
}

async function kvSet(
	db: Kysely<Database>,
	pluginId: string,
	key: string,
	value: unknown,
): Promise<void> {
	const serialized = JSON.stringify(value);
	const now = new Date().toISOString();
	await db
		.insertInto("_plugin_storage" as keyof Database)
		.values({
			plugin_id: pluginId,
			collection: "__kv",
			id: key,
			data: serialized,
			created_at: now,
			updated_at: now,
		} as never)
		.onConflict((oc) =>
			oc.columns(["plugin_id", "collection", "id"] as never[]).doUpdateSet({
				data: serialized,
				updated_at: now,
			} as never),
		)
		.execute();
}

async function kvDelete(db: Kysely<Database>, pluginId: string, key: string): Promise<boolean> {
	const result = await db
		.deleteFrom("_plugin_storage" as keyof Database)
		.where("plugin_id", "=", pluginId)
		.where("collection", "=", "__kv")
		.where("id", "=", key)
		.executeTakeFirst();
	return BigInt(result.numDeletedRows) > 0n;
}

async function kvList(
	db: Kysely<Database>,
	pluginId: string,
	prefix: string,
): Promise<Array<{ key: string; value: unknown }>> {
	const rows = await db
		.selectFrom("_plugin_storage" as keyof Database)
		.where("plugin_id", "=", pluginId)
		.where("collection", "=", "__kv")
		.where("id", "like", `${prefix}%`)
		.select(["id", "data"])
		.execute();

	return rows.map((r) => ({
		key: r.id as string,
		value: JSON.parse(r.data as string),
	}));
}

// ── Content Operations ───────────────────────────────────────────────────

async function contentGet(
	db: Kysely<Database>,
	collection: string,
	id: string,
): Promise<{
	id: string;
	type: string;
	data: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
} | null> {
	validateCollectionName(collection);
	try {
		const row = await db
			.selectFrom(`ec_${collection}` as keyof Database)
			.where("id", "=", id)
			.where("deleted_at", "is", null)
			.selectAll()
			.executeTakeFirst();
		if (!row) return null;
		return rowToContentItem(collection, row as Record<string, unknown>);
	} catch {
		return null;
	}
}

async function contentList(
	db: Kysely<Database>,
	collection: string,
	opts: Record<string, unknown>,
): Promise<{
	items: Array<{
		id: string;
		type: string;
		data: Record<string, unknown>;
		createdAt: string;
		updatedAt: string;
	}>;
	cursor?: string;
	hasMore: boolean;
}> {
	validateCollectionName(collection);
	const limit = Math.min(Number(opts.limit) || 50, 100);
	try {
		let query = db
			.selectFrom(`ec_${collection}` as keyof Database)
			.where("deleted_at", "is", null)
			.selectAll()
			.orderBy("id", "desc");

		if (typeof opts.cursor === "string") {
			query = query.where("id", "<", opts.cursor);
		}

		const rows = await query.limit(limit + 1).execute();
		const pageRows = rows.slice(0, limit);
		const items = pageRows.map((row) =>
			rowToContentItem(collection, row as Record<string, unknown>),
		);
		const hasMore = rows.length > limit;

		return {
			items,
			cursor: hasMore && items.length > 0 ? items.at(-1)!.id : undefined,
			hasMore,
		};
	} catch {
		return { items: [], hasMore: false };
	}
}

async function contentCreate(
	db: Kysely<Database>,
	collection: string,
	data: Record<string, unknown>,
): Promise<{
	id: string;
	type: string;
	data: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}> {
	validateCollectionName(collection);

	// Generate ULID for the new content item
	const { ulid } = await import("ulidx");
	const id = ulid();
	const now = new Date().toISOString();

	// Build insert values: system columns + user data columns
	const values: Record<string, unknown> = {
		id,
		slug: typeof data.slug === "string" ? data.slug : null,
		status: typeof data.status === "string" ? data.status : "draft",
		author_id: typeof data.author_id === "string" ? data.author_id : null,
		created_at: now,
		updated_at: now,
		version: 1,
	};

	// Add user data fields (skip system columns, validate names)
	for (const [key, value] of Object.entries(data)) {
		if (!SYSTEM_COLUMNS.has(key) && COLLECTION_NAME_RE.test(key)) {
			values[key] = serializeValue(value);
		}
	}

	await db
		.insertInto(`ec_${collection}` as keyof Database)
		.values(values as never)
		.execute();

	// Re-read the created row
	const created = await db
		.selectFrom(`ec_${collection}` as keyof Database)
		.where("id", "=", id)
		.where("deleted_at", "is", null)
		.selectAll()
		.executeTakeFirst();

	if (!created) {
		return { id, type: collection, data: {}, createdAt: now, updatedAt: now };
	}
	return rowToContentItem(collection, created as Record<string, unknown>);
}

async function contentUpdate(
	db: Kysely<Database>,
	collection: string,
	id: string,
	data: Record<string, unknown>,
): Promise<{
	id: string;
	type: string;
	data: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}> {
	validateCollectionName(collection);

	const now = new Date().toISOString();

	// Build update: always bump updated_at and version
	let query = db
		.updateTable(`ec_${collection}` as keyof Database)
		.set({ updated_at: now } as never)
		.set(sql`version = version + 1` as never)
		.where("id", "=", id)
		.where("deleted_at", "is", null);

	// System field updates
	if (typeof data.status === "string") {
		query = query.set({ status: data.status } as never);
	}
	if (data.slug !== undefined) {
		query = query.set({ slug: typeof data.slug === "string" ? data.slug : null } as never);
	}

	// User data fields
	for (const [key, value] of Object.entries(data)) {
		if (!SYSTEM_COLUMNS.has(key) && COLLECTION_NAME_RE.test(key)) {
			query = query.set({ [key]: serializeValue(value) } as never);
		}
	}

	const result = await query.executeTakeFirst();
	if (BigInt(result.numUpdatedRows) === 0n) {
		throw new Error(`Content not found or deleted: ${collection}/${id}`);
	}

	// Re-read the updated row
	const updated = await db
		.selectFrom(`ec_${collection}` as keyof Database)
		.where("id", "=", id)
		.where("deleted_at", "is", null)
		.selectAll()
		.executeTakeFirst();

	if (!updated) {
		throw new Error(`Content not found: ${collection}/${id}`);
	}
	return rowToContentItem(collection, updated as Record<string, unknown>);
}

async function contentDelete(
	db: Kysely<Database>,
	collection: string,
	id: string,
): Promise<boolean> {
	validateCollectionName(collection);

	// Soft-delete: set deleted_at timestamp (matching Cloudflare bridge)
	const now = new Date().toISOString();
	const result = await db
		.updateTable(`ec_${collection}` as keyof Database)
		.set({ deleted_at: now, updated_at: now } as never)
		.where("id", "=", id)
		.where("deleted_at", "is", null)
		.executeTakeFirst();

	return BigInt(result.numUpdatedRows) > 0n;
}

// ── Media Operations ─────────────────────────────────────────────────────

interface MediaRow {
	id: string;
	filename: string;
	mime_type: string;
	size: number | null;
	storage_key: string;
	created_at: string;
}

function rowToMediaItem(row: MediaRow) {
	return {
		id: row.id,
		filename: row.filename,
		mimeType: row.mime_type,
		size: row.size,
		url: `/_emdash/api/media/file/${row.storage_key}`,
		createdAt: row.created_at,
	};
}

async function mediaGet(
	db: Kysely<Database>,
	id: string,
): Promise<{
	id: string;
	filename: string;
	mimeType: string;
	size: number | null;
	url: string;
	createdAt: string;
} | null> {
	const row = await db
		.selectFrom("media" as keyof Database)
		.where("id", "=", id)
		.selectAll()
		.executeTakeFirst();
	if (!row) return null;
	return rowToMediaItem(row as unknown as MediaRow);
}

async function mediaList(
	db: Kysely<Database>,
	opts: Record<string, unknown>,
): Promise<{
	items: Array<{
		id: string;
		filename: string;
		mimeType: string;
		size: number | null;
		url: string;
		createdAt: string;
	}>;
	cursor?: string;
	hasMore: boolean;
}> {
	const limit = Math.min(Number(opts.limit) || 50, 100);

	// Only return ready items (matching Cloudflare bridge)
	let query = db
		.selectFrom("media" as keyof Database)
		.where("status", "=", "ready")
		.selectAll()
		.orderBy("id", "desc");

	if (typeof opts.mimeType === "string") {
		query = query.where("mime_type", "like", `${opts.mimeType}%`);
	}

	if (typeof opts.cursor === "string") {
		query = query.where("id", "<", opts.cursor);
	}

	const rows = await query.limit(limit + 1).execute();
	const pageRows = rows.slice(0, limit);
	const items = pageRows.map((row) => rowToMediaItem(row as unknown as MediaRow));
	const hasMore = rows.length > limit;

	return {
		items,
		cursor: hasMore && items.length > 0 ? items.at(-1)!.id : undefined,
		hasMore,
	};
}

async function mediaDelete(db: Kysely<Database>, id: string): Promise<boolean> {
	// Look up storage key before deleting (for future Storage cleanup)
	const media = await db
		.selectFrom("media" as keyof Database)
		.where("id", "=", id)
		.select("storage_key")
		.executeTakeFirst();

	if (!media) return false;

	const result = await db
		.deleteFrom("media" as keyof Database)
		.where("id", "=", id)
		.executeTakeFirst();

	// Note: Storage object deletion requires the Storage interface,
	// which is not yet wired into the bridge handler. The DB row is
	// deleted; the storage object may become orphaned. The system
	// cleanup cron handles orphaned storage objects.

	return BigInt(result.numDeletedRows) > 0n;
}

// ── HTTP Operations ──────────────────────────────────────────────────────

async function httpFetch(
	url: string,
	init: RequestInit | undefined,
	opts: BridgeHandlerOptions,
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
	const hasAnyFetch = opts.capabilities.includes("network:fetch:any");
	const httpAccess = hasAnyFetch
		? createUnrestrictedHttpAccess(opts.pluginId)
		: createHttpAccess(opts.pluginId, opts.allowedHosts || []);

	const res = await httpAccess.fetch(url, init);
	const text = await res.text();
	const headers: Record<string, string> = {};
	res.headers.forEach((v, k) => {
		headers[k] = v;
	});
	return { status: res.status, headers, text };
}

// ── User Operations ──────────────────────────────────────────────────────

interface UserRow {
	id: string;
	email: string;
	name: string | null;
	role: number;
	created_at: string;
}

function rowToUser(row: UserRow) {
	return {
		id: row.id,
		email: row.email,
		name: row.name,
		role: row.role,
		createdAt: row.created_at,
	};
}

async function userGet(
	db: Kysely<Database>,
	id: string,
): Promise<{
	id: string;
	email: string;
	name: string | null;
	role: number;
	createdAt: string;
} | null> {
	const row = await db
		.selectFrom("users" as keyof Database)
		.where("id", "=", id)
		.select(["id", "email", "name", "role", "created_at"])
		.executeTakeFirst();
	if (!row) return null;
	return rowToUser(row as unknown as UserRow);
}

async function userGetByEmail(
	db: Kysely<Database>,
	email: string,
): Promise<{
	id: string;
	email: string;
	name: string | null;
	role: number;
	createdAt: string;
} | null> {
	const row = await db
		.selectFrom("users" as keyof Database)
		.where("email", "=", email.toLowerCase())
		.select(["id", "email", "name", "role", "created_at"])
		.executeTakeFirst();
	if (!row) return null;
	return rowToUser(row as unknown as UserRow);
}

async function userList(
	db: Kysely<Database>,
	opts: Record<string, unknown>,
): Promise<{
	items: Array<{ id: string; email: string; name: string | null; role: number; createdAt: string }>;
	nextCursor?: string;
}> {
	const limit = Math.max(1, Math.min(Number(opts.limit) || 50, 100));

	let query = db
		.selectFrom("users" as keyof Database)
		.select(["id", "email", "name", "role", "created_at"])
		.orderBy("id", "desc");

	if (opts.role !== undefined) {
		query = query.where("role", "=", Number(opts.role));
	}
	if (typeof opts.cursor === "string") {
		query = query.where("id", "<", opts.cursor);
	}

	const rows = await query.limit(limit + 1).execute();
	const pageRows = rows.slice(0, limit);
	const items = pageRows.map((row) => rowToUser(row as unknown as UserRow));
	const hasMore = rows.length > limit;

	return {
		items,
		nextCursor: hasMore && items.length > 0 ? items.at(-1)!.id : undefined,
	};
}

// ── Storage Operations ───────────────────────────────────────────────────

async function storageGet(
	db: Kysely<Database>,
	pluginId: string,
	collection: string,
	id: string,
): Promise<unknown> {
	const row = await db
		.selectFrom("_plugin_storage" as keyof Database)
		.where("plugin_id", "=", pluginId)
		.where("collection", "=", collection)
		.where("id", "=", id)
		.select("data")
		.executeTakeFirst();
	if (!row) return null;
	return JSON.parse(row.data as string);
}

async function storagePut(
	db: Kysely<Database>,
	pluginId: string,
	collection: string,
	id: string,
	data: unknown,
): Promise<void> {
	const serialized = JSON.stringify(data);
	const now = new Date().toISOString();
	await db
		.insertInto("_plugin_storage" as keyof Database)
		.values({
			plugin_id: pluginId,
			collection,
			id,
			data: serialized,
			created_at: now,
			updated_at: now,
		} as never)
		.onConflict((oc) =>
			oc.columns(["plugin_id", "collection", "id"] as never[]).doUpdateSet({
				data: serialized,
				updated_at: now,
			} as never),
		)
		.execute();
}

async function storageDelete(
	db: Kysely<Database>,
	pluginId: string,
	collection: string,
	id: string,
): Promise<boolean> {
	const result = await db
		.deleteFrom("_plugin_storage" as keyof Database)
		.where("plugin_id", "=", pluginId)
		.where("collection", "=", collection)
		.where("id", "=", id)
		.executeTakeFirst();
	return BigInt(result.numDeletedRows) > 0n;
}

async function storageQuery(
	db: Kysely<Database>,
	pluginId: string,
	collection: string,
	opts: Record<string, unknown>,
): Promise<{ items: Array<{ id: string; data: unknown }>; hasMore: boolean; cursor?: string }> {
	const limit = Math.min(Number(opts.limit) || 50, 1000);
	const rows = await db
		.selectFrom("_plugin_storage" as keyof Database)
		.where("plugin_id", "=", pluginId)
		.where("collection", "=", collection)
		.select(["id", "data"])
		.limit(limit + 1)
		.execute();

	const pageRows = rows.slice(0, limit);
	const items = pageRows.map((r) => ({
		id: r.id as string,
		data: JSON.parse(r.data as string),
	}));
	const hasMore = rows.length > limit;

	return {
		items,
		hasMore,
		cursor: items.length > 0 ? items.at(-1)!.id : undefined,
	};
}

async function storageCount(
	db: Kysely<Database>,
	pluginId: string,
	collection: string,
): Promise<number> {
	const result = await db
		.selectFrom("_plugin_storage" as keyof Database)
		.where("plugin_id", "=", pluginId)
		.where("collection", "=", collection)
		.select(db.fn.countAll().as("count"))
		.executeTakeFirst();
	return Number(result?.count ?? 0);
}

async function storageGetMany(
	db: Kysely<Database>,
	pluginId: string,
	collection: string,
	ids: string[],
): Promise<Record<string, unknown>> {
	if (!ids || ids.length === 0) return {};

	const rows = await db
		.selectFrom("_plugin_storage" as keyof Database)
		.where("plugin_id", "=", pluginId)
		.where("collection", "=", collection)
		.where("id", "in", ids)
		.select(["id", "data"])
		.execute();

	const result: Record<string, unknown> = {};
	for (const row of rows) {
		result[row.id as string] = JSON.parse(row.data as string);
	}
	return result;
}

async function storagePutMany(
	db: Kysely<Database>,
	pluginId: string,
	collection: string,
	items: Array<{ id: string; data: unknown }>,
): Promise<void> {
	if (!items || items.length === 0) return;

	const now = new Date().toISOString();
	for (const item of items) {
		const serialized = JSON.stringify(item.data);
		await db
			.insertInto("_plugin_storage" as keyof Database)
			.values({
				plugin_id: pluginId,
				collection,
				id: item.id,
				data: serialized,
				created_at: now,
				updated_at: now,
			} as never)
			.onConflict((oc) =>
				oc.columns(["plugin_id", "collection", "id"] as never[]).doUpdateSet({
					data: serialized,
					updated_at: now,
				} as never),
			)
			.execute();
	}
}

async function storageDeleteMany(
	db: Kysely<Database>,
	pluginId: string,
	collection: string,
	ids: string[],
): Promise<number> {
	if (!ids || ids.length === 0) return 0;

	let deleted = 0;
	for (const id of ids) {
		const result = await db
			.deleteFrom("_plugin_storage" as keyof Database)
			.where("plugin_id", "=", pluginId)
			.where("collection", "=", collection)
			.where("id", "=", id)
			.executeTakeFirst();
		deleted += Number(result.numDeletedRows);
	}
	return deleted;
}
