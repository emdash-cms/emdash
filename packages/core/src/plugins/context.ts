/**
 * Plugin Context v2
 *
 * Creates the unified context object provided to plugins in all hooks and routes.
 *
 */

import type { Kysely } from "kysely";
import { ulid } from "ulidx";

import { ContentRepository } from "../database/repositories/content.js";
import { MediaRepository } from "../database/repositories/media.js";
import { OptionsRepository } from "../database/repositories/options.js";
import { PluginStorageRepository } from "../database/repositories/plugin-storage.js";
import { SeoRepository } from "../database/repositories/seo.js";
import { UserRepository } from "../database/repositories/user.js";
import { withTransaction } from "../database/transaction.js";
import type { Database } from "../database/types.js";
import { validateExternalUrl, SsrfError, stripCredentialHeaders } from "../import/ssrf.js";
import type { Storage } from "../storage/types.js";
import { CronAccessImpl } from "./cron.js";
import type { EmailPipeline } from "./email.js";
import type {
	ResolvedPlugin,
	PluginContext,
	PluginStorageConfig,
	StorageCollection,
	KVAccess,
	CronAccess,
	EmailAccess,
	ContentAccess,
	ContentAccessWithWrite,
	MediaAccess,
	MediaAccessWithWrite,
	HttpAccess,
	LogAccess,
	SiteInfo,
	UserAccess,
	UserInfo,
	ContentItem,
	ContentItemSeoInput,
	ContentWriteInput,
	MediaItem,
	PaginatedResult,
	QueryOptions,
	ContentListOptions,
	MediaListOptions,
} from "./types.js";

// =============================================================================
// KV Access
// =============================================================================

/**
 * Create KV accessor for a plugin
 * All keys are automatically prefixed with the plugin ID
 */
export function createKVAccess(optionsRepo: OptionsRepository, pluginId: string): KVAccess {
	const prefix = `plugin:${pluginId}:`;

	return {
		async get<T>(key: string): Promise<T | null> {
			return optionsRepo.get<T>(`${prefix}${key}`);
		},

		async set(key: string, value: unknown): Promise<void> {
			await optionsRepo.set(`${prefix}${key}`, value);
		},

		async delete(key: string): Promise<boolean> {
			return optionsRepo.delete(`${prefix}${key}`);
		},

		async list(keyPrefix?: string): Promise<Array<{ key: string; value: unknown }>> {
			const fullPrefix = `${prefix}${keyPrefix ?? ""}`;
			const entriesMap = await optionsRepo.getByPrefix(fullPrefix);
			const result: Array<{ key: string; value: unknown }> = [];
			for (const [fullKey, value] of entriesMap) {
				result.push({
					key: fullKey.slice(prefix.length),
					value,
				});
			}
			return result;
		},
	};
}

// =============================================================================
// Storage Access
// =============================================================================

/**
 * Create storage collection accessor for a plugin
 * Wraps PluginStorageRepository with the v2 interface (no async iterators)
 */
function createStorageCollection<T>(
	db: Kysely<Database>,
	pluginId: string,
	collectionName: string,
	indexes: Array<string | string[]>,
): StorageCollection<T> {
	const repo = new PluginStorageRepository<T>(db, pluginId, collectionName, indexes);

	return {
		get: (id) => repo.get(id),
		put: (id, data) => repo.put(id, data),
		delete: (id) => repo.delete(id),
		exists: (id) => repo.exists(id),
		getMany: (ids) => repo.getMany(ids),
		putMany: (items) => repo.putMany(items),
		deleteMany: (ids) => repo.deleteMany(ids),
		count: (where) => repo.count(where),

		// Query returns PaginatedResult instead of the old format
		async query(options?: QueryOptions): Promise<PaginatedResult<{ id: string; data: T }>> {
			const result = await repo.query({
				where: options?.where,
				orderBy: options?.orderBy,
				limit: options?.limit,
				cursor: options?.cursor,
			});

			return {
				items: result.items,
				cursor: result.cursor,
				hasMore: result.hasMore,
			};
		},
	};
}

/**
 * Create storage accessor with all declared collections
 */
export function createStorageAccess<T extends PluginStorageConfig>(
	db: Kysely<Database>,
	pluginId: string,
	storageConfig: T,
): Record<string, StorageCollection> {
	const storage: Record<string, StorageCollection> = {};

	for (const [collectionName, config] of Object.entries(storageConfig)) {
		const allIndexes = [...config.indexes, ...(config.uniqueIndexes ?? [])];
		storage[collectionName] = createStorageCollection(db, pluginId, collectionName, allIndexes);
	}

	return storage;
}

// =============================================================================
// Content Access
// =============================================================================

/**
 * Extract `seo` from a plugin-supplied content write input and return both
 * parts. Mutates nothing — returns a new field map without the `seo` key.
 */
function splitSeoFromInput(input: ContentWriteInput): {
	fields: Record<string, unknown>;
	seo: ContentItemSeoInput | undefined;
} {
	const { seo, ...fields } = input;
	// Reject non-object seo values rather than silently dropping them.
	if (seo !== undefined && (seo === null || typeof seo !== "object" || Array.isArray(seo))) {
		throw new Error("content.seo must be an object");
	}
	return { fields, seo };
}

/**
 * Reject writing SEO to a collection that does not have it enabled.
 * Matches the REST API behavior (VALIDATION_ERROR).
 */
async function assertSeoEnabled(
	seoRepo: SeoRepository,
	collection: string,
	seo: ContentItemSeoInput | undefined,
): Promise<boolean> {
	const hasSeo = await seoRepo.isEnabled(collection);
	if (seo !== undefined && !hasSeo) {
		throw new Error(
			`Collection "${collection}" does not have SEO enabled. ` +
				`Remove the seo field or enable SEO on this collection.`,
		);
	}
	return hasSeo;
}

/**
 * Create read-only content access
 */
export function createContentAccess(db: Kysely<Database>): ContentAccess {
	const contentRepo = new ContentRepository(db);
	const seoRepo = new SeoRepository(db);

	return {
		async get(collection: string, id: string): Promise<ContentItem | null> {
			const item = await contentRepo.findById(collection, id);
			if (!item) return null;

			const result: ContentItem = {
				id: item.id,
				type: item.type,
				slug: item.slug,
				status: item.status,
				data: item.data,
				createdAt: item.createdAt,
				updatedAt: item.updatedAt,
				publishedAt: item.publishedAt,
			};

			if (await seoRepo.isEnabled(collection)) {
				result.seo = await seoRepo.get(collection, item.id);
			}

			return result;
		},

		async list(
			collection: string,
			options?: ContentListOptions,
		): Promise<PaginatedResult<ContentItem>> {
			// Convert orderBy format if provided
			let orderBy: { field: string; direction: "asc" | "desc" } | undefined;
			if (options?.orderBy) {
				const entries = Object.entries(options.orderBy);
				const first = entries[0];
				if (first) {
					orderBy = { field: first[0], direction: first[1] };
				}
			}

			const result = await contentRepo.findMany(collection, {
				limit: options?.limit ?? 50,
				cursor: options?.cursor,
				orderBy,
			});

			const items: ContentItem[] = result.items.map((item) => ({
				id: item.id,
				type: item.type,
				slug: item.slug,
				status: item.status,
				data: item.data,
				createdAt: item.createdAt,
				updatedAt: item.updatedAt,
				publishedAt: item.publishedAt,
			}));

			if (items.length > 0 && (await seoRepo.isEnabled(collection))) {
				const seoMap = await seoRepo.getMany(
					collection,
					items.map((i) => i.id),
				);
				for (const item of items) {
					const seo = seoMap.get(item.id);
					if (seo) item.seo = seo;
				}
			}

			return {
				items,
				cursor: result.nextCursor,
				hasMore: !!result.nextCursor,
			};
		},
	};
}

/**
 * Create full content access with write operations.
 *
 * `create` and `update` accept a reserved `seo` key in their `data`
 * argument. When present, it is routed to the core SEO panel
 * (`_emdash_seo`) via `SeoRepository.upsert`, in the same transaction as
 * the content write. The returned `ContentItem.seo` reflects the resulting
 * SEO state for SEO-enabled collections.
 */
export function createContentAccessWithWrite(db: Kysely<Database>): ContentAccessWithWrite {
	const readAccess = createContentAccess(db);

	return {
		...readAccess,

		async create(collection: string, data: ContentWriteInput): Promise<ContentItem> {
			const { fields, seo } = splitSeoFromInput(data);

			return withTransaction(db, async (trx) => {
				const trxContentRepo = new ContentRepository(trx);
				const trxSeoRepo = new SeoRepository(trx);

				const hasSeo = await assertSeoEnabled(trxSeoRepo, collection, seo);

				const item = await trxContentRepo.create({
					type: collection,
					data: fields,
				});

				const result: ContentItem = {
					id: item.id,
					type: item.type,
					slug: item.slug,
					status: item.status,
					data: item.data,
					createdAt: item.createdAt,
					updatedAt: item.updatedAt,
					publishedAt: item.publishedAt,
				};

				if (hasSeo) {
					result.seo =
						seo !== undefined
							? await trxSeoRepo.upsert(collection, item.id, seo)
							: await trxSeoRepo.get(collection, item.id);
				}

				return result;
			});
		},

		async update(collection: string, id: string, data: ContentWriteInput): Promise<ContentItem> {
			const { fields, seo } = splitSeoFromInput(data);

			return withTransaction(db, async (trx) => {
				const trxContentRepo = new ContentRepository(trx);
				const trxSeoRepo = new SeoRepository(trx);

				const hasSeo = await assertSeoEnabled(trxSeoRepo, collection, seo);

				// Pass the `data` payload to ContentRepository.update only when
				// there are field updates — passing an empty object would still
				// bump updated_at/version, but we want a seo-only call to touch
				// only the SEO table. ContentRepository.update handles the no-op
				// path by returning the current row.
				const hasFieldUpdates = Object.keys(fields).length > 0;
				const item = hasFieldUpdates
					? await trxContentRepo.update(collection, id, { data: fields })
					: await (async () => {
							const existing = await trxContentRepo.findById(collection, id);
							if (!existing) throw new Error("Content not found");
							return existing;
						})();

				const result: ContentItem = {
					id: item.id,
					type: item.type,
					slug: item.slug,
					status: item.status,
					data: item.data,
					createdAt: item.createdAt,
					updatedAt: item.updatedAt,
					publishedAt: item.publishedAt,
				};

				if (hasSeo) {
					result.seo =
						seo !== undefined
							? await trxSeoRepo.upsert(collection, item.id, seo)
							: await trxSeoRepo.get(collection, item.id);
				}

				return result;
			});
		},

		async delete(collection: string, id: string): Promise<boolean> {
			const contentRepo = new ContentRepository(db);
			return contentRepo.delete(collection, id);
		},
	};
}

// =============================================================================
// Media Access
// =============================================================================

/**
 * Create read-only media access
 */
export function createMediaAccess(db: Kysely<Database>): MediaAccess {
	const mediaRepo = new MediaRepository(db);

	return {
		async get(id: string): Promise<MediaItem | null> {
			const item = await mediaRepo.findById(id);
			if (!item) return null;

			return {
				id: item.id,
				filename: item.filename,
				mimeType: item.mimeType,
				size: item.size,
				// Construct URL from storage key (or use a sensible default path)
				url: `/media/${item.id}/${item.filename}`,
				createdAt: item.createdAt,
			};
		},

		async list(options?: MediaListOptions): Promise<PaginatedResult<MediaItem>> {
			const result = await mediaRepo.findMany({
				limit: options?.limit ?? 50,
				cursor: options?.cursor,
				mimeType: options?.mimeType,
			});

			return {
				items: result.items.map((item) => ({
					id: item.id,
					filename: item.filename,
					mimeType: item.mimeType,
					size: item.size,
					url: `/media/${item.id}/${item.filename}`,
					createdAt: item.createdAt,
				})),
				cursor: result.nextCursor,
				hasMore: !!result.nextCursor,
			};
		},
	};
}

/**
 * Create full media access with write operations.
 * If storage is not provided, upload() will throw at call time.
 */
export function createMediaAccessWithWrite(
	db: Kysely<Database>,
	getUploadUrlFn: (
		filename: string,
		contentType: string,
	) => Promise<{ uploadUrl: string; mediaId: string }>,
	storage?: Storage,
): MediaAccessWithWrite {
	const mediaRepo = new MediaRepository(db);
	const readAccess = createMediaAccess(db);

	return {
		...readAccess,

		getUploadUrl: getUploadUrlFn,

		async upload(
			filename: string,
			contentType: string,
			bytes: ArrayBuffer,
		): Promise<{ mediaId: string; storageKey: string; url: string }> {
			if (!storage) {
				throw new Error(
					"Media upload() requires a storage backend. Configure storage in PluginContextFactoryOptions.",
				);
			}

			const mediaId = ulid();
			// Extract extension from basename (ignore path separators)
			const basename = filename.split("/").pop() ?? filename;
			const dotIdx = basename.lastIndexOf(".");
			const ext = dotIdx > 0 ? basename.slice(dotIdx).toLowerCase() : "";
			const storageKey = `${mediaId}${ext}`;

			// Upload to storage first
			await storage.upload({
				key: storageKey,
				body: new Uint8Array(bytes),
				contentType,
			});

			// Create DB record — clean up storage on failure
			try {
				await mediaRepo.create({
					filename: basename,
					mimeType: contentType,
					size: bytes.byteLength,
					storageKey,
					status: "ready",
				});
			} catch (error) {
				try {
					await storage.delete(storageKey);
				} catch {
					// Best-effort cleanup
				}
				throw error;
			}

			return {
				mediaId,
				storageKey,
				url: `/_emdash/api/media/file/${storageKey}`,
			};
		},

		async delete(id: string): Promise<boolean> {
			return mediaRepo.delete(id);
		},
	};
}

// =============================================================================
// HTTP Access
// =============================================================================

/** Maximum number of redirects to follow in plugin HTTP access */
const MAX_PLUGIN_REDIRECTS = 5;

function isHostAllowed(host: string, allowedHosts: string[]): boolean {
	return allowedHosts.some((pattern) => {
		if (pattern === "*") return true;
		if (pattern.startsWith("*.")) {
			const suffix = pattern.slice(1); // ".example.com"
			return host.endsWith(suffix) || host === pattern.slice(2);
		}
		return host === pattern;
	});
}

/**
 * Create HTTP access with host validation.
 *
 * Uses redirect: "manual" to re-validate each redirect target against
 * the allowedHosts list, preventing redirects to unauthorized hosts.
 */
export function createHttpAccess(pluginId: string, allowedHosts: string[]): HttpAccess {
	return {
		async fetch(url: string, init?: RequestInit): Promise<Response> {
			// Deny by default — plugins must declare allowed hosts
			if (allowedHosts.length === 0) {
				throw new Error(
					`Plugin "${pluginId}" has no allowed hosts configured. ` +
						`Add hosts to the plugin's allowedHosts array to enable HTTP requests.`,
				);
			}

			let currentUrl = url;
			let currentInit = init;

			for (let i = 0; i <= MAX_PLUGIN_REDIRECTS; i++) {
				const hostname = new URL(currentUrl).hostname;
				if (!isHostAllowed(hostname, allowedHosts)) {
					throw new Error(
						`Plugin "${pluginId}" is not allowed to fetch from host "${hostname}". ` +
							`Allowed hosts: ${allowedHosts.join(", ")}`,
					);
				}

				const response = await globalThis.fetch(currentUrl, {
					...currentInit,
					redirect: "manual",
				});

				// Not a redirect -- return directly
				if (response.status < 300 || response.status >= 400) {
					return response;
				}

				// Extract redirect target
				const location = response.headers.get("Location");
				if (!location) {
					return response;
				}

				// Resolve relative redirects; strip credentials on cross-origin hops
				const previousOrigin = new URL(currentUrl).origin;
				currentUrl = new URL(location, currentUrl).href;
				const nextOrigin = new URL(currentUrl).origin;

				if (previousOrigin !== nextOrigin && currentInit) {
					currentInit = stripCredentialHeaders(currentInit);
				}
			}

			throw new Error(`Plugin "${pluginId}": too many redirects (max ${MAX_PLUGIN_REDIRECTS})`);
		},
	};
}

/**
 * Create unrestricted HTTP access (for plugins with network:fetch:any capability).
 * No host validation, but applies SSRF protection on redirect targets to
 * prevent plugins from being tricked into reaching internal services.
 */
export function createUnrestrictedHttpAccess(pluginId: string): HttpAccess {
	return {
		async fetch(url: string, init?: RequestInit): Promise<Response> {
			let currentUrl = url;
			let currentInit = init;

			for (let i = 0; i <= MAX_PLUGIN_REDIRECTS; i++) {
				// Validate each URL against SSRF rules (private IPs, metadata endpoints)
				try {
					validateExternalUrl(currentUrl);
				} catch (e) {
					const msg = e instanceof SsrfError ? e.message : "SSRF validation failed";
					throw new Error(
						`Plugin "${pluginId}": blocked fetch to "${new URL(currentUrl).hostname}": ${msg}`,
						{ cause: e },
					);
				}

				const response = await globalThis.fetch(currentUrl, {
					...currentInit,
					redirect: "manual",
				});

				// Not a redirect -- return directly
				if (response.status < 300 || response.status >= 400) {
					return response;
				}

				// Extract redirect target
				const location = response.headers.get("Location");
				if (!location) {
					return response;
				}

				// Resolve relative redirects; strip credentials on cross-origin hops
				const previousOrigin = new URL(currentUrl).origin;
				currentUrl = new URL(location, currentUrl).href;
				const nextOrigin = new URL(currentUrl).origin;

				if (previousOrigin !== nextOrigin && currentInit) {
					currentInit = stripCredentialHeaders(currentInit);
				}
			}

			throw new Error(`Plugin "${pluginId}": too many redirects (max ${MAX_PLUGIN_REDIRECTS})`);
		},
	};
}

/**
 * Create blocked HTTP access (for plugins without network:fetch capability)
 */
export function createBlockedHttpAccess(pluginId: string): HttpAccess {
	return {
		async fetch(): Promise<never> {
			throw new Error(
				`Plugin "${pluginId}" does not have the "network:fetch" capability. ` +
					`Add "network:fetch" to the plugin's capabilities to enable HTTP requests.`,
			);
		},
	};
}

// =============================================================================
// Log Access
// =============================================================================

/**
 * Create logger for a plugin
 */
export function createLogAccess(pluginId: string): LogAccess {
	const prefix = `[plugin:${pluginId}]`;

	return {
		debug(message: string, data?: unknown): void {
			if (data !== undefined) {
				console.debug(prefix, message, data);
			} else {
				console.debug(prefix, message);
			}
		},

		info(message: string, data?: unknown): void {
			if (data !== undefined) {
				console.info(prefix, message, data);
			} else {
				console.info(prefix, message);
			}
		},

		warn(message: string, data?: unknown): void {
			if (data !== undefined) {
				console.warn(prefix, message, data);
			} else {
				console.warn(prefix, message);
			}
		},

		error(message: string, data?: unknown): void {
			if (data !== undefined) {
				console.error(prefix, message, data);
			} else {
				console.error(prefix, message);
			}
		},
	};
}

// =============================================================================
// Site Info
// =============================================================================

const TRAILING_SLASH_RE = /\/$/;

/**
 * Options for creating site info
 */
export interface SiteInfoOptions {
	/** Site name from options table */
	siteName?: string;
	/** Site URL from options table or Astro config */
	siteUrl?: string;
	/** Site locale from options table */
	locale?: string;
}

/**
 * Create site info from config and settings.
 *
 * Resolution order for URL:
 * 1. options table (emdash:site_url)
 * 2. Astro `site` config
 * 3. fallback to empty string
 */
export function createSiteInfo(options: SiteInfoOptions): SiteInfo {
	return {
		name: options.siteName ?? "",
		url: (options.siteUrl ?? "").replace(TRAILING_SLASH_RE, ""), // strip trailing slash
		locale: options.locale ?? "en",
	};
}

/**
 * Create a URL helper that generates absolute URLs from relative paths.
 * Validates that path starts with "/" and rejects protocol-relative paths ("//").
 */
export function createUrlHelper(siteUrl: string): (path: string) => string {
	const base = siteUrl.replace(TRAILING_SLASH_RE, ""); // strip trailing slash

	return (path: string): string => {
		if (!path.startsWith("/")) {
			throw new Error(`URL path must start with "/", got: "${path}"`);
		}
		if (path.startsWith("//")) {
			throw new Error(`URL path must not be protocol-relative, got: "${path}"`);
		}
		return `${base}${path}`;
	};
}

// =============================================================================
// User Access
// =============================================================================

/**
 * Convert a UserRepository user to the plugin-facing UserInfo shape.
 * Strips sensitive fields (avatarUrl, emailVerified, data).
 */
function toUserInfo(user: {
	id: string;
	email: string;
	name: string | null;
	role: number;
	createdAt: string;
}): UserInfo {
	return {
		id: user.id,
		email: user.email,
		name: user.name,
		role: user.role,
		createdAt: user.createdAt,
	};
}

/**
 * Create read-only user access for plugins.
 * Excludes sensitive fields (password hashes, sessions, passkeys, avatar URL, data).
 */
export function createUserAccess(db: Kysely<Database>): UserAccess {
	const userRepo = new UserRepository(db);

	return {
		async get(id: string): Promise<UserInfo | null> {
			const user = await userRepo.findById(id);
			if (!user) return null;
			return toUserInfo(user);
		},

		async getByEmail(email: string): Promise<UserInfo | null> {
			const user = await userRepo.findByEmail(email);
			if (!user) return null;
			return toUserInfo(user);
		},

		async list(opts?: {
			role?: number;
			limit?: number;
			cursor?: string;
		}): Promise<{ items: UserInfo[]; nextCursor?: string }> {
			const result = await userRepo.findMany({
				role: opts?.role as 10 | 20 | 30 | 40 | 50 | undefined,
				cursor: opts?.cursor,
				limit: opts?.limit,
			});

			return {
				items: result.items.map(toUserInfo),
				nextCursor: result.nextCursor,
			};
		},
	};
}

// =============================================================================
// Plugin Context Factory
// =============================================================================

export interface PluginContextFactoryOptions {
	db: Kysely<Database>;
	/**
	 * Storage backend for direct media uploads.
	 * If not provided, upload() will throw.
	 */
	storage?: Storage;
	/**
	 * Function to generate upload URLs for media.
	 * If not provided, media write operations will throw.
	 */
	getUploadUrl?: (
		filename: string,
		contentType: string,
	) => Promise<{ uploadUrl: string; mediaId: string }>;
	/**
	 * Site information for ctx.site and ctx.url().
	 * If not provided, site info will have empty defaults.
	 */
	siteInfo?: SiteInfoOptions;
	/**
	 * Callback to notify the cron scheduler that the next due time may have changed.
	 * If not provided, ctx.cron will not be available.
	 */
	cronReschedule?: () => void;
	/**
	 * Email pipeline instance for ctx.email.
	 * If not provided (or no provider configured), ctx.email will be undefined.
	 */
	emailPipeline?: EmailPipeline;
}

/**
 * Factory for creating plugin contexts
 */
export class PluginContextFactory {
	private optionsRepo: OptionsRepository;
	private db: Kysely<Database>;
	private storage?: Storage;
	private getUploadUrl?: (
		filename: string,
		contentType: string,
	) => Promise<{ uploadUrl: string; mediaId: string }>;
	private site: SiteInfo;
	private urlHelper: (path: string) => string;
	private cronReschedule?: () => void;
	private emailPipeline?: EmailPipeline;

	constructor(options: PluginContextFactoryOptions) {
		this.db = options.db;
		this.optionsRepo = new OptionsRepository(options.db);
		this.storage = options.storage;
		this.getUploadUrl = options.getUploadUrl;
		this.site = createSiteInfo(options.siteInfo ?? {});
		this.urlHelper = createUrlHelper(this.site.url);
		this.cronReschedule = options.cronReschedule;
		this.emailPipeline = options.emailPipeline;
	}

	/**
	 * Create the unified plugin context
	 */
	createContext(plugin: ResolvedPlugin): PluginContext {
		const capabilities = new Set(plugin.capabilities);

		// Always available
		const kv = createKVAccess(this.optionsRepo, plugin.id);
		const log = createLogAccess(plugin.id);
		const storage = createStorageAccess(this.db, plugin.id, plugin.storage);

		// Capability-gated: content
		let content: ContentAccess | ContentAccessWithWrite | undefined;
		if (capabilities.has("write:content")) {
			content = createContentAccessWithWrite(this.db);
		} else if (capabilities.has("read:content")) {
			content = createContentAccess(this.db);
		}

		// Capability-gated: media
		let media: MediaAccess | MediaAccessWithWrite | undefined;
		if (capabilities.has("write:media") && this.getUploadUrl) {
			media = createMediaAccessWithWrite(this.db, this.getUploadUrl, this.storage);
		} else if (capabilities.has("read:media")) {
			media = createMediaAccess(this.db);
		}

		// Capability-gated: http
		let http: HttpAccess | undefined;
		if (capabilities.has("network:fetch:any")) {
			http = createUnrestrictedHttpAccess(plugin.id);
		} else if (capabilities.has("network:fetch")) {
			http = createHttpAccess(plugin.id, plugin.allowedHosts);
		}

		// Capability-gated: users
		let users: UserAccess | undefined;
		if (capabilities.has("read:users")) {
			users = createUserAccess(this.db);
		}

		// Cron access ��� always available (scoped to plugin), but only if
		// the runtime provided a reschedule callback (i.e. cron is wired up).
		let cron: CronAccess | undefined;
		if (this.cronReschedule) {
			cron = new CronAccessImpl(this.db, plugin.id, this.cronReschedule);
		}

		// Email access — requires email:send capability AND a configured provider
		let email: EmailAccess | undefined;
		if (capabilities.has("email:send") && this.emailPipeline?.isAvailable()) {
			const pipeline = this.emailPipeline;
			const pluginId = plugin.id;
			email = {
				send: (message) => pipeline.send(message, pluginId),
			};
		}

		return {
			plugin: {
				id: plugin.id,
				version: plugin.version,
			},
			storage,
			kv,
			content,
			media,
			http,
			log,
			site: this.site,
			url: this.urlHelper,
			users,
			cron,
			email,
		};
	}
}

/**
 * Create a plugin context for a resolved plugin
 */
export function createPluginContext(
	options: PluginContextFactoryOptions,
	plugin: ResolvedPlugin,
): PluginContext {
	const factory = new PluginContextFactory(options);
	return factory.createContext(plugin);
}
