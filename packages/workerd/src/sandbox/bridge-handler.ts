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
 */

// @ts-ignore -- value exports used at runtime
import { createHttpAccess, createUnrestrictedHttpAccess } from "emdash";
import type { Database } from "emdash";
import type { SandboxEmailSendCallback } from "emdash";
import type { Kysely } from "kysely";

interface BridgeHandlerOptions {
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
			// Strip leading slash and hostname to get the method
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
		// ── KV ──────────────────────────────────────────────────────────
		case "kv/get":
			return kvGet(db, pluginId, requireString(body, "key"));
		case "kv/set":
			return kvSet(db, pluginId, requireString(body, "key"), body.value);
		case "kv/delete":
			return kvDelete(db, pluginId, requireString(body, "key"));
		case "kv/list":
			return kvList(db, pluginId, body.prefix as string | undefined);

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

		// ── HTTP ────────────────────────────────────────────────────────
		case "http/fetch":
			requireCapability(opts, "network:fetch");
			return httpFetch(requireString(body, "url"), body.init as RequestInit | undefined, opts);

		// ── Email ───────────────────────────────────────────────────────
		case "email/send": {
			requireCapability(opts, "email:send");
			const message = body.message as { to: string; subject: string; text: string; html?: string };
			if (!message?.to || !message?.subject || !message?.text) {
				throw new Error("email/send requires message with to, subject, and text");
			}
			const emailSend = opts.emailSend();
			if (!emailSend) throw new Error("Email sending is not configured");
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

		// ── Storage ─────────────────────────────────────────────────────
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

// ── Bridge implementations ───────────────────────────────────────────────
// Thin wrappers around Kysely queries matching the PluginBridge interface.
// TODO: Use actual repository classes from emdash core once wired up.

async function kvGet(db: Kysely<Database>, pluginId: string, key: string): Promise<unknown> {
	const row = await db
		.selectFrom("_emdash_options")
		.where("key", "=", `plugin:${pluginId}:${key}`)
		.select("value")
		.executeTakeFirst();
	if (!row) return null;
	try {
		return JSON.parse(row.value);
	} catch {
		return row.value;
	}
}

async function kvSet(
	db: Kysely<Database>,
	pluginId: string,
	key: string,
	value: unknown,
): Promise<void> {
	const serialized = JSON.stringify(value);
	await db
		.insertInto("_emdash_options")
		.values({ key: `plugin:${pluginId}:${key}`, value: serialized })
		.onConflict((oc) => oc.column("key").doUpdateSet({ value: serialized }))
		.execute();
}

async function kvDelete(db: Kysely<Database>, pluginId: string, key: string): Promise<void> {
	await db.deleteFrom("_emdash_options").where("key", "=", `plugin:${pluginId}:${key}`).execute();
}

async function kvList(db: Kysely<Database>, pluginId: string, prefix?: string): Promise<string[]> {
	const fullPrefix = `plugin:${pluginId}:${prefix || ""}`;
	const rows = await db
		.selectFrom("_emdash_options")
		.where("key", "like", `${fullPrefix}%`)
		.select("key")
		.execute();
	const prefixLen = `plugin:${pluginId}:`.length;
	return rows.map((r) => r.key.slice(prefixLen));
}

async function contentGet(db: Kysely<Database>, collection: string, id: string): Promise<unknown> {
	const tableName = `ec_${collection}`;
	const row = await db
		.selectFrom(tableName as keyof Database)
		.where("id", "=", id)
		.where("deleted_at", "is", null)
		.selectAll()
		.executeTakeFirst();
	return row ?? null;
}

async function contentList(
	db: Kysely<Database>,
	collection: string,
	opts: Record<string, unknown>,
): Promise<unknown> {
	const tableName = `ec_${collection}`;
	const limit = Math.min(Number(opts.limit) || 50, 100);
	const rows = await db
		.selectFrom(tableName as keyof Database)
		.where("deleted_at", "is", null)
		.selectAll()
		.limit(limit)
		.execute();
	return { items: rows, nextCursor: null };
}

async function contentCreate(
	_db: Kysely<Database>,
	_collection: string,
	_data: Record<string, unknown>,
): Promise<unknown> {
	throw new Error("content/create not yet implemented");
}

async function contentUpdate(
	_db: Kysely<Database>,
	_collection: string,
	_id: string,
	_data: Record<string, unknown>,
): Promise<unknown> {
	throw new Error("content/update not yet implemented");
}

async function contentDelete(
	_db: Kysely<Database>,
	_collection: string,
	_id: string,
): Promise<unknown> {
	throw new Error("content/delete not yet implemented");
}

async function mediaGet(db: Kysely<Database>, id: string): Promise<unknown> {
	const row = await db
		.selectFrom("_emdash_media" as keyof Database)
		.where("id", "=", id)
		.selectAll()
		.executeTakeFirst();
	return row ?? null;
}

async function mediaList(db: Kysely<Database>, opts: Record<string, unknown>): Promise<unknown> {
	const limit = Math.min(Number(opts.limit) || 50, 100);
	const rows = await db
		.selectFrom("_emdash_media" as keyof Database)
		.selectAll()
		.limit(limit)
		.execute();
	return { items: rows, nextCursor: null };
}

async function httpFetch(
	url: string,
	init: RequestInit | undefined,
	opts: BridgeHandlerOptions,
): Promise<unknown> {
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

async function userGet(db: Kysely<Database>, id: string): Promise<unknown> {
	const row = await db
		.selectFrom("_emdash_users" as keyof Database)
		.where("id", "=", id)
		.select(["id", "email", "name", "role", "created_at"])
		.executeTakeFirst();
	return row ?? null;
}

async function userGetByEmail(db: Kysely<Database>, email: string): Promise<unknown> {
	const row = await db
		.selectFrom("_emdash_users" as keyof Database)
		.where("email", "=", email)
		.select(["id", "email", "name", "role", "created_at"])
		.executeTakeFirst();
	return row ?? null;
}

async function userList(db: Kysely<Database>, opts: Record<string, unknown>): Promise<unknown> {
	const limit = Math.min(Number(opts.limit) || 50, 100);
	let query = db
		.selectFrom("_emdash_users" as keyof Database)
		.select(["id", "email", "name", "role", "created_at"])
		.limit(limit);
	if (opts.role !== undefined) {
		query = query.where("role", "=", Number(opts.role));
	}
	const rows = await query.execute();
	return { items: rows, nextCursor: null };
}

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
	try {
		return JSON.parse(row.data as string);
	} catch {
		return row.data;
	}
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
): Promise<void> {
	await db
		.deleteFrom("_plugin_storage" as keyof Database)
		.where("plugin_id", "=", pluginId)
		.where("collection", "=", collection)
		.where("id", "=", id)
		.execute();
}

async function storageQuery(
	db: Kysely<Database>,
	pluginId: string,
	collection: string,
	opts: Record<string, unknown>,
): Promise<unknown> {
	const limit = Math.min(Number(opts.limit) || 50, 1000);
	const rows = await db
		.selectFrom("_plugin_storage" as keyof Database)
		.where("plugin_id", "=", pluginId)
		.where("collection", "=", collection)
		.select(["id", "data"])
		.limit(limit)
		.execute();

	const items = rows.map((r) => ({
		id: r.id,
		data: (() => {
			try {
				return JSON.parse(r.data as string);
			} catch {
				return r.data;
			}
		})(),
	}));

	return { items, nextCursor: null };
}
