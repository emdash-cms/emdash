/**
 * PluginBridge WorkerEntrypoint
 *
 * Provides controlled access to database operations for sandboxed plugins.
 * The sandbox gets a SERVICE BINDING to this entrypoint, not direct DB access.
 * All operations are validated and scoped to the plugin.
 *
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import type { SandboxEmailSendCallback } from "emdash";
import { ulid } from "emdash";

/** Regex to validate collection names (prevent SQL injection) */
const COLLECTION_NAME_REGEX = /^[a-z][a-z0-9_]*$/;

/** Regex to validate file extensions (simple alphanumeric, 1-10 chars) */
const FILE_EXT_REGEX = /^\.[a-z0-9]{1,10}$/i;

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

/**
 * Module-level email send callback.
 *
 * The bridge runs in the host process (same worker), so we can use a
 * module-level callback that the runner sets before creating bridge bindings.
 * This avoids the need to pass non-serializable functions through props.
 *
 * @see runner.ts setEmailSendCallback()
 */
let emailSendCallback: SandboxEmailSendCallback | null = null;

/**
 * Set the email send callback for all bridge instances.
 * Called by the runner when the EmailPipeline is available.
 */
export function setEmailSendCallback(callback: SandboxEmailSendCallback | null): void {
	emailSendCallback = callback;
}

/**
 * Serialize a value for D1 storage.
 * Mirrors core's serializeValue: objects/arrays → JSON strings,
 * booleans → 0/1, null/undefined → null, everything else passthrough.
 */
function serializeValue(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (typeof value === "object") return JSON.stringify(value);
	return value;
}

/**
 * Deserialize a row from D1 into a content response shape.
 * Extracts system columns and bundles remaining columns into data.
 */
/**
 * Deserialize a row from D1 into a ContentItem matching core's plugin API.
 * Extracts system columns, deserializes JSON fields, and returns the
 * canonical shape: { id, type, data, createdAt, updatedAt }.
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
			// Attempt to parse JSON strings back to objects
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

/**
 * Environment bindings required by PluginBridge
 */
export interface PluginBridgeEnv {
	DB: D1Database;
	MEDIA?: R2Bucket;
}

/**
 * Props passed to the bridge via ctx.props when creating the loopback binding
 */
export interface PluginBridgeProps {
	pluginId: string;
	pluginVersion: string;
	capabilities: string[];
	allowedHosts: string[];
	storageCollections: string[];
}

/**
 * PluginBridge WorkerEntrypoint
 *
 * Provides the context API to sandboxed plugins via RPC.
 * All methods validate capabilities and scope operations to the plugin.
 *
 * Usage:
 * 1. Export this class from your worker entrypoint
 * 2. Sandboxed plugins get a binding to it via ctx.exports.PluginBridge({...})
 * 3. Plugins call bridge methods which validate and proxy to the database
 */
export class PluginBridge extends WorkerEntrypoint<PluginBridgeEnv, PluginBridgeProps> {
	// =========================================================================
	// KV Operations - scoped to plugin namespace
	// =========================================================================

	/**
	 * KV operations use _plugin_storage with a special "__kv" collection.
	 * This provides consistent storage across sandboxed and non-sandboxed modes.
	 */
	async kvGet(key: string): Promise<unknown> {
		const { pluginId } = this.ctx.props;
		const result = await this.env.DB.prepare(
			"SELECT data FROM _plugin_storage WHERE plugin_id = ? AND collection = '__kv' AND id = ?",
		)
			.bind(pluginId, key)
			.first<{ data: string }>();
		if (!result) return null;
		try {
			return JSON.parse(result.data);
		} catch {
			return result.data;
		}
	}

	async kvSet(key: string, value: unknown): Promise<void> {
		const { pluginId } = this.ctx.props;
		await this.env.DB.prepare(
			"INSERT OR REPLACE INTO _plugin_storage (plugin_id, collection, id, data, updated_at) VALUES (?, '__kv', ?, ?, datetime('now'))",
		)
			.bind(pluginId, key, JSON.stringify(value))
			.run();
	}

	async kvDelete(key: string): Promise<boolean> {
		const { pluginId } = this.ctx.props;
		const result = await this.env.DB.prepare(
			"DELETE FROM _plugin_storage WHERE plugin_id = ? AND collection = '__kv' AND id = ?",
		)
			.bind(pluginId, key)
			.run();
		return (result.meta?.changes ?? 0) > 0;
	}

	async kvList(prefix: string = ""): Promise<Array<{ key: string; value: unknown }>> {
		const { pluginId } = this.ctx.props;
		const results = await this.env.DB.prepare(
			"SELECT id, data FROM _plugin_storage WHERE plugin_id = ? AND collection = '__kv' AND id LIKE ?",
		)
			.bind(pluginId, prefix + "%")
			.all<{ id: string; data: string }>();

		return (results.results ?? []).map((row) => ({
			key: row.id,
			value: JSON.parse(row.data),
		}));
	}

	// =========================================================================
	// Storage Operations - scoped to plugin + collection validation
	// =========================================================================

	async storageGet(collection: string, id: string): Promise<unknown> {
		const { pluginId, storageCollections } = this.ctx.props;
		if (!storageCollections.includes(collection)) {
			throw new Error(`Storage collection not declared: ${collection}`);
		}
		const result = await this.env.DB.prepare(
			"SELECT data FROM _plugin_storage WHERE plugin_id = ? AND collection = ? AND id = ?",
		)
			.bind(pluginId, collection, id)
			.first<{ data: string }>();
		if (!result) return null;
		return JSON.parse(result.data);
	}

	async storagePut(collection: string, id: string, data: unknown): Promise<void> {
		const { pluginId, storageCollections } = this.ctx.props;
		if (!storageCollections.includes(collection)) {
			throw new Error(`Storage collection not declared: ${collection}`);
		}
		await this.env.DB.prepare(
			"INSERT OR REPLACE INTO _plugin_storage (plugin_id, collection, id, data, updated_at) VALUES (?, ?, ?, ?, datetime('now'))",
		)
			.bind(pluginId, collection, id, JSON.stringify(data))
			.run();
	}

	async storageDelete(collection: string, id: string): Promise<boolean> {
		const { pluginId, storageCollections } = this.ctx.props;
		if (!storageCollections.includes(collection)) {
			throw new Error(`Storage collection not declared: ${collection}`);
		}
		const result = await this.env.DB.prepare(
			"DELETE FROM _plugin_storage WHERE plugin_id = ? AND collection = ? AND id = ?",
		)
			.bind(pluginId, collection, id)
			.run();
		return (result.meta?.changes ?? 0) > 0;
	}

	async storageQuery(
		collection: string,
		opts: { limit?: number; cursor?: string } = {},
	): Promise<{
		items: Array<{ id: string; data: unknown }>;
		hasMore: boolean;
		cursor?: string;
	}> {
		const { pluginId, storageCollections } = this.ctx.props;
		if (!storageCollections.includes(collection)) {
			throw new Error(`Storage collection not declared: ${collection}`);
		}
		const limit = Math.min(opts.limit ?? 50, 1000);
		const results = await this.env.DB.prepare(
			"SELECT id, data FROM _plugin_storage WHERE plugin_id = ? AND collection = ? LIMIT ?",
		)
			.bind(pluginId, collection, limit + 1)
			.all<{ id: string; data: string }>();

		const items = (results.results ?? []).slice(0, limit).map((row) => ({
			id: row.id,
			data: JSON.parse(row.data),
		}));
		return {
			items,
			hasMore: (results.results ?? []).length > limit,
			cursor: items.length > 0 ? items.at(-1)!.id : undefined,
		};
	}

	async storageCount(collection: string): Promise<number> {
		const { pluginId, storageCollections } = this.ctx.props;
		if (!storageCollections.includes(collection)) {
			throw new Error(`Storage collection not declared: ${collection}`);
		}
		const result = await this.env.DB.prepare(
			"SELECT COUNT(*) as count FROM _plugin_storage WHERE plugin_id = ? AND collection = ?",
		)
			.bind(pluginId, collection)
			.first<{ count: number }>();
		return result?.count ?? 0;
	}

	async storageGetMany(collection: string, ids: string[]): Promise<Map<string, unknown>> {
		const { pluginId, storageCollections } = this.ctx.props;
		if (!storageCollections.includes(collection)) {
			throw new Error(`Storage collection not declared: ${collection}`);
		}
		if (ids.length === 0) return new Map();

		const placeholders = ids.map(() => "?").join(",");
		const results = await this.env.DB.prepare(
			`SELECT id, data FROM _plugin_storage WHERE plugin_id = ? AND collection = ? AND id IN (${placeholders})`,
		)
			.bind(pluginId, collection, ...ids)
			.all<{ id: string; data: string }>();

		const map = new Map<string, unknown>();
		for (const row of results.results ?? []) {
			map.set(row.id, JSON.parse(row.data));
		}
		return map;
	}

	async storagePutMany(
		collection: string,
		items: Array<{ id: string; data: unknown }>,
	): Promise<void> {
		const { pluginId, storageCollections } = this.ctx.props;
		if (!storageCollections.includes(collection)) {
			throw new Error(`Storage collection not declared: ${collection}`);
		}
		if (items.length === 0) return;

		// D1 doesn't support batch in prepare, so we do individual inserts
		// In future, we could use batch API
		for (const item of items) {
			await this.env.DB.prepare(
				"INSERT OR REPLACE INTO _plugin_storage (plugin_id, collection, id, data, updated_at) VALUES (?, ?, ?, ?, datetime('now'))",
			)
				.bind(pluginId, collection, item.id, JSON.stringify(item.data))
				.run();
		}
	}

	async storageDeleteMany(collection: string, ids: string[]): Promise<number> {
		const { pluginId, storageCollections } = this.ctx.props;
		if (!storageCollections.includes(collection)) {
			throw new Error(`Storage collection not declared: ${collection}`);
		}
		if (ids.length === 0) return 0;

		let deleted = 0;
		for (const id of ids) {
			const result = await this.env.DB.prepare(
				"DELETE FROM _plugin_storage WHERE plugin_id = ? AND collection = ? AND id = ?",
			)
				.bind(pluginId, collection, id)
				.run();
			deleted += result.meta?.changes ?? 0;
		}
		return deleted;
	}

	// =========================================================================
	// Content Operations - capability-gated
	// =========================================================================

	async contentGet(
		collection: string,
		id: string,
	): Promise<{
		id: string;
		type: string;
		data: Record<string, unknown>;
		createdAt: string;
		updatedAt: string;
	} | null> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("read:content")) {
			throw new Error("Missing capability: read:content");
		}
		// Validate collection name to prevent SQL injection
		if (!COLLECTION_NAME_REGEX.test(collection)) {
			throw new Error(`Invalid collection name: ${collection}`);
		}
		try {
			// Content tables use ec_${collection} naming (no leading underscore)
			// Exclude soft-deleted items
			const result = await this.env.DB.prepare(
				`SELECT * FROM ec_${collection} WHERE id = ? AND deleted_at IS NULL`,
			)
				.bind(id)
				.first();
			if (!result) return null;
			return rowToContentItem(collection, result);
		} catch {
			return null;
		}
	}

	async contentList(
		collection: string,
		opts: { limit?: number; cursor?: string } = {},
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
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("read:content")) {
			throw new Error("Missing capability: read:content");
		}
		// Validate collection name to prevent SQL injection
		if (!COLLECTION_NAME_REGEX.test(collection)) {
			throw new Error(`Invalid collection name: ${collection}`);
		}
		const limit = Math.min(opts.limit ?? 50, 100);
		try {
			// Content tables use ec_${collection} naming (no leading underscore)
			// Exclude soft-deleted items. Ordered by ULID (id DESC) for deterministic
			// cursor pagination. ULIDs are time-sortable so this approximates created_at DESC.
			let sql = `SELECT * FROM ec_${collection} WHERE deleted_at IS NULL`;
			const params: unknown[] = [];

			if (opts.cursor) {
				sql += " AND id < ?";
				params.push(opts.cursor);
			}

			sql += " ORDER BY id DESC LIMIT ?";
			params.push(limit + 1);

			const results = await this.env.DB.prepare(sql)
				.bind(...params)
				.all();

			const rows = results.results ?? [];
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

	async contentCreate(
		collection: string,
		data: Record<string, unknown>,
	): Promise<{
		id: string;
		type: string;
		data: Record<string, unknown>;
		createdAt: string;
		updatedAt: string;
	}> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("write:content")) {
			throw new Error("Missing capability: write:content");
		}
		if (!COLLECTION_NAME_REGEX.test(collection)) {
			throw new Error(`Invalid collection name: ${collection}`);
		}

		const id = ulid();
		const now = new Date().toISOString();

		// Build columns and values arrays — quote identifiers to avoid SQL keyword collisions
		const columns: string[] = [
			'"id"',
			'"slug"',
			'"status"',
			'"author_id"',
			'"created_at"',
			'"updated_at"',
			'"version"',
		];
		const values: unknown[] = [
			id,
			typeof data.slug === "string" ? data.slug : null,
			typeof data.status === "string" ? data.status : "draft",
			typeof data.author_id === "string" ? data.author_id : null,
			now,
			now,
			1,
		];

		// Append user data fields (skip system columns, quote identifiers)
		for (const [key, value] of Object.entries(data)) {
			if (!SYSTEM_COLUMNS.has(key) && COLLECTION_NAME_REGEX.test(key)) {
				columns.push(`"${key}"`);
				values.push(serializeValue(value));
			}
		}

		const placeholders = columns.map(() => "?").join(", ");
		const columnList = columns.join(", ");

		await this.env.DB.prepare(
			`INSERT INTO ec_${collection} (${columnList}) VALUES (${placeholders})`,
		)
			.bind(...values)
			.run();

		// Re-read the created row
		const created = await this.env.DB.prepare(
			`SELECT * FROM ec_${collection} WHERE id = ? AND deleted_at IS NULL`,
		)
			.bind(id)
			.first();

		if (!created) {
			return { id, type: collection, data: {}, createdAt: now, updatedAt: now };
		}
		return rowToContentItem(collection, created);
	}

	async contentUpdate(
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
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("write:content")) {
			throw new Error("Missing capability: write:content");
		}
		if (!COLLECTION_NAME_REGEX.test(collection)) {
			throw new Error(`Invalid collection name: ${collection}`);
		}

		const now = new Date().toISOString();
		// Quote identifiers to avoid SQL keyword collisions
		const setClauses: string[] = ['"updated_at" = ?', '"version" = "version" + 1'];
		const values: unknown[] = [now];

		// System field updates (only if provided)
		if (typeof data.status === "string") {
			setClauses.push('"status" = ?');
			values.push(data.status);
		}
		if (data.slug !== undefined) {
			setClauses.push('"slug" = ?');
			values.push(typeof data.slug === "string" ? data.slug : null);
		}

		// User data fields (quote identifiers)
		for (const [key, value] of Object.entries(data)) {
			if (!SYSTEM_COLUMNS.has(key) && COLLECTION_NAME_REGEX.test(key)) {
				setClauses.push(`"${key}" = ?`);
				values.push(serializeValue(value));
			}
		}

		// WHERE clause: match by id and not soft-deleted
		values.push(id);

		const result = await this.env.DB.prepare(
			`UPDATE ec_${collection} SET ${setClauses.join(", ")} WHERE "id" = ? AND "deleted_at" IS NULL`,
		)
			.bind(...values)
			.run();

		if ((result.meta?.changes ?? 0) === 0) {
			throw new Error(`Content not found or deleted: ${collection}/${id}`);
		}

		// Re-read the updated row (with soft-delete guard)
		const updated = await this.env.DB.prepare(
			`SELECT * FROM ec_${collection} WHERE id = ? AND deleted_at IS NULL`,
		)
			.bind(id)
			.first();

		if (!updated) {
			throw new Error(`Content not found: ${collection}/${id}`);
		}
		return rowToContentItem(collection, updated);
	}

	async contentDelete(collection: string, id: string): Promise<boolean> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("write:content")) {
			throw new Error("Missing capability: write:content");
		}
		if (!COLLECTION_NAME_REGEX.test(collection)) {
			throw new Error(`Invalid collection name: ${collection}`);
		}

		// Soft-delete: set deleted_at timestamp
		const now = new Date().toISOString();
		const result = await this.env.DB.prepare(
			`UPDATE ec_${collection} SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
		)
			.bind(now, now, id)
			.run();
		return (result.meta?.changes ?? 0) > 0;
	}

	// =========================================================================
	// Media Operations - capability-gated
	// =========================================================================

	async mediaGet(id: string): Promise<{
		id: string;
		filename: string;
		mimeType: string;
		size: number | null;
		url: string;
		createdAt: string;
	} | null> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("read:media")) {
			throw new Error("Missing capability: read:media");
		}
		const result = await this.env.DB.prepare("SELECT * FROM media WHERE id = ?").bind(id).first<{
			id: string;
			filename: string;
			mime_type: string;
			size: number | null;
			storage_key: string;
			created_at: string;
		}>();
		if (!result) return null;
		return {
			id: result.id,
			filename: result.filename,
			mimeType: result.mime_type,
			size: result.size,
			url: `/_emdash/api/media/file/${result.storage_key}`,
			createdAt: result.created_at,
		};
	}

	async mediaList(opts: { limit?: number; cursor?: string; mimeType?: string } = {}): Promise<{
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
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("read:media")) {
			throw new Error("Missing capability: read:media");
		}
		const limit = Math.min(opts.limit ?? 50, 100);
		// Only return ready items (matching core's MediaRepository.findMany default)
		let sql = "SELECT * FROM media WHERE status = 'ready'";
		const params: unknown[] = [];

		if (opts.mimeType) {
			sql += " AND mime_type LIKE ?";
			params.push(opts.mimeType + "%");
		}

		if (opts.cursor) {
			sql += " AND id < ?";
			params.push(opts.cursor);
		}

		sql += " ORDER BY id DESC LIMIT ?";
		params.push(limit + 1);

		const results = await this.env.DB.prepare(sql)
			.bind(...params)
			.all<{
				id: string;
				filename: string;
				mime_type: string;
				size: number | null;
				storage_key: string;
				created_at: string;
			}>();

		const rows = results.results ?? [];
		const pageRows = rows.slice(0, limit);
		const items = pageRows.map((row) => ({
			id: row.id,
			filename: row.filename,
			mimeType: row.mime_type,
			size: row.size,
			url: `/_emdash/api/media/file/${row.storage_key}`,
			createdAt: row.created_at,
		}));
		const hasMore = rows.length > limit;

		return {
			items,
			cursor: hasMore && items.length > 0 ? items.at(-1)!.id : undefined,
			hasMore,
		};
	}

	/**
	 * Create a pending media record and write bytes directly to R2.
	 *
	 * Unlike the admin UI flow (presigned URL → client PUT → confirm), sandboxed
	 * plugins are network-isolated and can't make external requests. The bridge
	 * accepts the file bytes directly and writes them to storage.
	 *
	 * Returns the media ID, storage key, and confirm URL. The plugin should
	 * call the confirm endpoint after this to finalize the record.
	 */
	async mediaUpload(
		filename: string,
		contentType: string,
		bytes: ArrayBuffer,
	): Promise<{ mediaId: string; storageKey: string; url: string }> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("write:media")) {
			throw new Error("Missing capability: write:media");
		}

		if (!this.env.MEDIA) {
			throw new Error("Media storage (R2) not configured. Add MEDIA binding to wrangler config.");
		}

		// Validate MIME type — only allow image, video, audio, and PDF
		const ALLOWED_MIME_PREFIXES = ["image/", "video/", "audio/", "application/pdf"];
		if (!ALLOWED_MIME_PREFIXES.some((prefix) => contentType.startsWith(prefix))) {
			throw new Error(
				`Unsupported content type: ${contentType}. Allowed: image/*, video/*, audio/*, application/pdf`,
			);
		}

		const mediaId = ulid();
		// Derive extension from basename only, validate it's a simple extension
		const basename = filename.includes("/")
			? filename.slice(filename.lastIndexOf("/") + 1)
			: filename;
		const rawExt = basename.includes(".") ? basename.slice(basename.lastIndexOf(".")) : "";
		const ext = FILE_EXT_REGEX.test(rawExt) ? rawExt : "";
		// Flat storage key matching core convention: ${ulid}${ext}
		const storageKey = `${mediaId}${ext}`;
		const now = new Date().toISOString();

		// Write bytes to R2 first, then create DB record.
		// If DB insert fails, clean up the R2 object to prevent orphans.
		await this.env.MEDIA.put(storageKey, bytes, {
			httpMetadata: { contentType },
		});

		try {
			// Create confirmed media record with ISO timestamp (matching core)
			await this.env.DB.prepare(
				"INSERT INTO media (id, filename, mime_type, size, storage_key, status, created_at) VALUES (?, ?, ?, ?, ?, 'ready', ?)",
			)
				.bind(mediaId, filename, contentType, bytes.byteLength, storageKey, now)
				.run();
		} catch (error) {
			// Clean up R2 object on DB failure to prevent orphans
			try {
				await this.env.MEDIA.delete(storageKey);
			} catch {
				// Best-effort cleanup — log and continue
				console.warn(`[plugin-bridge] Failed to clean up orphaned R2 object: ${storageKey}`);
			}
			throw error;
		}

		return {
			mediaId,
			storageKey,
			url: `/_emdash/api/media/file/${storageKey}`,
		};
	}

	async mediaDelete(id: string): Promise<boolean> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("write:media")) {
			throw new Error("Missing capability: write:media");
		}

		// Look up the storage key before deleting
		const media = await this.env.DB.prepare("SELECT storage_key FROM media WHERE id = ?")
			.bind(id)
			.first<{ storage_key: string }>();

		if (!media) return false;

		// Delete the DB row
		const result = await this.env.DB.prepare("DELETE FROM media WHERE id = ?").bind(id).run();

		// Delete from R2 if the binding is available
		if (this.env.MEDIA && media.storage_key) {
			try {
				await this.env.MEDIA.delete(media.storage_key);
			} catch {
				// Log but don't fail - the DB row is already deleted
				console.warn(`[plugin-bridge] Failed to delete R2 object: ${media.storage_key}`);
			}
		}

		return (result.meta?.changes ?? 0) > 0;
	}

	// =========================================================================
	// Network Operations - capability-gated + host validation
	// =========================================================================

	async httpFetch(
		url: string,
		init?: RequestInit,
	): Promise<{
		status: number;
		headers: Record<string, string>;
		text: string;
	}> {
		const { capabilities, allowedHosts } = this.ctx.props;
		const hasUnrestricted = capabilities.includes("network:fetch:any");
		const hasFetch = capabilities.includes("network:fetch") || hasUnrestricted;
		if (!hasFetch) {
			throw new Error("Missing capability: network:fetch");
		}

		if (!hasUnrestricted) {
			const host = new URL(url).host;
			if (allowedHosts.length === 0) {
				throw new Error(
					`Plugin has no allowed hosts configured. Add hosts to allowedHosts to enable HTTP requests.`,
				);
			}
			const allowed = allowedHosts.some((pattern) => {
				if (pattern.startsWith("*.")) {
					return host.endsWith(pattern.slice(1)) || host === pattern.slice(2);
				}
				return host === pattern;
			});
			if (!allowed) {
				throw new Error(`Host not allowed: ${host}. Allowed: ${allowedHosts.join(", ")}`);
			}
		}

		const response = await fetch(url, init);
		const headers: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			headers[key] = value;
		});

		return {
			status: response.status,
			headers,
			text: await response.text(),
		};
	}

	// =========================================================================
	// User Operations - capability-gated (read:users)
	// =========================================================================

	async userGet(id: string): Promise<{
		id: string;
		email: string;
		name: string | null;
		role: number;
		createdAt: string;
	} | null> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("read:users")) {
			throw new Error("Missing capability: read:users");
		}
		const result = await this.env.DB.prepare(
			"SELECT id, email, name, role, created_at FROM users WHERE id = ?",
		)
			.bind(id)
			.first<{
				id: string;
				email: string;
				name: string | null;
				role: number;
				created_at: string;
			}>();
		if (!result) return null;
		return {
			id: result.id,
			email: result.email,
			name: result.name,
			role: result.role,
			createdAt: result.created_at,
		};
	}

	async userGetByEmail(email: string): Promise<{
		id: string;
		email: string;
		name: string | null;
		role: number;
		createdAt: string;
	} | null> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("read:users")) {
			throw new Error("Missing capability: read:users");
		}
		const result = await this.env.DB.prepare(
			"SELECT id, email, name, role, created_at FROM users WHERE email = ?",
		)
			.bind(email.toLowerCase())
			.first<{
				id: string;
				email: string;
				name: string | null;
				role: number;
				created_at: string;
			}>();
		if (!result) return null;
		return {
			id: result.id,
			email: result.email,
			name: result.name,
			role: result.role,
			createdAt: result.created_at,
		};
	}

	async userList(opts?: { role?: number; limit?: number; cursor?: string }): Promise<{
		items: Array<{
			id: string;
			email: string;
			name: string | null;
			role: number;
			createdAt: string;
		}>;
		nextCursor?: string;
	}> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("read:users")) {
			throw new Error("Missing capability: read:users");
		}
		const limit = Math.max(1, Math.min(opts?.limit ?? 50, 100));
		let sql = "SELECT id, email, name, role, created_at FROM users";
		const params: unknown[] = [];
		const conditions: string[] = [];

		if (opts?.role !== undefined) {
			conditions.push("role = ?");
			params.push(opts.role);
		}

		if (opts?.cursor) {
			conditions.push("id < ?");
			params.push(opts.cursor);
		}

		if (conditions.length > 0) {
			sql += ` WHERE ${conditions.join(" AND ")}`;
		}

		sql += " ORDER BY id DESC LIMIT ?";
		params.push(limit + 1);

		const results = await this.env.DB.prepare(sql)
			.bind(...params)
			.all<{
				id: string;
				email: string;
				name: string | null;
				role: number;
				created_at: string;
			}>();

		const rows = results.results ?? [];
		const pageRows = rows.slice(0, limit);
		const items = pageRows.map((row) => ({
			id: row.id,
			email: row.email,
			name: row.name,
			role: row.role,
			createdAt: row.created_at,
		}));
		const hasMore = rows.length > limit;

		return {
			items,
			nextCursor: hasMore && items.length > 0 ? items.at(-1)!.id : undefined,
		};
	}

	// =========================================================================
	// Email Operations - capability-gated
	// =========================================================================

	async emailSend(message: {
		to: string;
		subject: string;
		text: string;
		html?: string;
	}): Promise<void> {
		const { capabilities, pluginId } = this.ctx.props;
		if (!capabilities.includes("email:send")) {
			throw new Error("Missing capability: email:send");
		}
		if (!emailSendCallback) {
			throw new Error("Email is not configured. No email provider is available.");
		}
		await emailSendCallback(message, pluginId);
	}

	// =========================================================================
	// Logging
	// =========================================================================

	log(level: "debug" | "info" | "warn" | "error", msg: string, data?: unknown): void {
		const { pluginId } = this.ctx.props;
		console[level](`[plugin:${pluginId}]`, msg, data ?? "");
	}
}
