/**
 * Backing Service HTTP Handler
 *
 * Runs in the Node process. Receives HTTP requests from plugin workers
 * running in workerd isolates. Each request is authenticated via a
 * per-plugin auth token and capabilities are enforced server-side.
 *
 * This is the Node equivalent of the Cloudflare PluginBridge
 * WorkerEntrypoint (packages/cloudflare/src/sandbox/bridge.ts).
 */

import type { IncomingMessage, ServerResponse } from "node:http";

// @ts-ignore -- these are value exports used at runtime
import { createHttpAccess, createUnrestrictedHttpAccess } from "emdash";

import type { WorkerdSandboxRunner } from "./runner.js";

/**
 * Create an HTTP request handler for the backing service.
 *
 * The handler validates auth tokens and dispatches to the appropriate
 * bridge method. Capability enforcement happens here, not in the plugin.
 */
export function createBackingServiceHandler(
	runner: WorkerdSandboxRunner,
): (req: IncomingMessage, res: ServerResponse) => void {
	return async (req, res) => {
		try {
			// Parse auth token from Authorization header
			const authHeader = req.headers.authorization;
			if (!authHeader?.startsWith("Bearer ")) {
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Missing or invalid authorization" }));
				return;
			}

			const token = authHeader.slice(7);
			const claims = runner.validateToken(token);
			if (!claims) {
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Invalid auth token" }));
				return;
			}

			// Parse request body
			const body = await readBody(req);
			const method = req.url?.slice(1) || ""; // Remove leading /

			// Dispatch to appropriate handler
			const result = await dispatch(runner, method, body, claims);

			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ result }));
		} catch (error) {
			const message = error instanceof Error ? error.message : "Internal error";
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: message }));
		}
	};
}

interface Claims {
	pluginId: string;
	version: string;
	capabilities: string[];
	allowedHosts: string[];
	storageCollections: string[];
}

/**
 * Dispatch a bridge call to the appropriate handler.
 *
 * Each method checks capabilities before executing.
 */
async function dispatch(
	runner: WorkerdSandboxRunner,
	method: string,
	body: Record<string, unknown>,
	claims: Claims,
): Promise<unknown> {
	const db = runner.db;

	switch (method) {
		// ── KV operations ──────────────────────────────────────────────────
		case "kv/get": {
			const key = requireString(body, "key");
			return kvGet(db, claims.pluginId, key);
		}
		case "kv/set": {
			const key = requireString(body, "key");
			return kvSet(db, claims.pluginId, key, body.value);
		}
		case "kv/delete": {
			const key = requireString(body, "key");
			return kvDelete(db, claims.pluginId, key);
		}
		case "kv/list": {
			const prefix = body.prefix as string | undefined;
			return kvList(db, claims.pluginId, prefix);
		}

		// ── Content operations ─────────────────────────────────────────────
		case "content/get": {
			requireCapability(claims, "read:content");
			const collection = requireString(body, "collection");
			const id = requireString(body, "id");
			return contentGet(db, collection, id);
		}
		case "content/list": {
			requireCapability(claims, "read:content");
			const collection = requireString(body, "collection");
			return contentList(db, collection, body);
		}
		case "content/create": {
			requireCapability(claims, "write:content");
			const collection = requireString(body, "collection");
			return contentCreate(db, collection, body.data as Record<string, unknown>);
		}
		case "content/update": {
			requireCapability(claims, "write:content");
			const collection = requireString(body, "collection");
			const id = requireString(body, "id");
			return contentUpdate(db, collection, id, body.data as Record<string, unknown>);
		}
		case "content/delete": {
			requireCapability(claims, "write:content");
			const collection = requireString(body, "collection");
			const id = requireString(body, "id");
			return contentDelete(db, collection, id);
		}

		// ── Media operations ───────────────────────────────────────────────
		case "media/get": {
			requireCapability(claims, "read:media");
			const id = requireString(body, "id");
			return mediaGet(db, id);
		}
		case "media/list": {
			requireCapability(claims, "read:media");
			return mediaList(db, body);
		}
		case "media/upload": {
			requireCapability(claims, "write:media");
			// TODO: Implement media upload via Storage interface
			throw new Error("media/upload not yet implemented");
		}
		case "media/delete": {
			requireCapability(claims, "write:media");
			const id = requireString(body, "id");
			return mediaDelete(db, id);
		}

		// ── HTTP fetch ─────────────────────────────────────────────────────
		case "http/fetch": {
			requireCapability(claims, "network:fetch");
			const url = requireString(body, "url");
			return httpFetch(url, body.init as RequestInit | undefined, claims);
		}

		// ── Email ──────────────────────────────────────────────────────────
		case "email/send": {
			requireCapability(claims, "email:send");
			const message = body.message as { to: string; subject: string; text: string; html?: string };
			if (!message?.to || !message?.subject || !message?.text) {
				throw new Error("email/send requires message with to, subject, and text");
			}
			const emailSend = runner.emailSend;
			if (!emailSend) {
				throw new Error("Email sending is not configured");
			}
			await emailSend(message, claims.pluginId);
			return null;
		}

		// ── Users ──────────────────────────────────────────────────────────
		case "users/get": {
			requireCapability(claims, "read:users");
			const id = requireString(body, "id");
			return userGet(db, id);
		}
		case "users/getByEmail": {
			requireCapability(claims, "read:users");
			const email = requireString(body, "email");
			return userGetByEmail(db, email);
		}
		case "users/list": {
			requireCapability(claims, "read:users");
			return userList(db, body);
		}

		// ── Storage (document store) ───────────────────────────────────────
		case "storage/get": {
			const collection = requireString(body, "collection");
			validateStorageCollection(claims, collection);
			return storageGet(db, claims.pluginId, collection, requireString(body, "id"));
		}
		case "storage/put": {
			const collection = requireString(body, "collection");
			validateStorageCollection(claims, collection);
			return storagePut(db, claims.pluginId, collection, requireString(body, "id"), body.data);
		}
		case "storage/delete": {
			const collection = requireString(body, "collection");
			validateStorageCollection(claims, collection);
			return storageDelete(db, claims.pluginId, collection, requireString(body, "id"));
		}
		case "storage/query": {
			const collection = requireString(body, "collection");
			validateStorageCollection(claims, collection);
			return storageQuery(db, claims.pluginId, collection, body);
		}

		// ── Logging ────────────────────────────────────────────────────────
		case "log": {
			const level = requireString(body, "level") as "debug" | "info" | "warn" | "error";
			const msg = requireString(body, "msg");
			console[level](`[plugin:${claims.pluginId}]`, msg, body.data ?? "");
			return null;
		}

		default:
			throw new Error(`Unknown bridge method: ${method}`);
	}
}

// ── Validation helpers ───────────────────────────────────────────────────

function requireString(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value !== "string") {
		throw new Error(`Missing required string parameter: ${key}`);
	}
	return value;
}

function requireCapability(claims: Claims, capability: string): void {
	// write implies read
	if (capability === "read:content" && claims.capabilities.includes("write:content")) return;
	if (capability === "read:media" && claims.capabilities.includes("write:media")) return;

	if (!claims.capabilities.includes(capability)) {
		throw new Error(`Plugin ${claims.pluginId} does not have capability: ${capability}`);
	}
}

function validateStorageCollection(claims: Claims, collection: string): void {
	if (!claims.storageCollections.includes(collection)) {
		throw new Error(`Plugin ${claims.pluginId} does not declare storage collection: ${collection}`);
	}
}

// ── Bridge implementations ───────────────────────────────────────────────
// These are thin wrappers around Kysely queries, matching the PluginBridge
// interface from @emdash-cms/cloudflare/src/sandbox/bridge.ts.
//
// TODO: Import and use the actual repository classes from emdash core
// once the package dependency is properly wired up. For now, these are
// placeholder implementations that establish the correct API shape.

import type { Database } from "emdash";
import type { Kysely } from "kysely";

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

// Content, media, user, storage operations are placeholders.
// They will use the actual repository classes from emdash core.

async function contentGet(db: Kysely<Database>, collection: string, id: string): Promise<unknown> {
	// TODO: Use ContentRepository from emdash core
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
	// TODO: Use ContentRepository
	throw new Error("content/create not yet implemented");
}

async function contentUpdate(
	_db: Kysely<Database>,
	_collection: string,
	_id: string,
	_data: Record<string, unknown>,
): Promise<unknown> {
	// TODO: Use ContentRepository
	throw new Error("content/update not yet implemented");
}

async function contentDelete(
	_db: Kysely<Database>,
	_collection: string,
	_id: string,
): Promise<unknown> {
	// TODO: Use ContentRepository
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

async function mediaDelete(_db: Kysely<Database>, _id: string): Promise<unknown> {
	// TODO: Use MediaRepository
	throw new Error("media/delete not yet implemented");
}

async function httpFetch(
	url: string,
	init: RequestInit | undefined,
	claims: Claims,
): Promise<unknown> {
	// Use the same HTTP access implementation as in-process plugins.
	// This ensures identical behavior for redirect validation, SSRF protection,
	// and credential stripping across Cloudflare, workerd, and in-process runners.
	const hasAnyFetch = claims.capabilities.includes("network:fetch:any");
	const httpAccess = hasAnyFetch
		? createUnrestrictedHttpAccess(claims.pluginId)
		: createHttpAccess(claims.pluginId, claims.allowedHosts || []);

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

// ── Body parsing ─────────────────────────────────────────────────────────

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(chunk as Buffer);
	}
	const raw = Buffer.concat(chunks).toString();
	return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}
