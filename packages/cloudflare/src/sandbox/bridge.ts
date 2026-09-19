/**
 * PluginBridge WorkerEntrypoint
 *
 * Provides controlled access to database operations for sandboxed plugins.
 * The sandbox gets a SERVICE BINDING to this entrypoint, not direct DB access.
 * All operations are validated and scoped to the plugin.
 *
 */

import type { D1Database } from "@cloudflare/workers-types";
import { WorkerEntrypoint } from "cloudflare:workers";
import type {
	CommentCountOptions,
	CommentListOptions,
	ConditionalDeleteResult,
	ConditionalWriteResult,
	ContentActionCallbacks,
	ContentCreateOptions,
	CronTaskInfo,
	Database,
	I18nConfig,
	PluginComment,
	PluginCommentStatus,
	SandboxCommentModerateCallback,
	RedirectCreateInput,
	RedirectInfo,
	RedirectListOptions,
	RedirectUpdateInput,
	PluginContentItem,
	SandboxContentCreateCallback,
	SandboxEmailSendCallback,
	Storage,
	TaxonomyAccessWithWrite,
	VersionedRedirect,
	VersionedValue,
} from "emdash";
import type { MediaBytes, MediaItem as PluginMediaItem, MediaMetadataPatch } from "emdash/plugin";
import type {
	ContentItem,
	ContentListOptions,
	OptionsRepository,
	PaginatedResult,
	PluginStorageRepository,
	SettingField,
} from "emdash/plugins/host";
import {
	createPluginSecretRedactor,
	type PluginSecretRedactor,
} from "emdash/plugins/secret-redactor";

import { sandboxHttpFetch } from "./bridge-http.js";
import type { RedirectBridgeResult, StorageUpdateIfResponse } from "./types.js";

let bridgeRuntimePromise: Promise<typeof import("./bridge-runtime.js")> | undefined;

function loadBridgeRuntime(): Promise<typeof import("./bridge-runtime.js")> {
	bridgeRuntimePromise ??= import("./bridge-runtime.js");
	return bridgeRuntimePromise;
}

/** Regex to validate collection names (prevent SQL injection) */
const COLLECTION_NAME_REGEX = /^[a-z][a-z0-9_]*$/;
const MISSING_MEDIA_USAGE_ACTIVATION_TABLE_REGEX = /no such table.*_emdash_media_usage_activation/i;
const SETTINGS_KEY_PREFIX = "settings:";

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
	"locale",
	"translation_group",
]);

/** Regex to validate file extensions (simple alphanumeric, 1-10 chars) */
const FILE_EXT_REGEX = /^\.[a-z0-9]{1,10}$/i;
const COMMENT_STATUSES = new Set<string>(["approved", "pending", "spam"]);
const CONTENT_ACTION_ERROR_CODE_REGEX = /^[A-Z][A-Z0-9_]*$/;

function invalidCommentStatus(value: string, name: string): string | null {
	return COMMENT_STATUSES.has(value) ? null : `${name} must be one of: approved, pending, spam`;
}

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
const CONTENT_CREATE_CALLBACKS_KEY = Symbol.for("emdash:sandbox-content-create-callbacks");
const TAXONOMY_WRITE_CALLBACKS_KEY = Symbol.for("emdash:sandbox-taxonomy-write-callbacks");
const CONTENT_ACTION_CALLBACKS_KEY = Symbol.for("emdash:sandbox-content-action-callbacks");
let cronRescheduleCallback: (() => void) | null = null;
let cronNowCallback: (() => Date) | null = null;
let commentModerateCallback: SandboxCommentModerateCallback | null = null;
let mediaStorageCallback: Pick<Storage, "download"> | null = null;

function contentCreateCallbacks(): Map<string, SandboxContentCreateCallback> {
	const store = globalThis as Record<symbol, unknown>;
	const existing = store[CONTENT_CREATE_CALLBACKS_KEY];
	if (existing instanceof Map) {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- this private Symbol stores only callback maps created below
		return existing as Map<string, SandboxContentCreateCallback>;
	}
	const callbacks = new Map<string, SandboxContentCreateCallback>();
	store[CONTENT_CREATE_CALLBACKS_KEY] = callbacks;
	return callbacks;
}

function taxonomyWriteCallbacks(): Map<string, TaxonomyAccessWithWrite> {
	const store = globalThis as Record<symbol, unknown>;
	const existing = store[TAXONOMY_WRITE_CALLBACKS_KEY];
	if (existing instanceof Map) {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- this private Symbol stores only callback maps created below
		return existing as Map<string, TaxonomyAccessWithWrite>;
	}
	const callbacks = new Map<string, TaxonomyAccessWithWrite>();
	store[TAXONOMY_WRITE_CALLBACKS_KEY] = callbacks;
	return callbacks;
}

function contentActionCallbacks(): Map<string, ContentActionCallbacks> {
	const store = globalThis as Record<symbol, unknown>;
	const existing = store[CONTENT_ACTION_CALLBACKS_KEY];
	if (existing instanceof Map) {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- this private Symbol stores only callback maps created below
		return existing as Map<string, ContentActionCallbacks>;
	}
	const callbacks = new Map<string, ContentActionCallbacks>();
	store[CONTENT_ACTION_CALLBACKS_KEY] = callbacks;
	return callbacks;
}

/**
 * Set the email send callback for all bridge instances.
 * Called by the runner when the EmailPipeline is available.
 */
export function setEmailSendCallback(callback: SandboxEmailSendCallback | null): void {
	emailSendCallback = callback;
}

export function setContentCreateCallback(
	runtimeId: string,
	callback: SandboxContentCreateCallback | null,
): void {
	if (callback) contentCreateCallbacks().set(runtimeId, callback);
	else contentCreateCallbacks().delete(runtimeId);
}

export function setContentActionsCallback(
	runtimeId: string,
	callback: ContentActionCallbacks | null,
): void {
	if (callback) contentActionCallbacks().set(runtimeId, callback);
	else contentActionCallbacks().delete(runtimeId);
}

export function beginContentActionCallbacks(
	runtimeId: string,
	pluginId: string,
	invocationId: string,
	invalidateContentCache?: (tags: string[]) => Promise<void>,
): void {
	contentActionCallbacks().get(runtimeId)?.begin?.(pluginId, invocationId, invalidateContentCache);
}

export function flushContentActionCallbacks(
	runtimeId: string,
	pluginId: string,
	invocationId: string,
	final: boolean,
): Promise<void> {
	return (
		contentActionCallbacks().get(runtimeId)?.flush(pluginId, invocationId, final) ??
		Promise.resolve()
	);
}

export function setCronRescheduleCallback(callback: (() => void) | null): void {
	cronRescheduleCallback = callback;
}

export function setCronNowCallback(callback: (() => Date) | null): void {
	cronNowCallback = callback;
}

export function setCommentModerateCallback(callback: SandboxCommentModerateCallback | null): void {
	commentModerateCallback = callback;
}

export function setMediaStorageCallback(storage: Pick<Storage, "download"> | null): void {
	mediaStorageCallback = storage;
}

export function setTaxonomyWriteCallback(
	runtimeId: string,
	callback: TaxonomyAccessWithWrite | null,
): void {
	if (callback) taxonomyWriteCallbacks().set(runtimeId, callback);
	else taxonomyWriteCallbacks().delete(runtimeId);
}

function serializeValue(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (typeof value === "object") return JSON.stringify(value);
	return value;
}

async function forwardContentAction<T>(fn: () => Promise<T>): Promise<T | Record<string, unknown>> {
	try {
		return await fn();
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			typeof error.code === "string" &&
			CONTENT_ACTION_ERROR_CODE_REGEX.test(error.code)
		) {
			return {
				__emdashContentActionError: true,
				error: { code: error.code, message: error.message },
			};
		}
		throw error;
	}
}

function rowToContentItem(collection: string, row: Record<string, unknown>) {
	const data: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		if (SYSTEM_COLUMNS.has(key)) continue;
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
	return {
		id: typeof row.id === "string" ? row.id : String(row.id),
		type: collection,
		slug: typeof row.slug === "string" ? row.slug : null,
		status: typeof row.status === "string" ? row.status : "draft",
		data,
		createdAt: typeof row.created_at === "string" ? row.created_at : new Date().toISOString(),
		updatedAt: typeof row.updated_at === "string" ? row.updated_at : new Date().toISOString(),
		locale: typeof row.locale === "string" ? row.locale : "en",
		publishedAt: typeof row.published_at === "string" ? row.published_at : null,
		scheduledAt: typeof row.scheduled_at === "string" ? row.scheduled_at : null,
		authorId: columnNullableString(row.author_id),
		translationGroup: columnNullableString(row.translation_group),
		liveRevisionId: columnNullableString(row.live_revision_id),
		draftRevisionId: columnNullableString(row.draft_revision_id),
		version: typeof row.version === "number" ? row.version : Number(row.version) || 1,
	};
}

/** Narrow an unknown D1 column value to a string ("" when it isn't one). */
function columnString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Narrow an unknown, nullable D1 column value to `string | null`. */
function columnNullableString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

/** Parse a JSON string column into a string array (`[]` on anything else). */
function columnStringArray(value: unknown): string[] {
	if (typeof value !== "string" || !value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === "string")
			: [];
	} catch {
		return [];
	}
}

/** Type guard for plain JSON objects. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a JSON string column into an object (`null` on anything else). */
function columnJsonObject(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "string" || !value) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		return isJsonObject(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Convert a `taxonomies` row to the term shape exposed over the bridge.
 * Matches core's TaxonomyTermInfo from plugins/types.ts.
 */
function rowToTaxonomyTerm(row: Record<string, unknown>): {
	id: string;
	taxonomy: string;
	slug: string;
	label: string;
	parentId: string | null;
	data: Record<string, unknown> | null;
	locale: string;
	translationGroup: string | null;
} {
	return {
		id: columnString(row.id),
		taxonomy: columnString(row.name),
		slug: columnString(row.slug),
		label: columnString(row.label),
		parentId: columnNullableString(row.parent_id),
		data: columnJsonObject(row.data),
		locale: columnString(row.locale),
		translationGroup: columnNullableString(row.translation_group),
	};
}

async function redirectBridgeResult<T>(action: () => Promise<T>): Promise<RedirectBridgeResult<T>> {
	try {
		return { ok: true, value: await action() };
	} catch (error) {
		const { RedirectAccessError } = await loadBridgeRuntime();
		if (error instanceof RedirectAccessError) {
			return { ok: false, error: { code: error.code, message: error.message } };
		}
		throw error;
	}
}

/**
 * Environment bindings required by PluginBridge
 */
export interface PluginBridgeEnv {
	DB: D1Database;
	MEDIA?: R2Bucket;
	EMDASH_ENCRYPTION_KEY?: string;
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
	contentCreateRuntimeId?: string;
	contentActionsRuntimeId?: string;
	taxonomyWriteRuntimeId?: string;
	i18nConfig?: I18nConfig | null;
	siteInfo?: {
		name: string;
		url: string;
		locale: string;
		trailingSlash?: "always" | "never" | "ignore";
	};
	/** Per-collection storage config (matches manifest.storage entries) */
	storageConfig?: Record<
		string,
		{ indexes?: Array<string | string[]>; uniqueIndexes?: Array<string | string[]> }
	>;
	settingsSchema?: Record<string, SettingField>;
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
	private readonly secretRedactor: PluginSecretRedactor = createPluginSecretRedactor();

	private async db() {
		const { D1Dialect, Kysely } = await loadBridgeRuntime();
		return new Kysely<Database>({ dialect: new D1Dialect({ database: this.env.DB }) });
	}

	private requireCapability(capability: string): void {
		if (!this.ctx.props.capabilities.includes(capability)) {
			throw new Error(`Missing capability: ${capability}`);
		}
	}

	private validateCollection(collection: string): void {
		if (!COLLECTION_NAME_REGEX.test(collection)) {
			throw new Error(`Invalid collection name: ${collection}`);
		}
	}

	private async contentAccess() {
		const { createContentAccess } = await loadBridgeRuntime();
		return createContentAccess(await this.db(), {
			site: this.ctx.props.siteInfo,
			revisions: this.ctx.props.capabilities.includes("content:revisions:read"),
		});
	}

	private async getOptionsRepo(): Promise<OptionsRepository> {
		const { D1Dialect, Kysely, OptionsRepository } = await loadBridgeRuntime();
		return new OptionsRepository(
			new Kysely<Database>({ dialect: new D1Dialect({ database: this.env.DB }) }),
		);
	}

	private async getSettingsAccess() {
		const { createSettingsAccess, resolvePluginEncryptionKeys } = await loadBridgeRuntime();
		const keys =
			this.env.EMDASH_ENCRYPTION_KEY === undefined
				? undefined
				: await resolvePluginEncryptionKeys({
						EMDASH_ENCRYPTION_KEY: this.env.EMDASH_ENCRYPTION_KEY,
					});
		return createSettingsAccess(
			await this.getOptionsRepo(),
			this.ctx.props.pluginId,
			this.ctx.props.settingsSchema ?? {},
			keys,
			this.secretRedactor.add,
		);
	}

	private observeSecretSetting(key: string, value: unknown): void {
		const name = key.slice(SETTINGS_KEY_PREFIX.length);
		if (this.ctx.props.settingsSchema?.[name]?.type === "secret" && typeof value === "string") {
			this.secretRedactor.add(name, value);
		}
	}

	private async deleteLegacyKV(key: string): Promise<boolean> {
		const result = await this.env.DB.prepare(
			"DELETE FROM _plugin_storage WHERE plugin_id = ? AND collection = '__kv' AND id = ?",
		)
			.bind(this.ctx.props.pluginId, key)
			.run();
		return (result.meta?.changes ?? 0) > 0;
	}

	private async assertMediaUsageActivationWriteAllowed(): Promise<void> {
		const { createSandboxRouteError, getSandboxRouteErrorDetails } = await loadBridgeRuntime();
		try {
			const activation = await this.env.DB.prepare(
				"SELECT state FROM _emdash_media_usage_activation WHERE task_key = ? LIMIT 1",
			)
				.bind("incremental_capture")
				.first<{ state: string }>();
			if (activation?.state === "activating") {
				throw createSandboxRouteError("MEDIA_USAGE_ACTIVATION_IN_PROGRESS");
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (MISSING_MEDIA_USAGE_ACTIVATION_TABLE_REGEX.test(message)) return;
			if (getSandboxRouteErrorDetails(error)) throw error;
			console.error("[media-usage] Failed to check the sandbox write fence:", error);
			throw createSandboxRouteError("MEDIA_USAGE_ACTIVATION_CHECK_FAILED");
		}
	}

	/**
	 * Construct a PluginStorageRepository for the requested collection.
	 * Uses the indexes from the plugin's storage config (if provided) so
	 * query/count operations support WHERE/ORDER BY/cursor pagination
	 * matching in-process and workerd sandbox plugins.
	 */
	private async getStorageRepo(collection: string): Promise<PluginStorageRepository> {
		const { D1Dialect, Kysely, PluginStorageRepository } = await loadBridgeRuntime();
		const { pluginId, storageConfig } = this.ctx.props;
		const config = storageConfig?.[collection];
		// Merge unique indexes into the indexes list since both are queryable
		const allIndexes: Array<string | string[]> = [
			...(config?.indexes ?? []),
			...(config?.uniqueIndexes ?? []),
		];
		const db = new Kysely<unknown>({
			dialect: new D1Dialect({ database: this.env.DB }),
		});
		// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Kysely<unknown> is compatible with PluginStorageRepository's expected db
		return new PluginStorageRepository(db as never, pluginId, collection, allIndexes);
	}

	// =========================================================================
	// KV Operations - scoped to plugin namespace
	// =========================================================================

	/**
	 * KV operations use _plugin_storage with a special "__kv" collection.
	 * This provides consistent storage across sandboxed and non-sandboxed modes.
	 */
	async kvGet(key: string): Promise<unknown> {
		const { pluginId } = this.ctx.props;
		if (key.startsWith(SETTINGS_KEY_PREFIX)) {
			const value = await (
				await this.getSettingsAccess()
			).get(key.slice(SETTINGS_KEY_PREFIX.length));
			if (value !== null) return value;
		}
		const result = await this.env.DB.prepare(
			"SELECT data FROM _plugin_storage WHERE plugin_id = ? AND collection = '__kv' AND id = ?",
		)
			.bind(pluginId, key)
			.first<{ data: string }>();
		if (!result) return null;
		try {
			const value: unknown = JSON.parse(result.data);
			if (key.startsWith(SETTINGS_KEY_PREFIX)) this.observeSecretSetting(key, value);
			return value;
		} catch {
			if (key.startsWith(SETTINGS_KEY_PREFIX)) this.observeSecretSetting(key, result.data);
			return result.data;
		}
	}

	async kvSet(key: string, value: unknown): Promise<void> {
		const { pluginId } = this.ctx.props;
		if (key.startsWith(SETTINGS_KEY_PREFIX)) {
			await (await this.getSettingsAccess()).set(key.slice(SETTINGS_KEY_PREFIX.length), value);
			await this.deleteLegacyKV(key);
			return;
		}
		await this.env.DB.prepare(
			"INSERT OR REPLACE INTO _plugin_storage (plugin_id, collection, id, data, revision, updated_at) VALUES (?, '__kv', ?, ?, ?, datetime('now'))",
		)
			.bind(pluginId, key, JSON.stringify(value), crypto.randomUUID())
			.run();
	}

	async kvGetVersioned(key: string): Promise<VersionedValue | null> {
		if (key.startsWith(SETTINGS_KEY_PREFIX)) {
			const value = await (
				await this.getSettingsAccess()
			).getVersioned(key.slice(SETTINGS_KEY_PREFIX.length));
			if (value !== null) return value;
		}
		const legacy = await (await this.getStorageRepo("__kv")).getVersioned(key);
		if (legacy && key.startsWith(SETTINGS_KEY_PREFIX)) {
			this.observeSecretSetting(key, legacy.value);
		}
		return legacy;
	}

	async kvCompareAndSet(
		key: string,
		expectedRevision: string | null,
		value: unknown,
	): Promise<ConditionalWriteResult> {
		if (key.startsWith(SETTINGS_KEY_PREFIX)) {
			const result = await (
				await this.getSettingsAccess()
			).compareAndSet(key.slice(SETTINGS_KEY_PREFIX.length), expectedRevision, value);
			if (result.applied) await this.deleteLegacyKV(key);
			return result;
		}
		return (await this.getStorageRepo("__kv")).compareAndSet(key, expectedRevision, value);
	}

	async kvCompareAndDelete(
		key: string,
		expectedRevision: string,
	): Promise<ConditionalDeleteResult> {
		if (key.startsWith(SETTINGS_KEY_PREFIX)) {
			const result = await (
				await this.getSettingsAccess()
			).compareAndDelete(key.slice(SETTINGS_KEY_PREFIX.length), expectedRevision);
			if (result.applied) await this.deleteLegacyKV(key);
			return result;
		}
		return (await this.getStorageRepo("__kv")).compareAndDelete(key, expectedRevision);
	}

	async kvDelete(key: string): Promise<boolean> {
		const { pluginId } = this.ctx.props;
		if (key.startsWith(SETTINGS_KEY_PREFIX)) {
			const optionDeleted = await (
				await this.getSettingsAccess()
			).delete(key.slice(SETTINGS_KEY_PREFIX.length));
			const legacyDeleted = await this.deleteLegacyKV(key);
			return optionDeleted || legacyDeleted;
		}
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

		const entries = new Map(
			(results.results ?? []).map((row) => [row.id, JSON.parse(row.data) as unknown]),
		);
		const includesSettings =
			SETTINGS_KEY_PREFIX.startsWith(prefix) || prefix.startsWith(SETTINGS_KEY_PREFIX);
		if (includesSettings) {
			const settingPrefix = prefix.startsWith(SETTINGS_KEY_PREFIX)
				? prefix.slice(SETTINGS_KEY_PREFIX.length)
				: "";
			for (const { key, value } of await (await this.getSettingsAccess()).list(settingPrefix)) {
				const fullKey = `${SETTINGS_KEY_PREFIX}${key}`;
				if (fullKey.startsWith(prefix)) entries.set(fullKey, value);
			}
		}
		for (const [key, value] of entries) {
			if (key.startsWith(SETTINGS_KEY_PREFIX)) this.observeSecretSetting(key, value);
		}
		return Array.from(entries, ([key, value]) => ({ key, value }));
	}

	async settingsGet(key: string): Promise<unknown> {
		return this.kvGet(`${SETTINGS_KEY_PREFIX}${key}`);
	}

	async settingsSet(key: string, value: unknown): Promise<void> {
		return this.kvSet(`${SETTINGS_KEY_PREFIX}${key}`, value);
	}

	async settingsGetVersioned(key: string): Promise<VersionedValue | null> {
		return this.kvGetVersioned(`${SETTINGS_KEY_PREFIX}${key}`);
	}

	async settingsCompareAndSet(
		key: string,
		expectedRevision: string | null,
		value: unknown,
	): Promise<ConditionalWriteResult> {
		return this.kvCompareAndSet(`${SETTINGS_KEY_PREFIX}${key}`, expectedRevision, value);
	}

	async settingsCompareAndDelete(
		key: string,
		expectedRevision: string,
	): Promise<ConditionalDeleteResult> {
		return this.kvCompareAndDelete(`${SETTINGS_KEY_PREFIX}${key}`, expectedRevision);
	}

	async settingsDelete(key: string): Promise<boolean> {
		return this.kvDelete(`${SETTINGS_KEY_PREFIX}${key}`);
	}

	async settingsList(prefix = ""): Promise<Array<{ key: string; value: unknown }>> {
		const entries = await this.kvList(`${SETTINGS_KEY_PREFIX}${prefix}`);
		return entries.map(({ key, value }) => ({
			key: key.slice(SETTINGS_KEY_PREFIX.length),
			value,
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
			"INSERT OR REPLACE INTO _plugin_storage (plugin_id, collection, id, data, revision, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
		)
			.bind(pluginId, collection, id, JSON.stringify(data), crypto.randomUUID())
			.run();
	}

	async storageGetVersioned(collection: string, id: string): Promise<VersionedValue | null> {
		if (!this.ctx.props.storageCollections.includes(collection)) {
			throw new Error(`Storage collection not declared: ${collection}`);
		}
		return (await this.getStorageRepo(collection)).getVersioned(id);
	}

	async storageCompareAndSet(
		collection: string,
		id: string,
		expectedRevision: string | null,
		data: unknown,
	): Promise<ConditionalWriteResult> {
		if (!this.ctx.props.storageCollections.includes(collection)) {
			throw new Error(`Storage collection not declared: ${collection}`);
		}
		return (await this.getStorageRepo(collection)).compareAndSet(id, expectedRevision, data);
	}

	async storageCompareAndDelete(
		collection: string,
		id: string,
		expectedRevision: string,
	): Promise<ConditionalDeleteResult> {
		if (!this.ctx.props.storageCollections.includes(collection)) {
			throw new Error(`Storage collection not declared: ${collection}`);
		}
		return (await this.getStorageRepo(collection)).compareAndDelete(id, expectedRevision);
	}

	async storageUpdateIf(
		collection: string,
		id: string,
		args: unknown,
	): Promise<StorageUpdateIfResponse> {
		if (!this.ctx.props.storageCollections.includes(collection)) {
			throw new Error(`Storage collection not declared: ${collection}`);
		}
		try {
			return await (await this.getStorageRepo(collection)).updateIf(id, args);
		} catch (error) {
			const { StorageSerializationError } = await loadBridgeRuntime();
			if (!(error instanceof StorageSerializationError)) throw error;
			return {
				__emdashStorageError: {
					name: "StorageSerializationError",
					code: "STORAGE_SERIALIZATION_FAILURE",
					retryable: true,
					...(error.sqlState === "40001" || error.sqlState === "40P01"
						? { sqlState: error.sqlState }
						: {}),
					message:
						"Storage write must be retried. Restart the transaction before retrying when using an explicit transaction.",
				},
			};
		}
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
		opts: {
			limit?: number;
			cursor?: string;
			where?: Record<string, unknown>;
			orderBy?: Record<string, "asc" | "desc">;
		} = {},
	): Promise<{
		items: Array<{ id: string; data: unknown }>;
		hasMore: boolean;
		cursor?: string;
	}> {
		const { storageCollections } = this.ctx.props;
		if (!storageCollections.includes(collection)) {
			throw new Error(`Storage collection not declared: ${collection}`);
		}
		// Delegate to PluginStorageRepository for proper WHERE/ORDER BY/cursor support
		const repo = await this.getStorageRepo(collection);
		const result = await repo.query({
			// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- WhereClause is structurally Record<string, unknown>
			where: opts.where as never,
			orderBy: opts.orderBy,
			limit: opts.limit,
			cursor: opts.cursor,
		});
		return {
			items: result.items,
			hasMore: result.hasMore,
			cursor: result.cursor,
		};
	}

	async storageCount(collection: string, where?: Record<string, unknown>): Promise<number> {
		const { storageCollections } = this.ctx.props;
		if (!storageCollections.includes(collection)) {
			throw new Error(`Storage collection not declared: ${collection}`);
		}
		const repo = await this.getStorageRepo(collection);
		// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- WhereClause is structurally Record<string, unknown>
		return repo.count(where as never);
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

		for (const item of items) {
			await this.env.DB.prepare(
				"INSERT OR REPLACE INTO _plugin_storage (plugin_id, collection, id, data, revision, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
			)
				.bind(pluginId, collection, item.id, JSON.stringify(item.data), crypto.randomUUID())
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

	async contentGet(collection: string, id: string): Promise<ContentItem | null> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("content:read")) {
			throw new Error("Missing capability: content:read");
		}
		// Validate collection name to prevent SQL injection
		if (!COLLECTION_NAME_REGEX.test(collection)) {
			throw new Error(`Invalid collection name: ${collection}`);
		}
		const { createContentAccess, D1Dialect, Kysely } = await loadBridgeRuntime();
		const db = new Kysely<Database>({ dialect: new D1Dialect({ database: this.env.DB }) });
		try {
			return await createContentAccess(db, {
				site: this.ctx.props.siteInfo,
				revisions: capabilities.includes("content:revisions:read"),
			}).get(collection, id);
		} catch {
			const row = await this.env.DB.prepare(
				`SELECT * FROM ec_${collection} WHERE id = ? AND deleted_at IS NULL`,
			)
				.bind(id)
				.first();
			return row ? rowToContentItem(collection, row) : null;
		}
	}

	async contentList(
		collection: string,
		opts: ContentListOptions = {},
	): Promise<PaginatedResult<ContentItem>> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("content:read")) {
			throw new Error("Missing capability: content:read");
		}
		// Validate collection name to prevent SQL injection
		if (!COLLECTION_NAME_REGEX.test(collection)) {
			throw new Error(`Invalid collection name: ${collection}`);
		}
		const { createContentAccess, D1Dialect, Kysely } = await loadBridgeRuntime();
		const db = new Kysely<Database>({ dialect: new D1Dialect({ database: this.env.DB }) });
		return createContentAccess(db, {
			site: this.ctx.props.siteInfo,
			revisions: capabilities.includes("content:revisions:read"),
		}).list(collection, opts);
	}

	async contentTranslations(collection: string, id: string) {
		this.requireCapability("content:read");
		this.validateCollection(collection);
		return (await this.contentAccess()).getTranslations!(collection, id);
	}

	async contentPublicUrl(collection: string, id: string) {
		this.requireCapability("content:read");
		this.validateCollection(collection);
		return (await this.contentAccess()).getPublicUrl!(collection, id);
	}

	async contentListRevisions(collection: string, id: string, options?: { limit?: number }) {
		this.requireCapability("content:revisions:read");
		this.validateCollection(collection);
		return (await this.contentAccess()).listRevisions!(collection, id, options);
	}

	async contentGetRevision(collection: string, id: string, revisionId: string) {
		this.requireCapability("content:revisions:read");
		this.validateCollection(collection);
		return (await this.contentAccess()).getRevision!(collection, id, revisionId);
	}

	async schemaListCollections() {
		this.requireCapability("schema:read");
		const { createSchemaAccess } = await loadBridgeRuntime();
		return createSchemaAccess(await this.db()).listCollections();
	}

	async schemaGetCollection(slug: string) {
		this.requireCapability("schema:read");
		this.validateCollection(slug);
		const { createSchemaAccess } = await loadBridgeRuntime();
		return createSchemaAccess(await this.db()).getCollection(slug);
	}

	async contentCreate(
		collection: string,
		data: Record<string, unknown>,
		options?: ContentCreateOptions,
		originHookInput?: string,
	): Promise<
		| PluginContentItem
		| {
				__emdashContentCreateError: true;
				error: {
					code: "CONFLICT" | "NOT_FOUND" | "SAVE_REJECTED" | "VALIDATION_ERROR";
					message: string;
				};
		  }
	> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("content:write")) {
			throw new Error("Missing capability: content:write");
		}
		if (!COLLECTION_NAME_REGEX.test(collection)) {
			throw new Error(`Invalid collection name: ${collection}`);
		}
		const { resolveContentCreateLocale, ulid } = await loadBridgeRuntime();
		let locale: string;
		try {
			locale = resolveContentCreateLocale(options?.locale, this.ctx.props.i18nConfig ?? null);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Invalid locale";
			return {
				__emdashContentCreateError: true,
				error: { code: "VALIDATION_ERROR", message },
			};
		}
		await this.assertMediaUsageActivationWriteAllowed();
		const runtimeContentCreate = this.ctx.props.contentCreateRuntimeId
			? contentCreateCallbacks().get(this.ctx.props.contentCreateRuntimeId)
			: undefined;
		if (runtimeContentCreate) {
			const originHook =
				originHookInput === "content:beforeSave" || originHookInput === "content:afterSave"
					? originHookInput
					: undefined;
			try {
				return await runtimeContentCreate(this.ctx.props.pluginId, collection, data, {
					locale,
					translationOf: options?.translationOf,
					originHook,
					sandboxOrigin: true,
				});
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
				if (
					code === "CONFLICT" ||
					code === "NOT_FOUND" ||
					code === "SAVE_REJECTED" ||
					code === "VALIDATION_ERROR"
				) {
					return {
						__emdashContentCreateError: true,
						error: {
							code,
							message: error instanceof Error ? error.message : "Content create failed",
						},
					};
				}
				throw error;
			}
		}
		const id = ulid();
		const now = new Date().toISOString();
		const columns = [
			'"id"',
			'"slug"',
			'"status"',
			'"author_id"',
			'"created_at"',
			'"updated_at"',
			'"version"',
			'"locale"',
			'"translation_group"',
		];
		const values: unknown[] = [
			id,
			typeof data.slug === "string" ? data.slug : null,
			typeof data.status === "string" ? data.status : "draft",
			typeof data.author_id === "string" ? data.author_id : null,
			now,
			now,
			1,
			locale,
			id,
		];
		for (const [key, value] of Object.entries(data)) {
			if (!SYSTEM_COLUMNS.has(key) && COLLECTION_NAME_REGEX.test(key)) {
				columns.push(`"${key}"`);
				values.push(serializeValue(value));
			}
		}
		const placeholders = columns.map(() => "?").join(", ");
		await this.env.DB.prepare(
			`INSERT INTO ec_${collection} (${columns.join(", ")}) VALUES (${placeholders})`,
		)
			.bind(...values)
			.run();
		const created = await this.env.DB.prepare(
			`SELECT * FROM ec_${collection} WHERE id = ? AND deleted_at IS NULL`,
		)
			.bind(id)
			.first();
		return created
			? rowToContentItem(collection, created)
			: rowToContentItem(collection, {
					id,
					locale,
					created_at: now,
					updated_at: now,
				});
	}

	async contentUpdate(
		collection: string,
		id: string,
		data: Record<string, unknown>,
	): Promise<ReturnType<typeof rowToContentItem>> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("content:write")) {
			throw new Error("Missing capability: content:write");
		}
		if (!COLLECTION_NAME_REGEX.test(collection)) {
			throw new Error(`Invalid collection name: ${collection}`);
		}
		const { ContentRepository, D1Dialect, Kysely } = await loadBridgeRuntime();
		const db = new Kysely<Database>({
			dialect: new D1Dialect({ database: this.env.DB }),
		});
		await this.assertMediaUsageActivationWriteAllowed();
		const updated = await new ContentRepository(db).updateDraftAware(collection, id, {
			data,
			status: typeof data.status === "string" ? data.status : undefined,
			slug: data.slug === undefined ? undefined : typeof data.slug === "string" ? data.slug : null,
		});
		return rowToContentItem(collection, {
			...updated.data,
			id: updated.id,
			slug: updated.slug,
			status: updated.status,
			created_at: updated.createdAt,
			updated_at: updated.updatedAt,
			published_at: updated.publishedAt,
			scheduled_at: updated.scheduledAt,
			locale: updated.locale,
		});
	}

	async contentDelete(collection: string, id: string): Promise<boolean> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("content:write")) {
			throw new Error("Missing capability: content:write");
		}
		if (!COLLECTION_NAME_REGEX.test(collection)) {
			throw new Error(`Invalid collection name: ${collection}`);
		}
		await this.assertMediaUsageActivationWriteAllowed();
		const now = new Date().toISOString();
		const result = await this.env.DB.prepare(
			`UPDATE ec_${collection} SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
		)
			.bind(now, now, id)
			.run();
		return (result.meta?.changes ?? 0) > 0;
	}

	async commentGet(id: string): Promise<PluginComment | null> {
		if (!this.ctx.props.capabilities.includes("comments:read")) {
			throw new Error("Missing capability: comments:read");
		}
		const { createCommentAccess, D1Dialect, Kysely } = await loadBridgeRuntime();
		const db = new Kysely<Database>({ dialect: new D1Dialect({ database: this.env.DB }) });
		return createCommentAccess(db).get(id);
	}

	async commentList(opts: CommentListOptions = {}): Promise<PaginatedResult<PluginComment>> {
		if (!this.ctx.props.capabilities.includes("comments:read")) {
			throw new Error("Missing capability: comments:read");
		}
		const { createCommentAccess, D1Dialect, Kysely } = await loadBridgeRuntime();
		const db = new Kysely<Database>({ dialect: new D1Dialect({ database: this.env.DB }) });
		return createCommentAccess(db).list(opts);
	}

	async commentCount(opts: CommentCountOptions = {}): Promise<number> {
		if (!this.ctx.props.capabilities.includes("comments:read")) {
			throw new Error("Missing capability: comments:read");
		}
		const { createCommentAccess, D1Dialect, Kysely } = await loadBridgeRuntime();
		const db = new Kysely<Database>({ dialect: new D1Dialect({ database: this.env.DB }) });
		return createCommentAccess(db).count(opts);
	}

	async commentSetStatus(
		id: string,
		status: PluginCommentStatus,
		expectedStatus: PluginCommentStatus,
	): Promise<
		| PluginComment
		| {
				__emdashCommentError: {
					code:
						| "COMMENT_STATUS_CONFLICT"
						| "COMMENT_MODERATION_IN_PROGRESS"
						| "COMMENT_STATUS_INVALID";
					message: string;
					currentStatus?: string;
				};
		  }
	> {
		if (!this.ctx.props.capabilities.includes("comments:moderate")) {
			throw new Error("Missing capability: comments:moderate");
		}
		const invalid =
			invalidCommentStatus(status, "status") ??
			invalidCommentStatus(expectedStatus, "expectedStatus");
		if (invalid) {
			return {
				__emdashCommentError: {
					code: "COMMENT_STATUS_INVALID",
					message: invalid,
				},
			};
		}
		if (!commentModerateCallback) throw new Error("Comment moderation is unavailable");
		try {
			return await commentModerateCallback(this.ctx.props.pluginId, id, status, expectedStatus);
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error) {
				const code = error.code;
				const currentStatus = "currentStatus" in error ? error.currentStatus : undefined;
				if (
					(code === "COMMENT_STATUS_CONFLICT" && typeof currentStatus === "string") ||
					code === "COMMENT_MODERATION_IN_PROGRESS"
				) {
					return {
						__emdashCommentError: {
							code,
							message: error instanceof Error ? error.message : "Comment moderation failed",
							...(typeof currentStatus === "string" ? { currentStatus } : {}),
						},
					};
				}
			}
			throw error;
		}
	}

	private requireContentActions(capability: "content:publish" | "content:restore") {
		if (!this.ctx.props.capabilities.includes(capability)) {
			throw new Error(`Missing capability: ${capability}`);
		}
		const runtimeId = this.ctx.props.contentActionsRuntimeId;
		const callbacks = runtimeId ? contentActionCallbacks().get(runtimeId) : undefined;
		if (!callbacks) throw new Error("Content actions are not configured");
		return callbacks;
	}

	contentGetVersioned(collection: string, id: string) {
		return forwardContentAction(() =>
			this.requireContentActions("content:publish").getVersioned(
				this.ctx.props.pluginId,
				collection,
				id,
			),
		);
	}

	contentPublish(collection: string, id: string, revision: string, invocationId?: string) {
		return forwardContentAction(() =>
			this.requireContentActions("content:publish").publish(
				this.ctx.props.pluginId,
				collection,
				id,
				{ _rev: revision },
				invocationId,
			),
		);
	}

	contentUnpublish(collection: string, id: string, revision: string, invocationId?: string) {
		return forwardContentAction(() =>
			this.requireContentActions("content:publish").unpublish(
				this.ctx.props.pluginId,
				collection,
				id,
				{ _rev: revision },
				invocationId,
			),
		);
	}

	contentSchedule(
		collection: string,
		id: string,
		scheduledAt: string,
		revision: string,
		invocationId?: string,
	) {
		return forwardContentAction(() =>
			this.requireContentActions("content:publish").schedule(
				this.ctx.props.pluginId,
				collection,
				id,
				{ scheduledAt, _rev: revision },
				invocationId,
			),
		);
	}

	contentUnschedule(collection: string, id: string, revision: string, invocationId?: string) {
		return forwardContentAction(() =>
			this.requireContentActions("content:publish").unschedule(
				this.ctx.props.pluginId,
				collection,
				id,
				{ _rev: revision },
				invocationId,
			),
		);
	}

	contentGetTrashedVersioned(collection: string, id: string) {
		return forwardContentAction(() =>
			this.requireContentActions("content:restore").getTrashedVersioned(
				this.ctx.props.pluginId,
				collection,
				id,
			),
		);
	}

	contentRestore(collection: string, id: string, revision: string, invocationId?: string) {
		return forwardContentAction(() =>
			this.requireContentActions("content:restore").restore(
				this.ctx.props.pluginId,
				collection,
				id,
				{ _rev: revision },
				invocationId,
			),
		);
	}

	// =========================================================================
	// Taxonomy Operations - capability-gated
	// =========================================================================

	async taxonomyList(opts: { locale?: string } = {}): Promise<
		Array<{
			name: string;
			label: string;
			labelSingular: string | null;
			hierarchical: boolean;
			collections: string[];
			locale: string;
		}>
	> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("taxonomies:read")) {
			throw new Error("Missing capability: taxonomies:read");
		}
		let sql = "SELECT * FROM _emdash_taxonomy_defs";
		const params: unknown[] = [];
		if (opts.locale !== undefined) {
			sql += " WHERE locale = ?";
			params.push(opts.locale);
		}
		sql += " ORDER BY name ASC";
		const results = await this.env.DB.prepare(sql)
			.bind(...params)
			.all();
		return (results.results ?? []).map((row) => ({
			name: columnString(row.name),
			label: columnString(row.label),
			labelSingular: columnNullableString(row.label_singular),
			hierarchical: row.hierarchical === 1,
			collections: columnStringArray(row.collections),
			locale: columnString(row.locale),
		}));
	}

	async taxonomyTerms(
		taxonomy: string,
		opts: { locale?: string } = {},
	): Promise<
		Array<{
			id: string;
			taxonomy: string;
			slug: string;
			label: string;
			parentId: string | null;
			data: Record<string, unknown> | null;
			locale: string;
			translationGroup: string | null;
		}>
	> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("taxonomies:read")) {
			throw new Error("Missing capability: taxonomies:read");
		}
		let sql = "SELECT * FROM taxonomies WHERE name = ?";
		const params: unknown[] = [taxonomy];
		if (opts.locale !== undefined) {
			sql += " AND locale = ?";
			params.push(opts.locale);
		}
		// Manual order first, then label with `id ASC` as a stable tiebreaker for
		// terms sharing both — matching core's TaxonomyRepository.findByName.
		sql += " ORDER BY sort_order ASC, label ASC, id ASC";
		const results = await this.env.DB.prepare(sql)
			.bind(...params)
			.all();
		return (results.results ?? []).map(rowToTaxonomyTerm);
	}

	async taxonomyEntryTerms(
		collection: string,
		entryId: string,
		opts: { taxonomy?: string; locale?: string } = {},
	): Promise<
		Array<{
			id: string;
			taxonomy: string;
			slug: string;
			label: string;
			parentId: string | null;
			data: Record<string, unknown> | null;
			locale: string;
			translationGroup: string | null;
		}>
	> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("taxonomies:read")) {
			throw new Error("Missing capability: taxonomies:read");
		}
		// The pivot stores the term's translation_group in taxonomy_id, so the
		// join resolves an assignment into each locale's term row.
		let sql =
			"SELECT taxonomies.* FROM content_taxonomies " +
			"JOIN taxonomies ON taxonomies.translation_group = content_taxonomies.taxonomy_id " +
			"WHERE content_taxonomies.collection = ? AND content_taxonomies.entry_id = ?";
		const params: unknown[] = [collection, entryId];
		if (opts.taxonomy !== undefined) {
			sql += " AND taxonomies.name = ?";
			params.push(opts.taxonomy);
		}
		if (opts.locale !== undefined) {
			sql += " AND taxonomies.locale = ?";
			params.push(opts.locale);
		}
		sql += " ORDER BY taxonomies.locale ASC";
		const results = await this.env.DB.prepare(sql)
			.bind(...params)
			.all();
		return (results.results ?? []).map(rowToTaxonomyTerm);
	}

	async taxonomyCreateTerm(
		taxonomy: string,
		input: Parameters<TaxonomyAccessWithWrite["createTerm"]>[1],
	) {
		return this.getTaxonomyWriteAccess().createTerm(taxonomy, input);
	}

	async taxonomyAddEntryTerms(
		collection: string,
		entryId: string,
		taxonomy: string,
		termIds: string[],
	) {
		return this.getTaxonomyWriteAccess().addEntryTerms(collection, entryId, taxonomy, termIds);
	}

	async taxonomyRemoveEntryTerms(
		collection: string,
		entryId: string,
		taxonomy: string,
		termIds: string[],
	) {
		return this.getTaxonomyWriteAccess().removeEntryTerms(collection, entryId, taxonomy, termIds);
	}

	private getTaxonomyWriteAccess(): TaxonomyAccessWithWrite {
		if (!this.ctx.props.capabilities.includes("taxonomies:write")) {
			throw new Error("Missing capability: taxonomies:write");
		}
		const runtimeId = this.ctx.props.taxonomyWriteRuntimeId;
		const access = runtimeId ? taxonomyWriteCallbacks().get(runtimeId) : undefined;
		if (!access) throw new Error("Taxonomy mutations are not available");
		return access;
	}

	// =========================================================================
	// Redirect Operations - runtime-owned, capability-gated
	// =========================================================================

	async redirectList(
		options: RedirectListOptions = {},
	): Promise<RedirectBridgeResult<PaginatedResult<RedirectInfo>>> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("redirects:read")) {
			throw new Error("Missing capability: redirects:read");
		}
		const { createRedirectAccess, D1Dialect, Kysely } = await loadBridgeRuntime();
		const db = new Kysely<Database>({ dialect: new D1Dialect({ database: this.env.DB }) });
		return redirectBridgeResult(() => createRedirectAccess(db).list(options));
	}

	async redirectGet(id: string): Promise<RedirectBridgeResult<VersionedRedirect | null>> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("redirects:read")) {
			throw new Error("Missing capability: redirects:read");
		}
		const { createRedirectAccess, D1Dialect, Kysely } = await loadBridgeRuntime();
		const db = new Kysely<Database>({ dialect: new D1Dialect({ database: this.env.DB }) });
		return redirectBridgeResult(() => createRedirectAccess(db).get(id));
	}

	async redirectCreate(
		input: RedirectCreateInput,
	): Promise<RedirectBridgeResult<VersionedRedirect>> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("redirects:write")) {
			throw new Error("Missing capability: redirects:write");
		}
		const { createRedirectAccess, D1Dialect, Kysely } = await loadBridgeRuntime();
		const db = new Kysely<Database>({ dialect: new D1Dialect({ database: this.env.DB }) });
		return redirectBridgeResult(() => createRedirectAccess(db, true).create(input));
	}

	async redirectUpdate(
		id: string,
		input: RedirectUpdateInput & { _rev: string },
	): Promise<RedirectBridgeResult<VersionedRedirect>> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("redirects:write")) {
			throw new Error("Missing capability: redirects:write");
		}
		const { createRedirectAccess, D1Dialect, Kysely } = await loadBridgeRuntime();
		const db = new Kysely<Database>({ dialect: new D1Dialect({ database: this.env.DB }) });
		return redirectBridgeResult(() => createRedirectAccess(db, true).update(id, input));
	}

	async redirectDelete(id: string, revision: string): Promise<RedirectBridgeResult<boolean>> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("redirects:write")) {
			throw new Error("Missing capability: redirects:write");
		}
		const { createRedirectAccess, D1Dialect, Kysely } = await loadBridgeRuntime();
		const db = new Kysely<Database>({ dialect: new D1Dialect({ database: this.env.DB }) });
		return redirectBridgeResult(() =>
			createRedirectAccess(db, true).delete(id, { _rev: revision }),
		);
	}

	// =========================================================================
	// Media Operations - capability-gated
	// =========================================================================

	async mediaGet(id: string): Promise<PluginMediaItem | null> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("media:read")) {
			throw new Error("Missing capability: media:read");
		}
		const { createMediaAccess, D1Dialect, Kysely } = await loadBridgeRuntime();
		const db = new Kysely<Database>({ dialect: new D1Dialect({ database: this.env.DB }) });
		return createMediaAccess(db).get(id);
	}

	async mediaList(
		opts: { limit?: number; cursor?: string; mimeType?: string } = {},
	): Promise<{ items: PluginMediaItem[]; cursor?: string; hasMore: boolean }> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("media:read")) {
			throw new Error("Missing capability: media:read");
		}
		const { createMediaAccess, D1Dialect, Kysely } = await loadBridgeRuntime();
		const db = new Kysely<Database>({ dialect: new D1Dialect({ database: this.env.DB }) });
		return createMediaAccess(db).list(opts);
	}

	async mediaReadBytes(id: string, maxBytes?: number): Promise<MediaBytes> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("media:bytes:read")) {
			throw new Error("Missing capability: media:bytes:read");
		}
		if (maxBytes !== undefined && typeof maxBytes !== "number") {
			throw new TypeError("media/readBytes: maxBytes must be a number");
		}
		const { D1Dialect, Kysely, readPluginMediaBytes } = await loadBridgeRuntime();
		const db = new Kysely<Database>({ dialect: new D1Dialect({ database: this.env.DB }) });
		return readPluginMediaBytes(db, mediaStorageCallback ?? undefined, id, { maxBytes });
	}

	async mediaUpdateMetadata(id: string, patch: unknown): Promise<PluginMediaItem> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("media:metadata:write")) {
			throw new Error("Missing capability: media:metadata:write");
		}
		const { D1Dialect, Kysely, parsePluginMediaMetadataPatch, updatePluginMediaMetadata } =
			await loadBridgeRuntime();
		const parsed: MediaMetadataPatch = parsePluginMediaMetadataPatch(patch);
		const db = new Kysely<Database>({ dialect: new D1Dialect({ database: this.env.DB }) });
		return updatePluginMediaMetadata(db, id, parsed);
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
		if (!capabilities.includes("media:write")) {
			throw new Error("Missing capability: media:write");
		}

		if (!this.env.MEDIA) {
			throw new Error("Media storage (R2) not configured. Add MEDIA binding to wrangler config.");
		}
		const { ulid } = await loadBridgeRuntime();

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
		if (!capabilities.includes("media:write")) {
			throw new Error("Missing capability: media:write");
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
		return sandboxHttpFetch(url, init, { capabilities, allowedHosts });
	}

	// =========================================================================
	// User Operations - capability-gated (users:read)
	// =========================================================================

	async userGet(id: string): Promise<{
		id: string;
		email: string;
		name: string | null;
		role: number;
		createdAt: string;
	} | null> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("users:read")) {
			throw new Error("Missing capability: users:read");
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
		if (!capabilities.includes("users:read")) {
			throw new Error("Missing capability: users:read");
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
		if (!capabilities.includes("users:read")) {
			throw new Error("Missing capability: users:read");
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

	async cronSchedule(
		name: string,
		opts: { schedule: string; data?: Record<string, unknown> },
	): Promise<void> {
		const { CronAccessImpl, D1Dialect, Kysely } = await loadBridgeRuntime();
		const db = new Kysely<Database>({ dialect: new D1Dialect({ database: this.env.DB }) });
		await new CronAccessImpl(
			db,
			this.ctx.props.pluginId,
			() => cronRescheduleCallback?.(),
			cronNowCallback ?? undefined,
		).schedule(name, opts);
	}

	async cronCancel(name: string): Promise<void> {
		const { CronAccessImpl, D1Dialect, Kysely } = await loadBridgeRuntime();
		const db = new Kysely<Database>({ dialect: new D1Dialect({ database: this.env.DB }) });
		await new CronAccessImpl(db, this.ctx.props.pluginId, () => cronRescheduleCallback?.()).cancel(
			name,
		);
	}

	async cronList(): Promise<CronTaskInfo[]> {
		const { CronAccessImpl, D1Dialect, Kysely } = await loadBridgeRuntime();
		const db = new Kysely<Database>({ dialect: new D1Dialect({ database: this.env.DB }) });
		return new CronAccessImpl(db, this.ctx.props.pluginId, () => cronRescheduleCallback?.()).list();
	}

	// =========================================================================
	// Logging
	// =========================================================================

	log(level: "debug" | "info" | "warn" | "error", msg: string, data?: unknown): void {
		const { pluginId } = this.ctx.props;
		console[level](
			`[plugin:${pluginId}]`,
			this.secretRedactor.redact(msg),
			this.secretRedactor.redact(data ?? ""),
		);
	}
}
