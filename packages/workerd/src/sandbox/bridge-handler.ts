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

import { createHttpAccess, createUnrestrictedHttpAccess, PluginStorageRepository } from "emdash";
import type { Database, SandboxEmailSendCallback } from "emdash";
import { sql, type Kysely, type RawBuilder } from "kysely";

/**
 * Schema view of a content table (ec_${collection}) for kysely. The standard
 * system columns are typed; user-defined fields are addressed via the open
 * `[key: string]` index. Each kysely call resolves the table name dynamically
 * via `asContentDb()`.
 */
interface ContentTableRow {
	id: string;
	slug: string | null;
	status: string;
	author_id: string | null;
	created_at: string;
	updated_at: string;
	published_at: string | null;
	scheduled_at: string | null;
	deleted_at: string | null;
	version: number;
	live_revision_id: string | null;
	draft_revision_id: string | null;
	// User-defined fields. kysely.set()/values() accept these because they're
	// typed as unknown rather than never.
	[key: string]: unknown;
}

type ContentSchema = { [tableName: string]: ContentTableRow };

/**
 * View the host db as a content schema where any `ec_*` table is addressable.
 * Centralizes the one unavoidable narrowing for dynamic content tables (whose
 * names are computed from user-defined collection slugs and so cannot appear
 * in the static `Database` interface). The runtime SQL is identical; only the
 * type lens changes.
 */
function asContentDb(db: Kysely<Database>): Kysely<ContentSchema> {
	// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- ec_* content tables are created at runtime by SchemaRegistry and cannot be expressed in the static Database interface. ContentSchema is a structural view of any ec_* table.
	return db as unknown as Kysely<ContentSchema>;
}

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

/** Minimal storage interface for media uploads and deletes */
export interface BridgeStorage {
	upload(options: { key: string; body: Uint8Array; contentType: string }): Promise<unknown>;
	delete(key: string): Promise<unknown>;
}

/** Per-collection storage config (matches manifest.storage entries) */
export interface BridgeStorageCollectionConfig {
	indexes?: Array<string | string[]>;
	uniqueIndexes?: Array<string | string[]>;
}

export interface BridgeHandlerOptions {
	pluginId: string;
	version: string;
	capabilities: string[];
	allowedHosts: string[];
	/** Storage collection names declared by the plugin */
	storageCollections: string[];
	/** Full storage config (with indexes) for proper query/count delegation */
	storageConfig?: Record<string, BridgeStorageCollectionConfig>;
	db: Kysely<Database>;
	emailSend: () => SandboxEmailSendCallback | null;
	/** Storage for media uploads. Optional; media/upload throws if not provided. */
	storage?: BridgeStorage | null;
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
					const parsed: unknown = JSON.parse(text);
					if (!isRecord(parsed)) {
						throw new Error("Bridge request body must be a JSON object");
					}
					body = parsed;
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
			return kvList(db, pluginId, optionalString(body, "prefix") ?? "");

		// ── Content ─────────────────────────────────────────────────────
		case "content/get":
			requireCapability(opts, "read:content");
			return contentGet(db, requireString(body, "collection"), requireString(body, "id"));
		case "content/list":
			requireCapability(opts, "read:content");
			return contentList(db, requireString(body, "collection"), body);
		case "content/create":
			requireCapability(opts, "write:content");
			return contentCreate(db, requireString(body, "collection"), requireRecord(body, "data"));
		case "content/update":
			requireCapability(opts, "write:content");
			return contentUpdate(
				db,
				requireString(body, "collection"),
				requireString(body, "id"),
				requireRecord(body, "data"),
			);
		case "content/delete":
			requireCapability(opts, "write:content");
			return contentDelete(db, requireString(body, "collection"), requireString(body, "id"));
		case "content/createMany":
			requireCapability(opts, "write:content");
			return contentCreateMany(
				db,
				requireString(body, "collection"),
				requireRecordArray(body, "items"),
			);
		case "content/updateMany":
			requireCapability(opts, "write:content");
			return contentUpdateMany(
				db,
				requireString(body, "collection"),
				requireUpdateManyItems(body, "items"),
			);
		case "content/deleteMany":
			requireCapability(opts, "write:content");
			return contentDeleteMany(
				db,
				requireString(body, "collection"),
				requireStringArray(body, "ids"),
			);

		// ── Media ───────────────────────────────────────────────────────
		case "media/get":
			requireCapability(opts, "read:media");
			return mediaGet(db, requireString(body, "id"));
		case "media/list":
			requireCapability(opts, "read:media");
			return mediaList(db, body);
		case "media/upload":
			requireCapability(opts, "write:media");
			return mediaUpload(
				db,
				requireString(body, "filename"),
				requireString(body, "contentType"),
				requireMediaBytes(body, "bytes"),
				optionalString(body, "encoding"),
				opts.storage,
			);
		case "media/delete":
			requireCapability(opts, "write:media");
			return mediaDelete(db, requireString(body, "id"), opts.storage);

		// ── HTTP ────────────────────────────────────────────────────────
		case "http/fetch":
			requireCapability(opts, "network:fetch");
			return httpFetch(requireString(body, "url"), body.init, opts);

		// ── Email ───────────────────────────────────────────────────────
		case "email/send": {
			requireCapability(opts, "email:send");
			const message = requireEmailMessage(body, "message");
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
			return storageGet(opts, requireString(body, "collection"), requireString(body, "id"));
		case "storage/put":
			validateStorageCollection(opts, requireString(body, "collection"));
			return storagePut(
				opts,
				requireString(body, "collection"),
				requireString(body, "id"),
				body.data,
			);
		case "storage/delete":
			validateStorageCollection(opts, requireString(body, "collection"));
			return storageDelete(opts, requireString(body, "collection"), requireString(body, "id"));
		case "storage/query":
			validateStorageCollection(opts, requireString(body, "collection"));
			return storageQuery(opts, requireString(body, "collection"), body);
		case "storage/count":
			validateStorageCollection(opts, requireString(body, "collection"));
			return storageCount(opts, requireString(body, "collection"), optionalRecord(body, "where"));
		case "storage/getMany":
			validateStorageCollection(opts, requireString(body, "collection"));
			return storageGetMany(
				opts,
				requireString(body, "collection"),
				requireStringArray(body, "ids"),
			);
		case "storage/putMany":
			validateStorageCollection(opts, requireString(body, "collection"));
			return storagePutMany(
				opts,
				requireString(body, "collection"),
				requireStorageItems(body, "items"),
			);
		case "storage/deleteMany":
			validateStorageCollection(opts, requireString(body, "collection"));
			return storageDeleteMany(
				opts,
				requireString(body, "collection"),
				requireStringArray(body, "ids"),
			);

		// ── Logging ─────────────────────────────────────────────────────
		case "log": {
			const level = requireLogLevel(body, "level");
			const msg = requireString(body, "msg");
			console[level](`[plugin:${pluginId}]`, msg, body.data ?? "");
			return null;
		}

		default:
			// All outbound fetch() from sandboxed plugins is routed to the
			// backing service via workerd's globalOutbound config. If a plugin
			// calls plain fetch("https://anywhere.com/path") instead of
			// ctx.http.fetch(), we land here. This is intentional: plugins
			// must use ctx.http.fetch (which goes through the http/fetch
			// bridge with capability + host enforcement) to reach the network.
			throw new Error(`Unknown bridge method: ${method}`);
	}
}

// ── Validation ───────────────────────────────────────────────────────────
//
// Bridge call bodies are JSON-RPC-style payloads constructed by the workerd
// plugin wrapper (see ./wrapper.ts) and consumed here. We control both ends
// of the protocol, so these assertions exist to catch buggy or malicious
// plugins rather than to parse an open API surface — that's why they throw
// rather than return tagged errors. The bridge top-level catch turns thrown
// errors into JSON error responses the plugin sees as bridge call failures.
//
// Each `require*` helper is backed by a narrowing predicate so the returned
// value is typed via flow analysis rather than via a `as T` assertion. This
// keeps the @typescript-eslint/no-unsafe-type-assertion rule clean.

type EmailMessage = { to: string; subject: string; text: string; html?: string };
type LogLevel = "debug" | "info" | "warn" | "error";
type UpdateManyItem = { id: string; data: Record<string, unknown> };
type StorageItem = { id: string; data: unknown };

const LOG_LEVELS = new Set<string>(["debug", "info", "warn", "error"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isRecordArray(value: unknown): value is Array<Record<string, unknown>> {
	return Array.isArray(value) && value.every(isRecord);
}

function isUpdateManyItem(value: unknown): value is UpdateManyItem {
	if (!isRecord(value)) return false;
	return typeof value.id === "string" && isRecord(value.data);
}

function isUpdateManyItemArray(value: unknown): value is UpdateManyItem[] {
	return Array.isArray(value) && value.every(isUpdateManyItem);
}

function isStorageItem(value: unknown): value is StorageItem {
	if (!isRecord(value)) return false;
	return typeof value.id === "string";
}

function isStorageItemArray(value: unknown): value is StorageItem[] {
	return Array.isArray(value) && value.every(isStorageItem);
}

function isNumberArray(value: unknown): value is number[] {
	return Array.isArray(value) && value.every((v) => typeof v === "number");
}

function isEmailMessage(value: unknown): value is EmailMessage {
	if (!isRecord(value)) return false;
	if (typeof value.to !== "string") return false;
	if (typeof value.subject !== "string") return false;
	if (typeof value.text !== "string") return false;
	if (value.html !== undefined && typeof value.html !== "string") return false;
	return true;
}

function isLogLevel(value: unknown): value is LogLevel {
	return typeof value === "string" && LOG_LEVELS.has(value);
}

function isOrderBy(value: unknown): value is Record<string, "asc" | "desc"> {
	if (!isRecord(value)) return false;
	for (const dir of Object.values(value)) {
		if (dir !== "asc" && dir !== "desc") return false;
	}
	return true;
}

function requireString(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value !== "string") throw new Error(`Missing required string parameter: ${key}`);
	return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`Parameter ${key} must be a string when provided`);
	return value;
}

function requireRecord(body: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = body[key];
	if (!isRecord(value)) throw new Error(`Missing required object parameter: ${key}`);
	return value;
}

function optionalRecord(
	body: Record<string, unknown>,
	key: string,
): Record<string, unknown> | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error(`Parameter ${key} must be an object when provided`);
	return value;
}

function requireStringArray(body: Record<string, unknown>, key: string): string[] {
	const value = body[key];
	if (!isStringArray(value)) throw new Error(`Parameter ${key} must be an array of strings`);
	return value;
}

function requireRecordArray(
	body: Record<string, unknown>,
	key: string,
): Array<Record<string, unknown>> {
	const value = body[key];
	if (!isRecordArray(value)) throw new Error(`Parameter ${key} must be an array of objects`);
	return value;
}

function requireUpdateManyItems(body: Record<string, unknown>, key: string): UpdateManyItem[] {
	const value = body[key];
	if (!isUpdateManyItemArray(value)) {
		throw new Error(`Parameter ${key} must be an array of { id: string, data: object } items`);
	}
	return value;
}

function requireStorageItems(body: Record<string, unknown>, key: string): StorageItem[] {
	const value = body[key];
	if (!isStorageItemArray(value)) {
		throw new Error(`Parameter ${key} must be an array of { id: string, data } items`);
	}
	return value;
}

function requireMediaBytes(body: Record<string, unknown>, key: string): string | number[] {
	const value = body[key];
	if (typeof value === "string") return value;
	if (isNumberArray(value)) return value;
	throw new Error(`Parameter ${key} must be a string or array of numbers`);
}

function requireEmailMessage(body: Record<string, unknown>, key: string): EmailMessage {
	const value = body[key];
	if (!isEmailMessage(value)) {
		throw new Error("email/send requires message with to, subject, and text");
	}
	return value;
}

function requireLogLevel(body: Record<string, unknown>, key: string): LogLevel {
	const value = body[key];
	if (!isLogLevel(value)) {
		throw new Error(`Parameter ${key} must be one of: debug, info, warn, error`);
	}
	return value;
}

function requireOrderBy(
	body: Record<string, unknown>,
	key: string,
): Record<string, "asc" | "desc"> | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (!isOrderBy(value)) {
		throw new Error(`Parameter ${key} must be an object mapping field to "asc"|"desc"`);
	}
	return value;
}

function requireCapability(opts: BridgeHandlerOptions, capability: string): void {
	// Strict capability check matching the Cloudflare PluginBridge.
	// We do NOT imply write → read here: a plugin that declares only
	// write:content cannot call ctx.content.get/list. The plugin must
	// declare read:content explicitly. This matches the Cloudflare bridge
	// behavior and ensures sandboxed plugins behave the same on both runners.
	//
	// Note: the in-process PluginContextFactory in core does build the read
	// API onto the write object, so a trusted plugin can read with only
	// write:content. The sandbox bridges are stricter on purpose — they
	// enforce the manifest as written.
	//
	// The one exception: network:fetch:any is documented as a strict
	// superset of network:fetch, so the broader capability satisfies it.
	if (capability === "network:fetch" && opts.capabilities.includes("network:fetch:any")) return;
	if (!opts.capabilities.includes(capability)) {
		// Error message matches Cloudflare PluginBridge format
		throw new Error(`Missing capability: ${capability}`);
	}
}

function validateStorageCollection(opts: BridgeHandlerOptions, collection: string): void {
	if (!opts.storageCollections.includes(collection)) {
		// Error message matches Cloudflare PluginBridge format
		throw new Error(`Storage collection not declared: ${collection}`);
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
		.selectFrom("_plugin_storage")
		.where("plugin_id", "=", pluginId)
		.where("collection", "=", "__kv")
		.where("id", "=", key)
		.select("data")
		.executeTakeFirst();
	if (!row) return null;
	try {
		return JSON.parse(row.data);
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
		.insertInto("_plugin_storage")
		.values({
			plugin_id: pluginId,
			collection: "__kv",
			id: key,
			data: serialized,
			created_at: now,
			updated_at: now,
		})
		.onConflict((oc) =>
			oc.columns(["plugin_id", "collection", "id"]).doUpdateSet({
				data: serialized,
				updated_at: now,
			}),
		)
		.execute();
}

async function kvDelete(db: Kysely<Database>, pluginId: string, key: string): Promise<boolean> {
	const result = await db
		.deleteFrom("_plugin_storage")
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
		.selectFrom("_plugin_storage")
		.where("plugin_id", "=", pluginId)
		.where("collection", "=", "__kv")
		.where("id", "like", `${prefix}%`)
		.select(["id", "data"])
		.execute();

	return rows.map((r) => ({
		key: r.id,
		value: JSON.parse(r.data),
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
	const table = `ec_${collection}`;
	try {
		const row = await asContentDb(db)
			.selectFrom(table)
			.where("id", "=", id)
			.where("deleted_at", "is", null)
			.selectAll()
			.executeTakeFirst();
		if (!row) return null;
		return rowToContentItem(collection, row);
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
	const table = `ec_${collection}`;
	const limit = Math.max(1, Math.min(Number(opts.limit) || 50, 100));
	try {
		let query = asContentDb(db)
			.selectFrom(table)
			.where("deleted_at", "is", null)
			.selectAll()
			.orderBy("id", "desc");

		if (typeof opts.cursor === "string") {
			query = query.where("id", "<", opts.cursor);
		}

		const rows = await query.limit(limit + 1).execute();
		const pageRows = rows.slice(0, limit);
		const items = pageRows.map((row) => rowToContentItem(collection, row));
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
	const table = `ec_${collection}`;

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

	const cdb = asContentDb(db);
	await cdb.insertInto(table).values(values).execute();

	// Re-read the created row
	const created = await cdb
		.selectFrom(table)
		.where("id", "=", id)
		.where("deleted_at", "is", null)
		.selectAll()
		.executeTakeFirst();

	if (!created) {
		return { id, type: collection, data: {}, createdAt: now, updatedAt: now };
	}
	return rowToContentItem(collection, created);
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
	const table = `ec_${collection}`;
	const cdb = asContentDb(db);

	const now = new Date().toISOString();

	// Build update: always bump updated_at and version. Collect every column
	// change into a single .set() so the value-bag type is `unknown` per
	// column and we don't need narrowing casts.
	const updates: Record<string, unknown> = {
		updated_at: now,
		version: sql`version + 1` satisfies RawBuilder<unknown>,
	};

	if (typeof data.status === "string") {
		updates.status = data.status;
	}
	if (data.slug !== undefined) {
		updates.slug = typeof data.slug === "string" ? data.slug : null;
	}

	for (const [key, value] of Object.entries(data)) {
		if (!SYSTEM_COLUMNS.has(key) && COLLECTION_NAME_RE.test(key)) {
			updates[key] = serializeValue(value);
		}
	}

	const result = await cdb
		.updateTable(table)
		.set(updates)
		.where("id", "=", id)
		.where("deleted_at", "is", null)
		.executeTakeFirst();

	if (BigInt(result.numUpdatedRows) === 0n) {
		throw new Error(`Content not found or deleted: ${collection}/${id}`);
	}

	// Re-read the updated row
	const updated = await cdb
		.selectFrom(table)
		.where("id", "=", id)
		.where("deleted_at", "is", null)
		.selectAll()
		.executeTakeFirst();

	if (!updated) {
		throw new Error(`Content not found: ${collection}/${id}`);
	}
	return rowToContentItem(collection, updated);
}

async function contentDelete(
	db: Kysely<Database>,
	collection: string,
	id: string,
): Promise<boolean> {
	validateCollectionName(collection);
	const table = `ec_${collection}`;

	// Soft-delete: set deleted_at timestamp (matching Cloudflare bridge)
	const now = new Date().toISOString();
	const result = await asContentDb(db)
		.updateTable(table)
		.set({ deleted_at: now, updated_at: now })
		.where("id", "=", id)
		.where("deleted_at", "is", null)
		.executeTakeFirst();

	return BigInt(result.numUpdatedRows) > 0n;
}

// ── Batch Content Operations ─────────────────────────────────────────────

const MAX_BATCH_SIZE = 100;

async function contentCreateMany(
	db: Kysely<Database>,
	collection: string,
	items: Array<Record<string, unknown>>,
): Promise<
	Array<{
		id: string;
		type: string;
		data: Record<string, unknown>;
		createdAt: string;
		updatedAt: string;
	}>
> {
	if (items.length > MAX_BATCH_SIZE) {
		throw new Error(`Batch size ${items.length} exceeds maximum of ${MAX_BATCH_SIZE}`);
	}
	return db.transaction().execute(async (trx) => {
		const results = [];
		for (const data of items) {
			results.push(await contentCreate(trx, collection, data));
		}
		return results;
	});
}

async function contentUpdateMany(
	db: Kysely<Database>,
	collection: string,
	items: Array<{ id: string; data: Record<string, unknown> }>,
): Promise<
	Array<{
		id: string;
		type: string;
		data: Record<string, unknown>;
		createdAt: string;
		updatedAt: string;
	}>
> {
	if (items.length > MAX_BATCH_SIZE) {
		throw new Error(`Batch size ${items.length} exceeds maximum of ${MAX_BATCH_SIZE}`);
	}
	return db.transaction().execute(async (trx) => {
		const results = [];
		for (const item of items) {
			results.push(await contentUpdate(trx, collection, item.id, item.data));
		}
		return results;
	});
}

async function contentDeleteMany(
	db: Kysely<Database>,
	collection: string,
	ids: string[],
): Promise<number> {
	if (ids.length > MAX_BATCH_SIZE) {
		throw new Error(`Batch size ${ids.length} exceeds maximum of ${MAX_BATCH_SIZE}`);
	}
	return db.transaction().execute(async (trx) => {
		let count = 0;
		for (const id of ids) {
			const deleted = await contentDelete(trx, collection, id);
			if (deleted) count++;
		}
		return count;
	});
}

// ── Media Operations ─────────────────────────────────────────────────────

function rowToMediaItem(row: {
	id: string;
	filename: string;
	mime_type: string;
	size: number | null;
	storage_key: string;
	created_at: string;
}) {
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
	const row = await db.selectFrom("media").where("id", "=", id).selectAll().executeTakeFirst();
	if (!row) return null;
	return rowToMediaItem(row);
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
	const limit = Math.max(1, Math.min(Number(opts.limit) || 50, 100));

	// Only return ready items (matching Cloudflare bridge)
	let query = db
		.selectFrom("media")
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
	const items = pageRows.map((row) => rowToMediaItem(row));
	const hasMore = rows.length > limit;

	return {
		items,
		cursor: hasMore && items.length > 0 ? items.at(-1)!.id : undefined,
		hasMore,
	};
}

const ALLOWED_MIME_PREFIXES = ["image/", "video/", "audio/", "application/pdf"];
const FILE_EXT_RE = /^\.[a-z0-9]{1,10}$/i;

async function mediaUpload(
	db: Kysely<Database>,
	filename: string,
	contentType: string,
	bytes: string | number[],
	encoding: string | undefined,
	storage?: BridgeStorage | null,
): Promise<{ mediaId: string; storageKey: string; url: string }> {
	if (!storage) {
		throw new Error(
			"Media storage is not configured. Cannot upload files without a storage adapter.",
		);
	}

	if (!ALLOWED_MIME_PREFIXES.some((prefix) => contentType.startsWith(prefix))) {
		throw new Error(
			`Unsupported content type: ${contentType}. Allowed: image/*, video/*, audio/*, application/pdf`,
		);
	}

	const { ulid } = await import("ulidx");
	const mediaId = ulid();
	const basename = filename.includes("/")
		? filename.slice(filename.lastIndexOf("/") + 1)
		: filename;
	const rawExt = basename.includes(".") ? basename.slice(basename.lastIndexOf(".")) : "";
	const ext = FILE_EXT_RE.test(rawExt) ? rawExt : "";
	const storageKey = `${mediaId}${ext}`;
	const now = new Date().toISOString();
	let byteArray: Uint8Array;
	if (encoding === "base64" && typeof bytes === "string") {
		const binary = atob(bytes);
		byteArray = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) byteArray[i] = binary.charCodeAt(i);
	} else if (Array.isArray(bytes)) {
		byteArray = new Uint8Array(bytes);
	} else {
		throw new Error("media/upload: bytes must be a base64-encoded string or an array of bytes");
	}

	// Write bytes to storage first, then create DB record.
	// If DB insert fails, delete the storage object so we don't leak files.
	// (cleanupPendingUploads only deletes 'pending' DB rows; objects with no
	// row are invisible to it.)
	await storage.upload({ key: storageKey, body: byteArray, contentType });

	try {
		await db
			.insertInto("media")
			.values({
				id: mediaId,
				filename,
				mime_type: contentType,
				size: byteArray.byteLength,
				storage_key: storageKey,
				status: "ready",
				created_at: now,
			})
			.execute();
	} catch (error) {
		// Best-effort cleanup of the orphaned storage object. Log if cleanup
		// itself fails so operators see the leak instead of silently dropping it.
		try {
			await storage.delete(storageKey);
		} catch (cleanupError) {
			console.warn(
				`[bridge] media/upload: DB insert failed and storage cleanup failed for ${storageKey}. ` +
					`Storage object is leaked.`,
				cleanupError,
			);
		}
		throw error;
	}

	return {
		mediaId,
		storageKey,
		url: `/_emdash/api/media/file/${storageKey}`,
	};
}

async function mediaDelete(
	db: Kysely<Database>,
	id: string,
	storage?: BridgeStorage | null,
): Promise<boolean> {
	// Look up storage key before deleting
	const media = await db
		.selectFrom("media")
		.where("id", "=", id)
		.select("storage_key")
		.executeTakeFirst();

	if (!media) return false;

	// Delete the DB row first
	const result = await db.deleteFrom("media").where("id", "=", id).executeTakeFirst();

	// Delete the storage object. If this fails, log but don't throw —
	// the DB row is already deleted and the orphan cleanup cron will
	// catch it. Matches the Cloudflare bridge's behavior.
	if (storage && media.storage_key) {
		try {
			await storage.delete(media.storage_key);
		} catch (error) {
			console.warn(`[bridge] Failed to delete storage object ${media.storage_key}:`, error);
		}
	}

	return BigInt(result.numDeletedRows) > 0n;
}

// ── HTTP Operations ──────────────────────────────────────────────────────

/** A multipart form part as marshaled by the wrapper. */
interface MarshaledFormDataPart {
	name: string;
	value: string;
	filename?: string;
	type?: string;
	isBlob?: boolean;
}

/** Marshaled RequestInit shape sent over the bridge from the wrapper. */
interface MarshaledRequestInit {
	method?: string;
	redirect?: RequestRedirect;
	/** List of [name, value] pairs to preserve multi-value headers */
	headers?: Array<[string, string]>;
	/**
	 * Body is discriminated by bodyType. The wrapper (see wrapper.ts:
	 * marshalRequestInit) guarantees the shape, but we validate defensively
	 * at unmarshal time so a misbehaving plugin can't smuggle unexpected
	 * data into the host fetch.
	 */
	bodyType?: "string" | "base64" | "formdata";
	body?: string | MarshaledFormDataPart[];
}

function isFormDataPart(value: unknown): value is MarshaledFormDataPart {
	if (!isRecord(value)) return false;
	if (typeof value.name !== "string") return false;
	if (typeof value.value !== "string") return false;
	if (value.filename !== undefined && typeof value.filename !== "string") return false;
	if (value.type !== undefined && typeof value.type !== "string") return false;
	if (value.isBlob !== undefined && typeof value.isBlob !== "boolean") return false;
	return true;
}

function isFormDataPartArray(value: unknown): value is MarshaledFormDataPart[] {
	return Array.isArray(value) && value.every(isFormDataPart);
}

function isMarshaledHeaders(value: unknown): value is Array<[string, string]> {
	return (
		Array.isArray(value) &&
		value.every(
			(entry) =>
				Array.isArray(entry) &&
				entry.length === 2 &&
				typeof entry[0] === "string" &&
				typeof entry[1] === "string",
		)
	);
}

function parseMarshaledRequestInit(value: unknown): MarshaledRequestInit | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		throw new Error("http/fetch: init must be an object");
	}
	const out: MarshaledRequestInit = {};
	if (value.method !== undefined) {
		if (typeof value.method !== "string")
			throw new Error("http/fetch: init.method must be a string");
		out.method = value.method;
	}
	if (value.redirect !== undefined) {
		const r = value.redirect;
		if (r !== "follow" && r !== "error" && r !== "manual") {
			throw new Error('http/fetch: init.redirect must be "follow", "error", or "manual"');
		}
		out.redirect = r;
	}
	if (value.headers !== undefined) {
		if (!isMarshaledHeaders(value.headers)) {
			throw new Error("http/fetch: init.headers must be an array of [name, value] pairs");
		}
		out.headers = value.headers;
	}
	if (value.bodyType !== undefined) {
		if (
			value.bodyType !== "string" &&
			value.bodyType !== "base64" &&
			value.bodyType !== "formdata"
		) {
			throw new Error('http/fetch: init.bodyType must be "string", "base64", or "formdata"');
		}
		out.bodyType = value.bodyType;
	}
	if (value.body !== undefined) {
		if (out.bodyType === "formdata") {
			if (!isFormDataPartArray(value.body)) {
				throw new Error("http/fetch: formdata body must be an array of form parts");
			}
			out.body = value.body;
		} else {
			if (typeof value.body !== "string") {
				throw new Error("http/fetch: string/base64 body must be a string");
			}
			out.body = value.body;
		}
	}
	return out;
}

/**
 * Reverse the wrapper's marshalRequestInit() to reconstruct a real RequestInit
 * with proper Headers, binary bodies, and FormData.
 */
function unmarshalRequestInit(
	marshaled: MarshaledRequestInit | undefined,
): RequestInit | undefined {
	if (!marshaled) return undefined;
	const init: RequestInit = {};
	if (marshaled.method) init.method = marshaled.method;
	if (marshaled.redirect) init.redirect = marshaled.redirect;
	if (marshaled.headers && marshaled.headers.length > 0) {
		// Use a Headers instance and append() so duplicates are preserved
		// (e.g., multiple Set-Cookie). A plain Record would collapse them.
		const headers = new Headers();
		for (const [name, value] of marshaled.headers) {
			headers.append(name, value);
		}
		init.headers = headers;
	}
	if (marshaled.bodyType && marshaled.body !== undefined) {
		switch (marshaled.bodyType) {
			case "string":
				if (typeof marshaled.body !== "string") break;
				init.body = marshaled.body;
				break;
			case "base64":
				if (typeof marshaled.body !== "string") break;
				init.body = Buffer.from(marshaled.body, "base64");
				break;
			case "formdata": {
				if (!Array.isArray(marshaled.body)) break;
				const fd = new FormData();
				for (const part of marshaled.body) {
					if (part.isBlob) {
						const bytes = Buffer.from(part.value, "base64");
						const blob = new Blob([bytes], { type: part.type || "application/octet-stream" });
						fd.append(part.name, blob, part.filename);
					} else {
						fd.append(part.name, part.value);
					}
				}
				init.body = fd;
				break;
			}
		}
	}
	return init;
}

async function httpFetch(
	url: string,
	marshaledInit: unknown,
	opts: BridgeHandlerOptions,
): Promise<{
	status: number;
	statusText: string;
	headers: Record<string, string>;
	bodyBase64: string;
}> {
	const hasAnyFetch = opts.capabilities.includes("network:fetch:any");
	const httpAccess = hasAnyFetch
		? createUnrestrictedHttpAccess(opts.pluginId)
		: createHttpAccess(opts.pluginId, opts.allowedHosts || []);

	const init = unmarshalRequestInit(parseMarshaledRequestInit(marshaledInit));
	const res = await httpAccess.fetch(url, init);
	// Read as bytes to preserve binary content (images, audio, etc.)
	const bytes = new Uint8Array(await res.arrayBuffer());
	const headers: Record<string, string> = {};
	res.headers.forEach((v, k) => {
		headers[k] = v;
	});
	return {
		status: res.status,
		statusText: res.statusText,
		headers,
		bodyBase64: Buffer.from(bytes).toString("base64"),
	};
}

// ── User Operations ──────────────────────────────────────────────────────

function rowToUser(row: {
	id: string;
	email: string;
	name: string | null;
	role: number;
	created_at: string;
}) {
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
		.selectFrom("users")
		.where("id", "=", id)
		.select(["id", "email", "name", "role", "created_at"])
		.executeTakeFirst();
	if (!row) return null;
	return rowToUser(row);
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
		.selectFrom("users")
		.where("email", "=", email.toLowerCase())
		.select(["id", "email", "name", "role", "created_at"])
		.executeTakeFirst();
	if (!row) return null;
	return rowToUser(row);
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
		.selectFrom("users")
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
	const items = pageRows.map((row) => rowToUser(row));
	const hasMore = rows.length > limit;

	return {
		items,
		nextCursor: hasMore && items.length > 0 ? items.at(-1)!.id : undefined,
	};
}

// ── Storage Operations ───────────────────────────────────────────────────

/**
 * Construct a PluginStorageRepository for the requested collection.
 * Uses the indexes from the plugin's storage config (if provided) so
 * query/count operations support the same WHERE/ORDER BY clauses as
 * in-process plugins.
 */
function getStorageRepo(opts: BridgeHandlerOptions, collection: string): PluginStorageRepository {
	const config = opts.storageConfig?.[collection];
	// Merge unique indexes into the indexes list since both are queryable
	const allIndexes: Array<string | string[]> = [
		...(config?.indexes ?? []),
		...(config?.uniqueIndexes ?? []),
	];
	return new PluginStorageRepository(opts.db, opts.pluginId, collection, allIndexes);
}

async function storageGet(
	opts: BridgeHandlerOptions,
	collection: string,
	id: string,
): Promise<unknown> {
	return getStorageRepo(opts, collection).get(id);
}

async function storagePut(
	opts: BridgeHandlerOptions,
	collection: string,
	id: string,
	data: unknown,
): Promise<void> {
	await getStorageRepo(opts, collection).put(id, data);
}

async function storageDelete(
	opts: BridgeHandlerOptions,
	collection: string,
	id: string,
): Promise<boolean> {
	return getStorageRepo(opts, collection).delete(id);
}

async function storageQuery(
	opts: BridgeHandlerOptions,
	collection: string,
	queryOpts: Record<string, unknown>,
): Promise<{ items: Array<{ id: string; data: unknown }>; hasMore: boolean; cursor?: string }> {
	const repo = getStorageRepo(opts, collection);
	const where = optionalRecord(queryOpts, "where");
	const orderBy = requireOrderBy(queryOpts, "orderBy");
	const result = await repo.query({
		// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- repo.query accepts a generic WhereClause; we've validated `where` is a Record<string, unknown>.
		where: where as never,
		orderBy,
		limit:
			typeof queryOpts.limit === "number" ? Math.max(1, Math.min(queryOpts.limit, 100)) : undefined,
		cursor: typeof queryOpts.cursor === "string" ? queryOpts.cursor : undefined,
	});
	return {
		items: result.items,
		hasMore: result.hasMore,
		cursor: result.cursor,
	};
}

async function storageCount(
	opts: BridgeHandlerOptions,
	collection: string,
	where?: Record<string, unknown>,
): Promise<number> {
	const repo = getStorageRepo(opts, collection);
	// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- repo.count accepts a generic WhereClause; the caller validated `where` is a Record<string, unknown>.
	return repo.count(where as never);
}

async function storageGetMany(
	opts: BridgeHandlerOptions,
	collection: string,
	ids: string[],
): Promise<Array<[string, unknown]>> {
	if (!ids || ids.length === 0) return [];
	const repo = getStorageRepo(opts, collection);
	const result = await repo.getMany(ids);
	// Return as a list of [id, data] pairs rather than a plain object so
	// special property names like "__proto__" survive transport. The wrapper
	// reconstructs a Map from these entries.
	return [...result.entries()];
}

async function storagePutMany(
	opts: BridgeHandlerOptions,
	collection: string,
	items: Array<{ id: string; data: unknown }>,
): Promise<void> {
	if (!items || items.length === 0) return;
	await getStorageRepo(opts, collection).putMany(items);
}

async function storageDeleteMany(
	opts: BridgeHandlerOptions,
	collection: string,
	ids: string[],
): Promise<number> {
	if (!ids || ids.length === 0) return 0;
	return getStorageRepo(opts, collection).deleteMany(ids);
}
