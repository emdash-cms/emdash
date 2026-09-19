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

import { Buffer } from "node:buffer";

import {
	ContentRepository,
	CronAccessImpl,
	createCommentAccess,
	createContentAccess,
	createRedirectAccess,
	createSchemaAccess,
	createHttpAccess,
	createPluginSecretRedactor,
	createSettingsAccess,
	createMediaAccess,
	createSandboxRouteErrorEnvelope,
	createUnrestrictedHttpAccess,
	normalizeCapabilities,
	OptionsRepository,
	parsePluginMediaMetadataPatch,
	PluginStorageRepository,
	readPluginMediaBytes,
	RedirectAccessError,
	StorageSerializationError,
	resolveContentCreateLocale,
	updatePluginMediaMetadata,
} from "emdash";
import type {
	ContentActionCallbacks,
	ContentFieldFilters,
	ContentListOptions,
	Database,
	I18nConfig,
	CommentListOptions,
	PluginCommentStatus,
	SandboxCommentModerateCallback,
	RedirectCreateInput,
	RedirectListOptions,
	RedirectUpdateInput,
	SandboxEmailSendCallback,
	PluginSecretRedactor,
	SettingField,
	SandboxContentCreateCallback,
	SiteInfo,
	TaxonomyAccessWithWrite,
} from "emdash";
import type { Kysely } from "kysely";

const CONTENT_CREATE_ERROR_CODES = new Set([
	"CONFLICT",
	"NOT_FOUND",
	"SAVE_REJECTED",
	"VALIDATION_ERROR",
]);

function contentCreateErrorDetails(error: unknown): { code: string; message: string } | null {
	if (!(error instanceof Error) || !isRecord(error)) return null;
	const code = error.code;
	return typeof code === "string" && CONTENT_CREATE_ERROR_CODES.has(code)
		? { code, message: error.message }
		: null;
}

const CONTENT_ACTION_ERROR_CODE_REGEX = /^[A-Z][A-Z0-9_]*$/;
const CONTENT_ACTION_METHODS = new Set([
	"content/getVersioned",
	"content/publish",
	"content/unpublish",
	"content/schedule",
	"content/unschedule",
	"content/getTrashedVersioned",
	"content/restore",
]);

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
	locale: string;
	translation_group: string | null;
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
	"locale",
	"translation_group",
]);

/** Minimal storage interface for sandboxed media operations. */
export interface BridgeStorage {
	upload(options: { key: string; body: Uint8Array; contentType: string }): Promise<unknown>;
	download(key: string): Promise<{
		body: ReadableStream<Uint8Array>;
		contentType: string;
		size: number;
	}>;
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
	settingsSchema?: Record<string, SettingField>;
	secretRedactor?: PluginSecretRedactor;
	i18nConfig?: I18nConfig | null;
	siteInfo?: SiteInfo;
	db: Kysely<Database>;
	beforeContentWrite?: () => Promise<void>;
	contentCreate?: SandboxContentCreateCallback;
	contentCreateProvider?: () => SandboxContentCreateCallback | null;
	taxonomyWrite?: TaxonomyAccessWithWrite;
	contentActions?: () => ContentActionCallbacks | null;
	emailSend: () => SandboxEmailSendCallback | null;
	commentModerate?: () => SandboxCommentModerateCallback | null;
	cronReschedule?: () => void;
	now?: () => Date;
	/** Storage for media uploads. Optional; media/upload throws if not provided. */
	storage?: BridgeStorage | null;
}

type RedirectBridgeResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: { code: string; message: string } };

async function redirectBridgeResult<T>(action: () => Promise<T>): Promise<RedirectBridgeResult<T>> {
	try {
		return { ok: true, value: await action() };
	} catch (error) {
		if (error instanceof RedirectAccessError) {
			return { ok: false, error: { code: error.code, message: error.message } };
		}
		throw error;
	}
}

/**
 * Create a bridge handler function scoped to a specific plugin.
 * Returns an async function that takes a Request and returns a Response.
 */
export function createBridgeHandler(
	opts: BridgeHandlerOptions,
): (request: Request) => Promise<Response> {
	const capabilities = normalizeCapabilities(opts.capabilities);
	if (capabilities.includes("comments:moderate") && !capabilities.includes("comments:read")) {
		capabilities.push("comments:read");
	}
	const normalizedOpts = {
		...opts,
		capabilities,
		secretRedactor: opts.secretRedactor ?? createPluginSecretRedactor(),
	};
	return async (request: Request): Promise<Response> => {
		let method = "";
		try {
			const url = new URL(request.url);
			method = url.pathname.slice(1);

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

			const result = await dispatch(normalizedOpts, method, body);
			return Response.json({ result });
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error) {
				const code = error.code;
				const currentStatus = "currentStatus" in error ? error.currentStatus : undefined;
				if (
					(code === "COMMENT_STATUS_CONFLICT" && typeof currentStatus === "string") ||
					code === "COMMENT_MODERATION_IN_PROGRESS" ||
					code === "COMMENT_STATUS_INVALID"
				) {
					return Response.json(
						{
							error: {
								code,
								message: error instanceof Error ? error.message : "Comment moderation failed",
								...(typeof currentStatus === "string" ? { currentStatus } : {}),
							},
						},
						{ status: 409 },
					);
				}
			}
			const sandboxRouteError = createSandboxRouteErrorEnvelope(error);
			if (sandboxRouteError) {
				return Response.json(
					{ error: sandboxRouteError.error },
					{ status: sandboxRouteError.error.status },
				);
			}
			if (error instanceof StorageSerializationError) {
				return Response.json(
					{
						error: {
							name: "StorageSerializationError",
							code: "STORAGE_SERIALIZATION_FAILURE",
							retryable: true,
							...(error.sqlState === "40001" || error.sqlState === "40P01"
								? { sqlState: error.sqlState }
								: {}),
							message:
								"Storage write must be retried. Restart the transaction before retrying when using an explicit transaction.",
						},
					},
					{ status: 503 },
				);
			}
			const contentCreateError = CONTENT_ACTION_METHODS.has(method)
				? null
				: contentCreateErrorDetails(error);
			if (contentCreateError) {
				const status =
					contentCreateError.code === "NOT_FOUND"
						? 404
						: contentCreateError.code === "CONFLICT"
							? 409
							: 400;
				return Response.json(
					{ error: { name: contentCreateError.code, ...contentCreateError } },
					{ status },
				);
			}
			if (
				CONTENT_ACTION_METHODS.has(method) &&
				error instanceof Error &&
				"code" in error &&
				typeof error.code === "string" &&
				CONTENT_ACTION_ERROR_CODE_REGEX.test(error.code)
			) {
				return Response.json({
					result: {
						__emdashContentActionError: true,
						error: { code: error.code, message: error.message },
					},
				});
			}
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
			return kvGet(
				db,
				pluginId,
				requireString(body, "key"),
				opts.settingsSchema,
				opts.secretRedactor,
			);
		case "kv/set":
			return kvSet(
				db,
				pluginId,
				requireString(body, "key"),
				body.value,
				opts.settingsSchema,
				opts.secretRedactor,
			);
		case "kv/getVersioned":
			return kvGetVersioned(db, pluginId, requireString(body, "key"), opts);
		case "kv/compareAndSet":
			return kvCompareAndSet(
				db,
				pluginId,
				requireString(body, "key"),
				requireExpectedRevision(body),
				body.value,
				opts,
			);
		case "kv/compareAndDelete":
			return kvCompareAndDelete(
				db,
				pluginId,
				requireString(body, "key"),
				requireString(body, "expectedRevision"),
				opts,
			);
		case "kv/delete":
			return kvDelete(
				db,
				pluginId,
				requireString(body, "key"),
				opts.settingsSchema,
				opts.secretRedactor,
			);
		case "kv/list":
			return kvList(
				db,
				pluginId,
				optionalString(body, "prefix") ?? "",
				opts.settingsSchema,
				opts.secretRedactor,
			);
		case "settings/get":
			return kvGet(
				db,
				pluginId,
				`${SETTINGS_KEY_PREFIX}${requireString(body, "key")}`,
				opts.settingsSchema,
				opts.secretRedactor,
			);
		case "settings/set":
			return kvSet(
				db,
				pluginId,
				`${SETTINGS_KEY_PREFIX}${requireString(body, "key")}`,
				body.value,
				opts.settingsSchema,
				opts.secretRedactor,
			);
		case "settings/getVersioned":
			return kvGetVersioned(
				db,
				pluginId,
				`${SETTINGS_KEY_PREFIX}${requireString(body, "key")}`,
				opts,
			);
		case "settings/compareAndSet":
			return kvCompareAndSet(
				db,
				pluginId,
				`${SETTINGS_KEY_PREFIX}${requireString(body, "key")}`,
				requireExpectedRevision(body),
				body.value,
				opts,
			);
		case "settings/compareAndDelete":
			return kvCompareAndDelete(
				db,
				pluginId,
				`${SETTINGS_KEY_PREFIX}${requireString(body, "key")}`,
				requireString(body, "expectedRevision"),
				opts,
			);
		case "settings/delete":
			return kvDelete(
				db,
				pluginId,
				`${SETTINGS_KEY_PREFIX}${requireString(body, "key")}`,
				opts.settingsSchema,
				opts.secretRedactor,
			);
		case "settings/list": {
			const entries = await kvList(
				db,
				pluginId,
				`${SETTINGS_KEY_PREFIX}${optionalString(body, "prefix") ?? ""}`,
				opts.settingsSchema,
				opts.secretRedactor,
			);
			return entries.map(({ key, value }) => ({
				key: key.slice(SETTINGS_KEY_PREFIX.length),
				value,
			}));
		}

		// ── Content ─────────────────────────────────────────────────────
		case "content/get":
			requireCapability(opts, "content:read");
			return contentGet(db, requireString(body, "collection"), requireString(body, "id"), opts);
		case "content/list":
			requireCapability(opts, "content:read");
			return contentList(db, requireString(body, "collection"), body, opts);
		case "content/translations":
			requireCapability(opts, "content:read");
			return contentAccess(opts).getTranslations!(
				requireString(body, "collection"),
				requireString(body, "id"),
			);
		case "content/publicUrl":
			requireCapability(opts, "content:read");
			return contentAccess(opts).getPublicUrl!(
				requireString(body, "collection"),
				requireString(body, "id"),
			);
		case "content/listRevisions":
			requireCapability(opts, "content:revisions:read");
			return contentAccess(opts).listRevisions!(
				requireString(body, "collection"),
				requireString(body, "id"),
				optionalRecord(body, "options") ?? undefined,
			);
		case "content/getRevision":
			requireCapability(opts, "content:revisions:read");
			return contentAccess(opts).getRevision!(
				requireString(body, "collection"),
				requireString(body, "id"),
				requireString(body, "revisionId"),
			);
		case "schema/listCollections":
			requireCapability(opts, "schema:read");
			return createSchemaAccess(db).listCollections();
		case "schema/getCollection":
			requireCapability(opts, "schema:read");
			return createSchemaAccess(db).getCollection(requireString(body, "slug"));
		case "content/create":
			requireCapability(opts, "content:write");
			const createOptions = optionalRecord(body, "options");
			let locale: string;
			try {
				locale = resolveContentCreateLocale(
					createOptions ? optionalString(createOptions, "locale") : undefined,
					opts.i18nConfig ?? null,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : "Invalid locale";
				throw Object.assign(new Error(message), {
					name: "VALIDATION_ERROR",
					code: "VALIDATION_ERROR",
				});
			}
			await opts.beforeContentWrite?.();
			const runtimeContentCreate = opts.contentCreateProvider?.() ?? opts.contentCreate;
			if (runtimeContentCreate) {
				const originHookValue = optionalString(body, "originHook");
				const originHook =
					originHookValue === "content:beforeSave" || originHookValue === "content:afterSave"
						? originHookValue
						: undefined;
				return runtimeContentCreate(
					pluginId,
					requireString(body, "collection"),
					requireRecord(body, "data"),
					{
						locale,
						translationOf: createOptions
							? optionalString(createOptions, "translationOf")
							: undefined,
						originHook,
						sandboxOrigin: true,
					},
				);
			}
			return contentCreate(
				db,
				requireString(body, "collection"),
				requireRecord(body, "data"),
				locale,
			);
		case "content/update":
			requireCapability(opts, "content:write");
			await opts.beforeContentWrite?.();
			return contentUpdate(
				db,
				requireString(body, "collection"),
				requireString(body, "id"),
				requireRecord(body, "data"),
			);
		case "content/delete":
			requireCapability(opts, "content:write");
			await opts.beforeContentWrite?.();
			return contentDelete(db, requireString(body, "collection"), requireString(body, "id"));
		case "content/getVersioned":
			requireCapability(opts, "content:publish");
			return requireContentActions(opts).getVersioned(
				pluginId,
				requireString(body, "collection"),
				requireString(body, "id"),
			);
		case "content/publish":
			requireCapability(opts, "content:publish");
			return requireContentActions(opts).publish(
				pluginId,
				requireString(body, "collection"),
				requireString(body, "id"),
				{ _rev: requireString(body, "revision") },
				optionalString(body, "invocationId"),
			);
		case "content/unpublish":
			requireCapability(opts, "content:publish");
			return requireContentActions(opts).unpublish(
				pluginId,
				requireString(body, "collection"),
				requireString(body, "id"),
				{ _rev: requireString(body, "revision") },
				optionalString(body, "invocationId"),
			);
		case "content/schedule":
			requireCapability(opts, "content:publish");
			return requireContentActions(opts).schedule(
				pluginId,
				requireString(body, "collection"),
				requireString(body, "id"),
				{
					scheduledAt: requireString(body, "scheduledAt"),
					_rev: requireString(body, "revision"),
				},
				optionalString(body, "invocationId"),
			);
		case "content/unschedule":
			requireCapability(opts, "content:publish");
			return requireContentActions(opts).unschedule(
				pluginId,
				requireString(body, "collection"),
				requireString(body, "id"),
				{ _rev: requireString(body, "revision") },
				optionalString(body, "invocationId"),
			);
		case "content/getTrashedVersioned":
			requireCapability(opts, "content:restore");
			return requireContentActions(opts).getTrashedVersioned(
				pluginId,
				requireString(body, "collection"),
				requireString(body, "id"),
			);
		case "content/restore":
			requireCapability(opts, "content:restore");
			return requireContentActions(opts).restore(
				pluginId,
				requireString(body, "collection"),
				requireString(body, "id"),
				{ _rev: requireString(body, "revision") },
				optionalString(body, "invocationId"),
			);
		case "content/createMany":
			requireCapability(opts, "content:write");
			const createManyLocale = resolveContentCreateLocale(undefined, opts.i18nConfig ?? null);
			await opts.beforeContentWrite?.();
			return contentCreateMany(
				db,
				requireString(body, "collection"),
				requireRecordArray(body, "items"),
				createManyLocale,
			);
		case "content/updateMany":
			requireCapability(opts, "content:write");
			await opts.beforeContentWrite?.();
			return contentUpdateMany(
				db,
				requireString(body, "collection"),
				requireUpdateManyItems(body, "items"),
			);
		case "content/deleteMany":
			requireCapability(opts, "content:write");
			await opts.beforeContentWrite?.();
			return contentDeleteMany(
				db,
				requireString(body, "collection"),
				requireStringArray(body, "ids"),
			);

		// ── Comments ────────────────────────────────────────────────────
		case "comments/get":
			requireCapability(opts, "comments:read");
			return createCommentAccess(db).get(requireString(body, "id"));
		case "comments/list":
			requireCapability(opts, "comments:read");
			return createCommentAccess(db).list(commentListOptions(body));
		case "comments/count":
			requireCapability(opts, "comments:read");
			return createCommentAccess(db).count(commentCountOptions(body));
		case "comments/setStatus": {
			requireCapability(opts, "comments:moderate");
			const moderate = opts.commentModerate?.();
			if (!moderate) throw new Error("Comment moderation is unavailable");
			return moderate(
				pluginId,
				requireString(body, "id"),
				requireCommentStatus(body, "status"),
				requireCommentStatus(body, "expectedStatus"),
			);
		}

		// ── Taxonomies ──────────────────────────────────────────────────
		// `taxonomies:read` is a post-rename capability: it has no legacy
		// alias, so the canonical name is checked directly.
		case "taxonomy/list":
			requireCapability(opts, "taxonomies:read");
			return taxonomyList(db, optionalString(body, "locale"));
		case "taxonomy/terms":
			requireCapability(opts, "taxonomies:read");
			return taxonomyTerms(db, requireString(body, "taxonomy"), optionalString(body, "locale"));
		case "taxonomy/entryTerms":
			requireCapability(opts, "taxonomies:read");
			return taxonomyEntryTerms(
				db,
				requireString(body, "collection"),
				requireString(body, "entryId"),
				optionalString(body, "taxonomy"),
				optionalString(body, "locale"),
			);
		case "taxonomy/createTerm":
			requireCapability(opts, "taxonomies:write");
			if (!opts.taxonomyWrite) throw new Error("Taxonomy mutations are not available");
			return opts.taxonomyWrite.createTerm(
				requireString(body, "taxonomy"),
				requireTaxonomyTermCreateInput(body, "input"),
			);
		case "taxonomy/addEntryTerms":
			requireCapability(opts, "taxonomies:write");
			if (!opts.taxonomyWrite) throw new Error("Taxonomy mutations are not available");
			return opts.taxonomyWrite.addEntryTerms(
				requireString(body, "collection"),
				requireString(body, "entryId"),
				requireString(body, "taxonomy"),
				requireStringArray(body, "termIds"),
			);
		case "taxonomy/removeEntryTerms":
			requireCapability(opts, "taxonomies:write");
			if (!opts.taxonomyWrite) throw new Error("Taxonomy mutations are not available");
			return opts.taxonomyWrite.removeEntryTerms(
				requireString(body, "collection"),
				requireString(body, "entryId"),
				requireString(body, "taxonomy"),
				requireStringArray(body, "termIds"),
			);

		// ── Redirects ─────────────────────────────────────────────────────
		case "redirect/list":
			requireCapability(opts, "redirects:read");
			return redirectBridgeResult(() =>
				createRedirectAccess(db).list(requireRedirectListOptions(body)),
			);
		case "redirect/get":
			requireCapability(opts, "redirects:read");
			return redirectBridgeResult(() => createRedirectAccess(db).get(requireString(body, "id")));
		case "redirect/create":
			requireCapability(opts, "redirects:write");
			return redirectBridgeResult(() =>
				createRedirectAccess(db, true).create(requireRedirectCreateInput(body)),
			);
		case "redirect/update":
			requireCapability(opts, "redirects:write");
			return redirectBridgeResult(() =>
				createRedirectAccess(db, true).update(
					requireString(body, "id"),
					requireRedirectUpdateInput(body),
				),
			);
		case "redirect/delete":
			requireCapability(opts, "redirects:write");
			return redirectBridgeResult(() =>
				createRedirectAccess(db, true).delete(requireString(body, "id"), {
					_rev: requireString(body, "revision"),
				}),
			);

		// ── Media ───────────────────────────────────────────────────────
		case "media/get":
			requireCapability(opts, "media:read");
			return mediaGet(db, requireString(body, "id"));
		case "media/list":
			requireCapability(opts, "media:read");
			return mediaList(db, body);
		case "media/readBytes": {
			requireCapability(opts, "media:bytes:read");
			const maxBytes = body.maxBytes;
			if (maxBytes !== undefined && typeof maxBytes !== "number") {
				throw new TypeError("media/readBytes: maxBytes must be a number");
			}
			const result = await readPluginMediaBytes(
				db,
				opts.storage ?? undefined,
				requireString(body, "id"),
				{ maxBytes },
			);
			return {
				...result,
				bytes: Buffer.from(result.bytes).toString("base64"),
				encoding: "base64",
			};
		}
		case "media/updateMetadata":
			requireCapability(opts, "media:metadata:write");
			return updatePluginMediaMetadata(
				db,
				requireString(body, "id"),
				parsePluginMediaMetadataPatch(body.patch),
			);
		case "media/upload":
			requireCapability(opts, "media:write");
			return mediaUpload(
				db,
				requireString(body, "filename"),
				requireString(body, "contentType"),
				requireMediaBytes(body, "bytes"),
				optionalString(body, "encoding"),
				opts.storage,
			);
		case "media/delete":
			requireCapability(opts, "media:write");
			return mediaDelete(db, requireString(body, "id"), opts.storage);

		// ── HTTP ────────────────────────────────────────────────────────
		case "http/fetch":
			requireCapability(opts, "network:request");
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
			requireCapability(opts, "users:read");
			return userGet(db, requireString(body, "id"));
		case "users/getByEmail":
			requireCapability(opts, "users:read");
			return userGetByEmail(db, requireString(body, "email"));
		case "users/list":
			requireCapability(opts, "users:read");
			return userList(db, body);

		// ── Cron ────────────────────────────────────────────────────────
		case "cron/schedule":
			return new CronAccessImpl(
				db,
				pluginId,
				opts.cronReschedule ?? (() => undefined),
				opts.now,
			).schedule(requireString(body, "name"), {
				schedule: requireString(body, "schedule"),
				data: optionalRecord(body, "data"),
			});
		case "cron/cancel":
			return new CronAccessImpl(db, pluginId, opts.cronReschedule ?? (() => undefined)).cancel(
				requireString(body, "name"),
			);
		case "cron/list":
			return new CronAccessImpl(db, pluginId, opts.cronReschedule ?? (() => undefined)).list();

		// ── Storage (document store, scoped to declared collections) ────
		case "storage/get":
			validateStorageCollection(opts, requireString(body, "collection"));
			return storageGet(opts, requireString(body, "collection"), requireString(body, "id"));
		case "storage/getVersioned":
			validateStorageCollection(opts, requireString(body, "collection"));
			return getStorageRepo(opts, requireString(body, "collection")).getVersioned(
				requireString(body, "id"),
			);
		case "storage/compareAndSet":
			validateStorageCollection(opts, requireString(body, "collection"));
			return getStorageRepo(opts, requireString(body, "collection")).compareAndSet(
				requireString(body, "id"),
				requireExpectedRevision(body),
				body.data,
			);
		case "storage/compareAndDelete":
			validateStorageCollection(opts, requireString(body, "collection"));
			return getStorageRepo(opts, requireString(body, "collection")).compareAndDelete(
				requireString(body, "id"),
				requireString(body, "expectedRevision"),
			);
		case "storage/updateIf":
			validateStorageCollection(opts, requireString(body, "collection"));
			return getStorageRepo(opts, requireString(body, "collection")).updateIf(
				requireString(body, "id"),
				body.args,
			);
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
			console[level](
				`[plugin:${pluginId}]`,
				opts.secretRedactor?.redact(msg) ?? msg,
				opts.secretRedactor?.redact(body.data ?? "") ?? body.data ?? "",
			);
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
const COMMENT_STATUSES = new Set<string>(["approved", "pending", "spam"]);

function requireExpectedRevision(body: Record<string, unknown>): string | null {
	const value = body.expectedRevision;
	if (value === null || typeof value === "string") return value;
	throw new Error("expectedRevision must be a string or null");
}

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

const REDIRECT_STATUSES = new Set([301, 302, 307, 308, 410, 451]);

function hasOptionalString(value: Record<string, unknown>, key: string): boolean {
	return value[key] === undefined || typeof value[key] === "string";
}

function hasOptionalNullableString(value: Record<string, unknown>, key: string): boolean {
	return value[key] === undefined || value[key] === null || typeof value[key] === "string";
}

function hasOptionalBoolean(value: Record<string, unknown>, key: string): boolean {
	return value[key] === undefined || typeof value[key] === "boolean";
}

function hasOptionalRedirectStatus(value: Record<string, unknown>): boolean {
	return (
		value.type === undefined ||
		(typeof value.type === "number" && REDIRECT_STATUSES.has(value.type))
	);
}

function isRedirectCreateInput(value: unknown): value is RedirectCreateInput {
	return (
		isRecord(value) &&
		typeof value.source === "string" &&
		hasOptionalString(value, "destination") &&
		hasOptionalRedirectStatus(value) &&
		hasOptionalBoolean(value, "enabled") &&
		hasOptionalNullableString(value, "groupName")
	);
}

function isRedirectUpdateInput(value: unknown): value is RedirectUpdateInput & { _rev: string } {
	return (
		isRecord(value) &&
		typeof value._rev === "string" &&
		hasOptionalString(value, "source") &&
		hasOptionalString(value, "destination") &&
		hasOptionalRedirectStatus(value) &&
		hasOptionalBoolean(value, "enabled") &&
		hasOptionalNullableString(value, "groupName")
	);
}

function isRedirectListOptions(value: unknown): value is RedirectListOptions {
	return (
		isRecord(value) &&
		(value.limit === undefined || typeof value.limit === "number") &&
		hasOptionalString(value, "cursor") &&
		hasOptionalString(value, "search") &&
		hasOptionalString(value, "group") &&
		hasOptionalBoolean(value, "enabled") &&
		hasOptionalBoolean(value, "auto")
	);
}

function requireRedirectListOptions(body: Record<string, unknown>): RedirectListOptions {
	if (!isRedirectListOptions(body)) throw new Error("Invalid redirect list options");
	return body;
}

function requireRedirectCreateInput(body: Record<string, unknown>): RedirectCreateInput {
	const value = body.input;
	if (!isRedirectCreateInput(value)) throw new Error("Invalid redirect create input");
	return value;
}

function requireRedirectUpdateInput(
	body: Record<string, unknown>,
): RedirectUpdateInput & { _rev: string } {
	const value = body.input;
	if (!isRedirectUpdateInput(value)) throw new Error("Invalid redirect update input");
	return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`Parameter ${key} must be a string when provided`);
	return value;
}

function isCommentStatus(value: string): value is PluginCommentStatus {
	return COMMENT_STATUSES.has(value);
}

function requireCommentStatus(body: Record<string, unknown>, key: string): PluginCommentStatus {
	const value = requireString(body, key);
	if (!isCommentStatus(value)) {
		throw Object.assign(new Error(`${key} must be one of: approved, pending, spam`), {
			code: "COMMENT_STATUS_INVALID",
		});
	}
	return value;
}

function optionalCommentStatus(
	body: Record<string, unknown>,
	key: string,
): PluginCommentStatus | undefined {
	const value = optionalString(body, key);
	if (value === undefined) return undefined;
	if (!isCommentStatus(value)) {
		throw Object.assign(new Error(`${key} must be one of: approved, pending, spam`), {
			code: "COMMENT_STATUS_INVALID",
		});
	}
	return value;
}

function optionalLimit(body: Record<string, unknown>): number | undefined {
	const value = body.limit;
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || typeof value !== "number" || value < 1 || value > 100) {
		throw new Error("Parameter limit must be an integer between 1 and 100");
	}
	return value;
}

function commentListOptions(body: Record<string, unknown>): CommentListOptions {
	return {
		status: optionalCommentStatus(body, "status"),
		collection: optionalString(body, "collection"),
		contentId: optionalString(body, "contentId"),
		limit: optionalLimit(body),
		cursor: optionalString(body, "cursor"),
	};
}

function commentCountOptions(
	body: Record<string, unknown>,
): Omit<CommentListOptions, "limit" | "cursor"> {
	return {
		status: optionalCommentStatus(body, "status"),
		collection: optionalString(body, "collection"),
		contentId: optionalString(body, "contentId"),
	};
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

function requireTaxonomyTermCreateInput(
	body: Record<string, unknown>,
	key: string,
): Parameters<TaxonomyAccessWithWrite["createTerm"]>[1] {
	const input = requireRecord(body, key);
	const parentId = input.parentId;
	if (parentId !== undefined && parentId !== null && typeof parentId !== "string") {
		throw new Error("Parameter input.parentId must be a string or null");
	}
	const slug = optionalString(input, "slug");
	const description = optionalString(input, "description");
	const locale = optionalString(input, "locale");
	const translationOf = optionalString(input, "translationOf");
	return {
		label: requireString(input, "label"),
		...(slug !== undefined ? { slug } : {}),
		...(parentId !== undefined ? { parentId } : {}),
		...(description !== undefined ? { description } : {}),
		...(locale !== undefined ? { locale } : {}),
		...(translationOf !== undefined ? { translationOf } : {}),
	};
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
	if (
		capability === "network:request" &&
		opts.capabilities.includes("network:request:unrestricted")
	) {
		return;
	}
	if (!opts.capabilities.includes(capability)) {
		// Error message matches Cloudflare PluginBridge format
		throw new Error(`Missing capability: ${capability}`);
	}
}

function requireContentActions(opts: BridgeHandlerOptions): ContentActionCallbacks {
	const actions = opts.contentActions?.();
	if (!actions) throw new Error("Content actions are not configured");
	return actions;
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
	slug: string | null;
	status: string;
	data: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
	locale: string;
	publishedAt: string | null;
	scheduledAt: string | null;
	authorId: string | null;
	translationGroup: string | null;
	liveRevisionId: string | null;
	draftRevisionId: string | null;
	version: number;
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
		slug: typeof row.slug === "string" ? row.slug : null,
		status: typeof row.status === "string" ? row.status : "draft",
		data,
		createdAt: typeof row.created_at === "string" ? row.created_at : new Date().toISOString(),
		updatedAt: typeof row.updated_at === "string" ? row.updated_at : new Date().toISOString(),
		locale: typeof row.locale === "string" ? row.locale : "en",
		publishedAt: typeof row.published_at === "string" ? row.published_at : null,
		scheduledAt: typeof row.scheduled_at === "string" ? row.scheduled_at : null,
		authorId: typeof row.author_id === "string" ? row.author_id : null,
		translationGroup: typeof row.translation_group === "string" ? row.translation_group : null,
		liveRevisionId: typeof row.live_revision_id === "string" ? row.live_revision_id : null,
		draftRevisionId: typeof row.draft_revision_id === "string" ? row.draft_revision_id : null,
		version: typeof row.version === "number" ? row.version : Number(row.version) || 1,
	};
}

// ── KV Operations ────────────────────────────────────────────────────────
// Uses _plugin_storage with collection='__kv' (matching Cloudflare bridge)

const SETTINGS_KEY_PREFIX = "settings:";

function isSettingsKey(key: string): boolean {
	return key.startsWith(SETTINGS_KEY_PREFIX);
}

function observeSecretSetting(
	key: string,
	value: unknown,
	settingsSchema: Record<string, SettingField>,
	secretRedactor?: PluginSecretRedactor,
): void {
	const name = key.slice(SETTINGS_KEY_PREFIX.length);
	if (settingsSchema[name]?.type === "secret" && typeof value === "string") {
		secretRedactor?.add(name, value);
	}
}

async function kvGet(
	db: Kysely<Database>,
	pluginId: string,
	key: string,
	settingsSchema: Record<string, SettingField> = {},
	secretRedactor?: PluginSecretRedactor,
): Promise<unknown> {
	if (isSettingsKey(key)) {
		const value = await createSettingsAccess(
			new OptionsRepository(db),
			pluginId,
			settingsSchema,
			undefined,
			secretRedactor?.add,
		).get(key.slice(SETTINGS_KEY_PREFIX.length));
		if (value !== null) return value;
	}
	const row = await db
		.selectFrom("_plugin_storage")
		.where("plugin_id", "=", pluginId)
		.where("collection", "=", "__kv")
		.where("id", "=", key)
		.select("data")
		.executeTakeFirst();
	if (!row) return null;
	try {
		const value: unknown = JSON.parse(row.data);
		if (isSettingsKey(key)) observeSecretSetting(key, value, settingsSchema, secretRedactor);
		return value;
	} catch {
		if (isSettingsKey(key)) observeSecretSetting(key, row.data, settingsSchema, secretRedactor);
		return row.data;
	}
}

async function kvSet(
	db: Kysely<Database>,
	pluginId: string,
	key: string,
	value: unknown,
	settingsSchema: Record<string, SettingField> = {},
	secretRedactor?: PluginSecretRedactor,
): Promise<void> {
	if (isSettingsKey(key)) {
		await createSettingsAccess(
			new OptionsRepository(db),
			pluginId,
			settingsSchema,
			undefined,
			secretRedactor?.add,
		).set(key.slice(SETTINGS_KEY_PREFIX.length), value);
		await kvDeleteLegacy(db, pluginId, key);
		return;
	}
	await new PluginStorageRepository(db, pluginId, "__kv", []).put(key, value);
}

async function kvGetVersioned(
	db: Kysely<Database>,
	pluginId: string,
	key: string,
	opts: BridgeHandlerOptions,
) {
	if (isSettingsKey(key)) {
		const value = await createSettingsAccess(
			new OptionsRepository(db),
			pluginId,
			opts.settingsSchema,
			undefined,
			opts.secretRedactor?.add,
		).getVersioned(key.slice(SETTINGS_KEY_PREFIX.length));
		if (value !== null) return value;
	}
	const legacy = await getStorageRepo(opts, "__kv").getVersioned(key);
	if (legacy && isSettingsKey(key)) {
		observeSecretSetting(key, legacy.value, opts.settingsSchema ?? {}, opts.secretRedactor);
	}
	return legacy;
}

async function kvCompareAndSet(
	db: Kysely<Database>,
	pluginId: string,
	key: string,
	expectedRevision: string | null,
	value: unknown,
	opts: BridgeHandlerOptions,
) {
	if (!isSettingsKey(key)) {
		return getStorageRepo(opts, "__kv").compareAndSet(key, expectedRevision, value);
	}
	const result = await createSettingsAccess(
		new OptionsRepository(db),
		pluginId,
		opts.settingsSchema,
		undefined,
		opts.secretRedactor?.add,
	).compareAndSet(key.slice(SETTINGS_KEY_PREFIX.length), expectedRevision, value);
	if (result.applied) await kvDeleteLegacy(db, pluginId, key);
	return result;
}

async function kvCompareAndDelete(
	db: Kysely<Database>,
	pluginId: string,
	key: string,
	expectedRevision: string,
	opts: BridgeHandlerOptions,
) {
	if (!isSettingsKey(key)) {
		return getStorageRepo(opts, "__kv").compareAndDelete(key, expectedRevision);
	}
	const result = await createSettingsAccess(
		new OptionsRepository(db),
		pluginId,
		opts.settingsSchema,
	).compareAndDelete(key.slice(SETTINGS_KEY_PREFIX.length), expectedRevision);
	if (result.applied) await kvDeleteLegacy(db, pluginId, key);
	return result;
}

async function kvDeleteLegacy(
	db: Kysely<Database>,
	pluginId: string,
	key: string,
): Promise<boolean> {
	const result = await db
		.deleteFrom("_plugin_storage")
		.where("plugin_id", "=", pluginId)
		.where("collection", "=", "__kv")
		.where("id", "=", key)
		.executeTakeFirst();
	return BigInt(result.numDeletedRows) > 0n;
}

async function kvDelete(
	db: Kysely<Database>,
	pluginId: string,
	key: string,
	settingsSchema: Record<string, SettingField> = {},
	_secretRedactor?: PluginSecretRedactor,
): Promise<boolean> {
	if (isSettingsKey(key)) {
		const [optionDeleted, legacyDeleted] = await Promise.all([
			createSettingsAccess(new OptionsRepository(db), pluginId, settingsSchema).delete(
				key.slice(SETTINGS_KEY_PREFIX.length),
			),
			kvDeleteLegacy(db, pluginId, key),
		]);
		return optionDeleted || legacyDeleted;
	}
	return kvDeleteLegacy(db, pluginId, key);
}

async function kvList(
	db: Kysely<Database>,
	pluginId: string,
	prefix: string,
	settingsSchema: Record<string, SettingField> = {},
	secretRedactor?: PluginSecretRedactor,
): Promise<Array<{ key: string; value: unknown }>> {
	const rows = await db
		.selectFrom("_plugin_storage")
		.where("plugin_id", "=", pluginId)
		.where("collection", "=", "__kv")
		.where("id", "like", `${prefix}%`)
		.select(["id", "data"])
		.execute();

	const entries = new Map(rows.map((row) => [row.id, JSON.parse(row.data) as unknown]));
	const includesSettings =
		SETTINGS_KEY_PREFIX.startsWith(prefix) || prefix.startsWith(SETTINGS_KEY_PREFIX);
	if (includesSettings) {
		const settingPrefix = prefix.startsWith(SETTINGS_KEY_PREFIX)
			? prefix.slice(SETTINGS_KEY_PREFIX.length)
			: "";
		for (const { key, value } of await createSettingsAccess(
			new OptionsRepository(db),
			pluginId,
			settingsSchema,
			undefined,
			secretRedactor?.add,
		).list(settingPrefix)) {
			const fullKey = `${SETTINGS_KEY_PREFIX}${key}`;
			if (fullKey.startsWith(prefix)) entries.set(fullKey, value);
		}
	}
	for (const [key, value] of entries) {
		if (isSettingsKey(key)) observeSecretSetting(key, value, settingsSchema, secretRedactor);
	}
	return Array.from(entries, ([key, value]) => ({ key, value }));
}

// ── Content Operations ───────────────────────────────────────────────────

async function contentGet(
	db: Kysely<Database>,
	collection: string,
	id: string,
	opts: BridgeHandlerOptions,
): ReturnType<ReturnType<typeof createContentAccess>["get"]> {
	validateCollectionName(collection);
	try {
		return await contentAccess(opts).get(collection, id);
	} catch {
		const row = await asContentDb(db)
			.selectFrom(`ec_${collection}`)
			.where("id", "=", id)
			.where("deleted_at", "is", null)
			.selectAll()
			.executeTakeFirst();
		return row ? rowToContentItem(collection, row) : null;
	}
}

async function contentList(
	db: Kysely<Database>,
	collection: string,
	opts: Record<string, unknown>,
	handlerOptions: BridgeHandlerOptions,
): ReturnType<ReturnType<typeof createContentAccess>["list"]> {
	validateCollectionName(collection);
	const limit = Math.max(1, Math.min(Number(opts.limit) || 50, 100));
	try {
		const where = optionalRecord(opts, "where");
		const fieldFilters = where?.fieldFilters;
		if (fieldFilters !== undefined && !isRecord(fieldFilters)) {
			throw new Error("Parameter where.fieldFilters must be an object when provided");
		}
		const options: ContentListOptions = {
			limit,
			cursor: optionalString(opts, "cursor"),
			orderBy: requireOrderBy(opts, "orderBy"),
			where: where
				? {
						status: optionalString(where, "status"),
						locale: optionalString(where, "locale"),
						// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- repository validates the open custom-field filter vocabulary
						fieldFilters: fieldFilters as ContentFieldFilters | undefined,
					}
				: undefined,
		};
		return await contentAccess(handlerOptions).list(collection, options);
	} catch (error) {
		if (opts.where !== undefined || opts.orderBy !== undefined) throw error;
		let query = asContentDb(db)
			.selectFrom(`ec_${collection}`)
			.where("deleted_at", "is", null)
			.selectAll()
			.orderBy("id", "desc");
		if (typeof opts.cursor === "string") query = query.where("id", "<", opts.cursor);
		const rows = await query.limit(limit + 1).execute();
		const items = rows.slice(0, limit).map((row) => rowToContentItem(collection, row));
		return {
			items,
			cursor: rows.length > limit && items.length > 0 ? items.at(-1)!.id : undefined,
			hasMore: rows.length > limit,
		};
	}
}

function contentAccess(opts: BridgeHandlerOptions) {
	return createContentAccess(opts.db, {
		site: opts.siteInfo,
		revisions: opts.capabilities.includes("content:revisions:read"),
	});
}

async function contentCreate(
	db: Kysely<Database>,
	collection: string,
	data: Record<string, unknown>,
	locale?: string,
): Promise<ReturnType<typeof rowToContentItem>> {
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
		translation_group: id,
	};
	if (locale !== undefined) values.locale = locale;

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
		return rowToContentItem(collection, {
			id,
			created_at: now,
			updated_at: now,
			locale: locale ?? "en",
		});
	}
	return rowToContentItem(collection, created);
}

async function contentUpdate(
	db: Kysely<Database>,
	collection: string,
	id: string,
	data: Record<string, unknown>,
): Promise<ReturnType<typeof rowToContentItem>> {
	validateCollectionName(collection);
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
	locale: string,
): Promise<
	Array<{
		id: string;
		type: string;
		data: Record<string, unknown>;
		createdAt: string;
		updatedAt: string;
		locale: string;
	}>
> {
	if (items.length > MAX_BATCH_SIZE) {
		throw new Error(`Batch size ${items.length} exceeds maximum of ${MAX_BATCH_SIZE}`);
	}
	return db.transaction().execute(async (trx) => {
		const results = [];
		for (const data of items) {
			results.push(await contentCreate(trx, collection, data, locale));
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
		locale: string;
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

// ── Taxonomy Operations ──

/** Type guard for plain JSON objects. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the `collections` JSON column into a string array (`[]` on anything else). */
function parseCollectionsColumn(value: string | null): string[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === "string")
			: [];
	} catch {
		return [];
	}
}

/**
 * Convert a `taxonomies` row to the term shape exposed over the bridge.
 * Matches the Cloudflare PluginBridge and core's TaxonomyTermInfo.
 */
function rowToTaxonomyTerm(row: {
	id: string;
	name: string;
	slug: string;
	label: string;
	parent_id: string | null;
	data: string | null;
	locale: string;
	translation_group: string | null;
}) {
	let data: Record<string, unknown> | null = null;
	if (row.data) {
		try {
			const parsed: unknown = JSON.parse(row.data);
			if (isJsonObject(parsed)) data = parsed;
		} catch {
			data = null;
		}
	}
	return {
		id: row.id,
		taxonomy: row.name,
		slug: row.slug,
		label: row.label,
		parentId: row.parent_id,
		data,
		locale: row.locale,
		translationGroup: row.translation_group,
	};
}

async function taxonomyList(db: Kysely<Database>, locale?: string) {
	let query = db.selectFrom("_emdash_taxonomy_defs").selectAll();
	if (locale !== undefined) query = query.where("locale", "=", locale);
	const rows = await query.orderBy("name", "asc").execute();
	return rows.map((row) => ({
		name: row.name,
		label: row.label,
		labelSingular: row.label_singular,
		hierarchical: row.hierarchical === 1,
		collections: parseCollectionsColumn(row.collections),
		locale: row.locale,
	}));
}

async function taxonomyTerms(db: Kysely<Database>, taxonomy: string, locale?: string) {
	// Manual order first, then label with `id asc` as a stable tiebreaker for
	// terms sharing both — matching core's TaxonomyRepository.findByName.
	let query = db
		.selectFrom("taxonomies")
		.selectAll()
		.where("name", "=", taxonomy)
		.orderBy("sort_order", "asc")
		.orderBy("label", "asc")
		.orderBy("id", "asc");
	if (locale !== undefined) query = query.where("locale", "=", locale);
	const rows = await query.execute();
	return rows.map(rowToTaxonomyTerm);
}

async function taxonomyEntryTerms(
	db: Kysely<Database>,
	collection: string,
	entryId: string,
	taxonomy?: string,
	locale?: string,
) {
	// The pivot stores the term's translation_group in taxonomy_id, so the
	// join resolves an assignment into each locale's term row.
	let query = db
		.selectFrom("content_taxonomies")
		.innerJoin("taxonomies", "taxonomies.translation_group", "content_taxonomies.taxonomy_id")
		.selectAll("taxonomies")
		.where("content_taxonomies.collection", "=", collection)
		.where("content_taxonomies.entry_id", "=", entryId)
		.orderBy("taxonomies.locale", "asc");
	if (taxonomy !== undefined) query = query.where("taxonomies.name", "=", taxonomy);
	if (locale !== undefined) query = query.where("taxonomies.locale", "=", locale);
	const rows = await query.execute();
	return rows.map(rowToTaxonomyTerm);
}

// ── Media Operations ─────────────────────────────────────────────────────

async function mediaGet(db: Kysely<Database>, id: string) {
	return createMediaAccess(db).get(id);
}

async function mediaList(db: Kysely<Database>, opts: Record<string, unknown>) {
	return createMediaAccess(db).list({
		limit: typeof opts.limit === "number" ? opts.limit : undefined,
		cursor: optionalString(opts, "cursor"),
		mimeType: optionalString(opts, "mimeType"),
	});
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
	const hasAnyFetch = opts.capabilities.includes("network:request:unrestricted");
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
