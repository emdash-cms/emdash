/**
 * Plugin System Types v2
 *
 * New plugin API with:
 * - Single unified context shape for all hooks and routes
 * - Paginated storage queries (no async iterators)
 * - Unified KV API (replaces settings + options)
 * - Explicit ctx.http and ctx.log
 *
 */

import type { Element } from "@emdash-cms/blocks";
import type { JSX } from "astro/jsx-runtime";
import type { z } from "astro/zod";

import type { FieldType } from "../schema/types.js";

// =============================================================================
// Core Types
// =============================================================================

/**
 * Plugin capabilities determine what APIs are available in context
 */
export type PluginCapability =
	| "network:fetch" // ctx.http is available (host-restricted via allowedHosts)
	| "network:fetch:any" // ctx.http is available (unrestricted outbound — use for user-configured URLs)
	| "read:content" // ctx.content.get/list available
	| "write:content" // ctx.content.create/update/delete available
	| "read:media" // ctx.media.get/list available
	| "write:media" // ctx.media.getUploadUrl/delete available
	| "read:users" // ctx.users is available
	| "email:send" // ctx.email is available (when a provider is configured)
	| "email:provide" // can register email:deliver exclusive hook (transport provider)
	| "email:intercept" // can register email:beforeSend / email:afterSend hooks
	| "page:inject"; // can register page:fragments hook (inject scripts/styles into pages)

// =============================================================================
// Storage Types
// =============================================================================

/**
 * Storage collection declaration in plugin definition
 */
export interface StorageCollectionConfig {
	/**
	 * Fields to index for querying.
	 * Each entry can be a single field name or an array for composite indexes.
	 */
	indexes: Array<string | string[]>;
	/**
	 * Fields with unique constraints.
	 * Each entry can be a single field name or an array for composite unique indexes.
	 * Unique indexes are also queryable (no need to duplicate in `indexes`).
	 */
	uniqueIndexes?: Array<string | string[]>;
}

/**
 * Plugin storage configuration
 */
export type PluginStorageConfig = Record<string, StorageCollectionConfig>;

/**
 * Query filter operators
 */
export interface RangeFilter {
	gt?: number | string;
	gte?: number | string;
	lt?: number | string;
	lte?: number | string;
}

export interface InFilter {
	in: Array<string | number>;
}

export interface StartsWithFilter {
	startsWith: string;
}

/**
 * Where clause value types
 */
export type WhereValue =
	| string
	| number
	| boolean
	| null
	| RangeFilter
	| InFilter
	| StartsWithFilter;

/**
 * Where clause for storage queries
 */
export type WhereClause = Record<string, WhereValue>;

/**
 * Query options for storage.query()
 */
export interface QueryOptions {
	where?: WhereClause;
	orderBy?: Record<string, "asc" | "desc">;
	limit?: number; // Default 50, max 1000
	cursor?: string;
}

/**
 * Paginated result (used by storage.query, content.list, media.list)
 */
export interface PaginatedResult<T> {
	items: T[];
	cursor?: string;
	hasMore: boolean;
}

/**
 * Storage collection interface - the API exposed to plugins
 * No async iterators - all operations return promises with pagination
 */
export interface StorageCollection<T = unknown> {
	// Basic CRUD
	get(id: string): Promise<T | null>;
	put(id: string, data: T): Promise<void>;
	delete(id: string): Promise<boolean>;
	exists(id: string): Promise<boolean>;

	// Batch operations
	getMany(ids: string[]): Promise<Map<string, T>>;
	putMany(items: Array<{ id: string; data: T }>): Promise<void>;
	deleteMany(ids: string[]): Promise<number>;

	// Query - always paginated
	query(options?: QueryOptions): Promise<PaginatedResult<{ id: string; data: T }>>;
	count(where?: WhereClause): Promise<number>;
}

/**
 * Plugin storage context - typed based on declared collections
 */
export type PluginStorage<T extends PluginStorageConfig> = {
	[K in keyof T]: StorageCollection;
};

// =============================================================================
// Context APIs
// =============================================================================

/**
 * KV store interface - unified replacement for settings + options
 *
 * Convention:
 * - `settings:*` - User-configurable preferences (shown in admin UI)
 * - `state:*` - Internal plugin state (not shown to users)
 */
export interface KVAccess {
	get<T>(key: string): Promise<T | null>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<boolean>;
	list(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
}

/**
 * Content item returned from content API
 */
export interface ContentItem {
	id: string;
	type: string;
	data: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

/**
 * Content list options
 */
export interface ContentListOptions {
	limit?: number;
	cursor?: string;
	orderBy?: Record<string, "asc" | "desc">;
}

/**
 * Content access interface - capability-gated
 */
export interface ContentAccess {
	// Read operations (requires read:content)
	get(collection: string, id: string): Promise<ContentItem | null>;
	list(collection: string, options?: ContentListOptions): Promise<PaginatedResult<ContentItem>>;

	// Write operations (requires write:content) - optional on interface
	create?(collection: string, data: Record<string, unknown>): Promise<ContentItem>;
	update?(collection: string, id: string, data: Record<string, unknown>): Promise<ContentItem>;
	delete?(collection: string, id: string): Promise<boolean>;
}

/**
 * Full content access with write operations
 */
export interface ContentAccessWithWrite extends ContentAccess {
	create(collection: string, data: Record<string, unknown>): Promise<ContentItem>;
	update(collection: string, id: string, data: Record<string, unknown>): Promise<ContentItem>;
	delete(collection: string, id: string): Promise<boolean>;
}

/**
 * Media item returned from media API
 */
export interface MediaItem {
	id: string;
	filename: string;
	mimeType: string;
	size: number | null;
	url: string;
	createdAt: string;
}

/**
 * Media list options
 */
export interface MediaListOptions {
	limit?: number;
	cursor?: string;
	mimeType?: string; // Filter by mime type prefix, e.g., "image/"
}

/**
 * Media access interface - capability-gated
 */
export interface MediaAccess {
	// Read operations (requires read:media)
	get(id: string): Promise<MediaItem | null>;
	list(options?: MediaListOptions): Promise<PaginatedResult<MediaItem>>;

	// Write operations (requires write:media) - optional on interface
	getUploadUrl?(
		filename: string,
		contentType: string,
	): Promise<{ uploadUrl: string; mediaId: string }>;
	/**
	 * Upload media bytes directly. Preferred in sandboxed mode where
	 * plugins cannot make external requests to a presigned URL.
	 * Returns the created media item.
	 */
	upload?(
		filename: string,
		contentType: string,
		bytes: ArrayBuffer,
	): Promise<{ mediaId: string; storageKey: string; url: string }>;
	delete?(id: string): Promise<boolean>;
}

/**
 * Full media access with write operations
 */
export interface MediaAccessWithWrite extends MediaAccess {
	getUploadUrl(
		filename: string,
		contentType: string,
	): Promise<{ uploadUrl: string; mediaId: string }>;
	upload(
		filename: string,
		contentType: string,
		bytes: ArrayBuffer,
	): Promise<{ mediaId: string; storageKey: string; url: string }>;
	delete(id: string): Promise<boolean>;
}

/**
 * HTTP client interface - requires network:fetch capability
 */
export interface HttpAccess {
	fetch(url: string, init?: RequestInit): Promise<Response>;
}

/**
 * Logger interface - always available
 */
export interface LogAccess {
	debug(message: string, data?: unknown): void;
	info(message: string, data?: unknown): void;
	warn(message: string, data?: unknown): void;
	error(message: string, data?: unknown): void;
}

// =============================================================================
// Site & User Access
// =============================================================================

/**
 * Site information available to all plugins
 */
export interface SiteInfo {
	/** Site name (from settings) */
	name: string;
	/** Site URL (from settings or request) */
	url: string;
	/** Site locale (from settings, defaults to "en") */
	locale: string;
}

/**
 * Read-only user information exposed to plugins.
 * Sensitive fields (password hashes, sessions, passkeys) are excluded.
 */
export interface UserInfo {
	id: string;
	email: string;
	name: string | null;
	role: number;
	createdAt: string;
}

/**
 * User access interface - requires read:users capability
 */
export interface UserAccess {
	/** Get a user by ID */
	get(id: string): Promise<UserInfo | null>;
	/** Get a user by email */
	getByEmail(email: string): Promise<UserInfo | null>;
	/** List users with optional filters */
	list(opts?: { role?: number; limit?: number; cursor?: string }): Promise<{
		items: UserInfo[];
		nextCursor?: string;
	}>;
}

// =============================================================================
// Plugin Context
// =============================================================================

/**
 * The unified plugin context - same shape for all hooks and routes
 */
export interface PluginContext<TStorage extends PluginStorageConfig = PluginStorageConfig> {
	/** Plugin metadata */
	plugin: {
		id: string;
		version: string;
	};

	/** Storage collections - only if plugin declares storage */
	storage: PluginStorage<TStorage>;

	/** Key-value store for config and state */
	kv: KVAccess;

	/** Content access - only if read:content or write:content capability */
	content?: ContentAccess | ContentAccessWithWrite;

	/** Media access - only if read:media or write:media capability */
	media?: MediaAccess | MediaAccessWithWrite;

	/** HTTP client - only if network:fetch capability */
	http?: HttpAccess;

	/** Logger - always available */
	log: LogAccess;

	/** Site information - always available */
	site: SiteInfo;

	/** URL helper - generates absolute URLs from paths. Always available. */
	url(path: string): string;

	/** User access - only if read:users capability */
	users?: UserAccess;

	/** Cron task scheduling - always available, scoped to plugin */
	cron?: CronAccess;

	/** Email access - only if email:send capability and a provider is configured */
	email?: EmailAccess;
}

// =============================================================================
// Cron Types
// =============================================================================

/**
 * Cron access interface �� always available on plugin context, scoped to plugin.
 */
export interface CronAccess {
	/** Schedule a recurring or one-shot task */
	schedule(name: string, opts: { schedule: string; data?: Record<string, unknown> }): Promise<void>;
	/** Cancel a scheduled task */
	cancel(name: string): Promise<void>;
	/** List this plugin's scheduled tasks */
	list(): Promise<CronTaskInfo[]>;
}

/**
 * Task info returned from CronAccess.list()
 */
export interface CronTaskInfo {
	name: string;
	schedule: string;
	nextRunAt: string;
	lastRunAt: string | null;
}

/**
 * Event passed to the `cron` hook handler
 */
export interface CronEvent {
	name: string;
	data?: Record<string, unknown>;
	scheduledAt: string;
}

/**
 * Cron hook handler type
 */
export type CronHandler = (event: CronEvent, ctx: PluginContext) => Promise<void>;

// =============================================================================
// Email Types
// =============================================================================

/**
 * Email access interface — requires `email:send` capability.
 * Undefined when no `email:deliver` provider is configured.
 *
 * Related capabilities:
 * - `email:send` — grants ctx.email (this interface)
 * - `email:provide` — allows registering the `email:deliver` exclusive hook
 * - `email:intercept` — allows registering `email:beforeSend` / `email:afterSend` hooks
 */
export interface EmailAccess {
	send(message: EmailMessage): Promise<void>;
}

/**
 * Email message shape
 */
export interface EmailMessage {
	to: string;
	subject: string;
	text: string;
	html?: string;
}

/**
 * Event passed to email:beforeSend hooks (middleware — transform, validate, cancel)
 */
export interface EmailBeforeSendEvent {
	message: EmailMessage;
	/** Where the email originated — "system" for auth emails, plugin ID for plugin emails */
	source: string;
}

/**
 * Event passed to email:deliver hook (exclusive — exactly one provider delivers)
 */
export interface EmailDeliverEvent {
	message: EmailMessage;
	source: string;
}

/**
 * Event passed to email:afterSend hooks (logging, analytics, fire-and-forget)
 */
export interface EmailAfterSendEvent {
	message: EmailMessage;
	source: string;
}

/**
 * Handler type for email:beforeSend hooks.
 * Returns modified message, or false to cancel delivery.
 */
export type EmailBeforeSendHandler = (
	event: EmailBeforeSendEvent,
	ctx: PluginContext,
) => Promise<EmailMessage | false>;

/**
 * Handler type for email:deliver hooks (exclusive provider).
 */
export type EmailDeliverHandler = (event: EmailDeliverEvent, ctx: PluginContext) => Promise<void>;

/**
 * Handler type for email:afterSend hooks (fire-and-forget).
 */
export type EmailAfterSendHandler = (
	event: EmailAfterSendEvent,
	ctx: PluginContext,
) => Promise<void>;

// =============================================================================
// Comment Types
// =============================================================================

/**
 * Collection comment settings (read from _emdash_collections)
 */
export interface CollectionCommentSettings {
	commentsEnabled: boolean;
	commentsModeration: "all" | "first_time" | "none";
	commentsClosedAfterDays: number;
	commentsAutoApproveUsers: boolean;
}

/**
 * Event passed to comment:beforeCreate hooks (middleware — transform, enrich, reject)
 */
export interface CommentBeforeCreateEvent {
	comment: {
		collection: string;
		contentId: string;
		parentId: string | null;
		authorName: string;
		authorEmail: string;
		authorUserId: string | null;
		body: string;
		ipHash: string | null;
		userAgent: string | null;
	};
	/** Metadata bag — plugins can attach signals for the moderator */
	metadata: Record<string, unknown>;
}

/**
 * Event passed to comment:moderate hook (exclusive — decides initial status)
 */
export interface CommentModerateEvent {
	comment: CommentBeforeCreateEvent["comment"];
	metadata: Record<string, unknown>;
	collectionSettings: CollectionCommentSettings;
	/** Number of prior approved comments from this email address */
	priorApprovedCount: number;
}

/**
 * Moderation decision returned by the comment:moderate handler
 */
export interface ModerationDecision {
	status: "approved" | "pending" | "spam";
	/** Optional reason for admin visibility */
	reason?: string;
}

/**
 * Stored comment shape (full record with id, status, timestamps)
 */
export interface StoredComment {
	id: string;
	collection: string;
	contentId: string;
	parentId: string | null;
	authorName: string;
	authorEmail: string;
	authorUserId: string | null;
	body: string;
	status: string;
	moderationMetadata: Record<string, unknown> | null;
	createdAt: string;
	updatedAt: string;
}

/**
 * Event passed to comment:afterCreate hooks (fire-and-forget)
 */
export interface CommentAfterCreateEvent {
	comment: StoredComment;
	metadata: Record<string, unknown>;
	/** The content item the comment is on */
	content: { id: string; collection: string; slug: string; title?: string };
	/** The content author (for notifications) */
	contentAuthor?: { id: string; name: string | null; email: string };
}

/**
 * Event passed to comment:afterModerate hooks (fire-and-forget, admin status change)
 */
export interface CommentAfterModerateEvent {
	comment: StoredComment;
	previousStatus: string;
	newStatus: string;
	/** The admin who moderated */
	moderator: { id: string; name: string | null };
}

/**
 * Handler type for comment:beforeCreate hooks.
 * Returns modified event, or false to reject the comment.
 */
export type CommentBeforeCreateHandler = (
	event: CommentBeforeCreateEvent,
	ctx: PluginContext,
) => Promise<CommentBeforeCreateEvent | false | void>;

/**
 * Handler type for comment:moderate hook (exclusive provider).
 */
export type CommentModerateHandler = (
	event: CommentModerateEvent,
	ctx: PluginContext,
) => Promise<ModerationDecision>;

/**
 * Handler type for comment:afterCreate hooks (fire-and-forget).
 */
export type CommentAfterCreateHandler = (
	event: CommentAfterCreateEvent,
	ctx: PluginContext,
) => Promise<void>;

/**
 * Handler type for comment:afterModerate hooks (fire-and-forget).
 */
export type CommentAfterModerateHandler = (
	event: CommentAfterModerateEvent,
	ctx: PluginContext,
) => Promise<void>;

// =============================================================================
// Hook Types
// =============================================================================

/**
 * Hook configuration
 */
export interface HookConfig<THandler> {
	/** Explicit ordering - lower numbers run first (default: 100) */
	priority?: number;
	/** Max execution time in ms (default: 5000) */
	timeout?: number;
	/** Run after these plugins */
	dependencies?: string[];
	/** Error handling policy */
	errorPolicy?: "continue" | "abort";
	/**
	 * Mark this hook as exclusive — only one plugin can be the active provider.
	 * Exclusive hooks skip the priority pipeline and dispatch only to the
	 * admin-selected provider. Used for email:deliver, search, image optimization, etc.
	 */
	exclusive?: boolean;
	/** The hook handler */
	handler: THandler;
}

/**
 * Content hook event
 */
export interface ContentHookEvent {
	content: Record<string, unknown>;
	collection: string;
	isNew: boolean;
}

/**
 * Content delete hook event
 */
export interface ContentDeleteEvent {
	id: string;
	collection: string;
}

/**
 * Content publish hook event (fired after publish or unpublish)
 */
export interface ContentPublishEvent {
	content: Record<string, unknown>;
	collection: string;
}

/**
 * Media hook event
 */
export interface MediaUploadEvent {
	file: { name: string; type: string; size: number };
}

/**
 * Media after upload event
 */
export interface MediaAfterUploadEvent {
	media: MediaItem;
}

/**
 * Lifecycle hook event
 */
export interface LifecycleEvent {
	// Empty for install/activate/deactivate
}

/**
 * Uninstall hook event
 */
export interface UninstallEvent {
	deleteData: boolean;
}

// Hook handler types - all receive (event, ctx) with unified context
export type ContentBeforeSaveHandler = (
	event: ContentHookEvent,
	ctx: PluginContext,
) => Promise<Record<string, unknown> | void>;

export type ContentAfterSaveHandler = (
	event: ContentHookEvent,
	ctx: PluginContext,
) => Promise<void>;

export type ContentBeforeDeleteHandler = (
	event: ContentDeleteEvent,
	ctx: PluginContext,
) => Promise<boolean | void>;

export type ContentAfterDeleteHandler = (
	event: ContentDeleteEvent,
	ctx: PluginContext,
) => Promise<void>;

export type ContentAfterPublishHandler = (
	event: ContentPublishEvent,
	ctx: PluginContext,
) => Promise<void>;

export type ContentAfterUnpublishHandler = (
	event: ContentPublishEvent,
	ctx: PluginContext,
) => Promise<void>;

export type MediaBeforeUploadHandler = (
	event: MediaUploadEvent,
	ctx: PluginContext,
) => Promise<{ name: string; type: string; size: number } | void>;

export type MediaAfterUploadHandler = (
	event: MediaAfterUploadEvent,
	ctx: PluginContext,
) => Promise<void>;

export type LifecycleHandler = (event: LifecycleEvent, ctx: PluginContext) => Promise<void>;

export type UninstallHandler = (event: UninstallEvent, ctx: PluginContext) => Promise<void>;

// =============================================================================
// Public Page Contribution Types
// =============================================================================

/** Placement targets for page fragment contributions */
export type PagePlacement = "head" | "body:start" | "body:end";

/**
 * Describes the page being rendered. Passed to page hooks so plugins
 * can decide what to contribute without fetching content themselves.
 */
export interface PublicPageContext {
	url: string;
	path: string;
	locale: string | null;
	kind: "content" | "custom";
	pageType: string;
	title: string | null;
	description: string | null;
	canonical: string | null;
	image: string | null;
	content?: {
		collection: string;
		id: string;
		slug: string | null;
	};
	/** SEO meta for base metadata generation in EmDashHead */
	seo?: {
		ogTitle?: string | null;
		ogDescription?: string | null;
		ogImage?: string | null;
		robots?: string | null;
	};
	/** Article metadata for Open Graph article: tags */
	articleMeta?: {
		publishedTime?: string | null;
		modifiedTime?: string | null;
		author?: string | null;
	};
	/** Site name for structured data and og:site_name */
	siteName?: string;
}

// ── page:metadata ───────────────────────────────────────────────

export interface PageMetadataEvent {
	page: PublicPageContext;
}

/**
 * Allowed rel values for link contributions.
 * This is a security-critical allowlist -- sandboxed plugins can only inject
 * link tags with these rel values. Adding "stylesheet", "prefetch", "prerender"
 * etc. would allow sandboxed plugins to inject external resources.
 */
export type PageMetadataLinkRel =
	| "canonical"
	| "alternate"
	| "author"
	| "license"
	| "site.standard.document";

export type PageMetadataContribution =
	| { kind: "meta"; name: string; content: string; key?: string }
	| { kind: "property"; property: string; content: string; key?: string }
	| { kind: "link"; rel: PageMetadataLinkRel; href: string; hreflang?: string; key?: string }
	| {
			kind: "jsonld";
			id?: string;
			graph: Record<string, unknown> | Array<Record<string, unknown>>;
	  };

export type PageMetadataHandler = (
	event: PageMetadataEvent,
	ctx: PluginContext,
) =>
	| PageMetadataContribution
	| PageMetadataContribution[]
	| null
	| Promise<PageMetadataContribution | PageMetadataContribution[] | null>;

// ── page:fragments (trusted-only) ──────────────────────────────

export interface PageFragmentEvent {
	page: PublicPageContext;
}

export type PageFragmentContribution =
	| {
			kind: "external-script";
			placement: PagePlacement;
			src: string;
			async?: boolean;
			defer?: boolean;
			attributes?: Record<string, string>;
			key?: string;
	  }
	| {
			kind: "inline-script";
			placement: PagePlacement;
			code: string;
			attributes?: Record<string, string>;
			key?: string;
	  }
	| {
			kind: "html";
			placement: PagePlacement;
			html: string;
			key?: string;
	  };

export type PageFragmentHandler = (
	event: PageFragmentEvent,
	ctx: PluginContext,
) =>
	| PageFragmentContribution
	| PageFragmentContribution[]
	| null
	| Promise<PageFragmentContribution | PageFragmentContribution[] | null>;

/**
 * Plugin hooks definition
 */
export interface PluginHooks {
	// Lifecycle hooks
	"plugin:install"?: HookConfig<LifecycleHandler> | LifecycleHandler;
	"plugin:activate"?: HookConfig<LifecycleHandler> | LifecycleHandler;
	"plugin:deactivate"?: HookConfig<LifecycleHandler> | LifecycleHandler;
	"plugin:uninstall"?: HookConfig<UninstallHandler> | UninstallHandler;

	// Content hooks
	"content:beforeSave"?: HookConfig<ContentBeforeSaveHandler> | ContentBeforeSaveHandler;
	"content:afterSave"?: HookConfig<ContentAfterSaveHandler> | ContentAfterSaveHandler;
	"content:beforeDelete"?: HookConfig<ContentBeforeDeleteHandler> | ContentBeforeDeleteHandler;
	"content:afterDelete"?: HookConfig<ContentAfterDeleteHandler> | ContentAfterDeleteHandler;
	"content:afterPublish"?: HookConfig<ContentAfterPublishHandler> | ContentAfterPublishHandler;
	"content:afterUnpublish"?:
		| HookConfig<ContentAfterUnpublishHandler>
		| ContentAfterUnpublishHandler;

	// Media hooks
	"media:beforeUpload"?: HookConfig<MediaBeforeUploadHandler> | MediaBeforeUploadHandler;
	"media:afterUpload"?: HookConfig<MediaAfterUploadHandler> | MediaAfterUploadHandler;

	// Cron hook
	cron?: HookConfig<CronHandler> | CronHandler;

	// Email hooks
	"email:beforeSend"?: HookConfig<EmailBeforeSendHandler> | EmailBeforeSendHandler;
	"email:deliver"?: HookConfig<EmailDeliverHandler> | EmailDeliverHandler;
	"email:afterSend"?: HookConfig<EmailAfterSendHandler> | EmailAfterSendHandler;

	// Comment hooks
	"comment:beforeCreate"?: HookConfig<CommentBeforeCreateHandler> | CommentBeforeCreateHandler;
	"comment:moderate"?: HookConfig<CommentModerateHandler> | CommentModerateHandler;
	"comment:afterCreate"?: HookConfig<CommentAfterCreateHandler> | CommentAfterCreateHandler;
	"comment:afterModerate"?: HookConfig<CommentAfterModerateHandler> | CommentAfterModerateHandler;

	// Public page hooks
	"page:metadata"?: HookConfig<PageMetadataHandler> | PageMetadataHandler;
	"page:fragments"?: HookConfig<PageFragmentHandler> | PageFragmentHandler;
}

/**
 * Hook names
 */
export type HookName = keyof PluginHooks;

/**
 * Hook metadata entry in a plugin manifest.
 * Replaces the plain hook name string with structured metadata.
 */
export interface ManifestHookEntry {
	name: string;
	exclusive?: boolean;
	priority?: number;
	timeout?: number;
}

/**
 * Route metadata entry in a plugin manifest.
 * Replaces the plain route name string with structured metadata.
 */
export interface ManifestRouteEntry {
	name: string;
	public?: boolean;
}

/**
 * Resolved hook with normalized config
 */
export interface ResolvedHook<THandler> {
	priority: number;
	timeout: number;
	dependencies: string[];
	errorPolicy: "continue" | "abort";
	/** Whether this hook is exclusive (provider pattern) */
	exclusive: boolean;
	handler: THandler;
	pluginId: string;
}

// =============================================================================
// Request Metadata Types
// =============================================================================

/**
 * Geographic location information derived from the request.
 * Available when running on Cloudflare Workers (via the `cf` object).
 */
export interface GeoInfo {
	country: string | null;
	region: string | null;
	city: string | null;
}

/**
 * Normalized request metadata available to plugin route handlers.
 * Extracted from request headers and platform-specific properties.
 */
export interface RequestMeta {
	ip: string | null;
	userAgent: string | null;
	referer: string | null;
	geo: GeoInfo | null;
}

// =============================================================================
// Route Types
// =============================================================================

/**
 * Route handler context extends plugin context with request-specific data
 */
export interface RouteContext<TInput = unknown> extends PluginContext {
	/** Validated input from request body */
	input: TInput;
	/** Original request */
	request: Request;
	/** Normalized request metadata (IP, user agent, geo) */
	requestMeta: RequestMeta;
}

/**
 * Route definition
 */
export interface PluginRoute<TInput = unknown> {
	/** Zod schema for input validation */
	input?: z.ZodType<TInput>;
	/**
	 * Mark this route as publicly accessible (no authentication required).
	 * Public routes skip session/token auth and CSRF checks.
	 */
	public?: boolean;
	/** Route handler */
	handler: (ctx: RouteContext<TInput>) => Promise<unknown>;
}

// =============================================================================
// Plugin Definition
// =============================================================================

/**
 * Admin page definition
 */
export interface PluginAdminPage {
	path: string;
	label: string;
	icon?: string;
}

/**
 * Dashboard widget definition
 */
export interface PluginDashboardWidget {
	id: string;
	size?: "full" | "half" | "third";
	title?: string;
}

/**
 * Settings field types (for admin UI generation)
 */
export type SettingFieldType = "string" | "number" | "boolean" | "select" | "secret";

export interface BaseSettingField {
	type: SettingFieldType;
	label: string;
	description?: string;
}

export interface StringSettingField extends BaseSettingField {
	type: "string";
	default?: string;
	multiline?: boolean;
}

export interface NumberSettingField extends BaseSettingField {
	type: "number";
	default?: number;
	min?: number;
	max?: number;
}

export interface BooleanSettingField extends BaseSettingField {
	type: "boolean";
	default?: boolean;
}

export interface SelectSettingField extends BaseSettingField {
	type: "select";
	options: Array<{ value: string; label: string }>;
	default?: string;
}

export interface SecretSettingField extends BaseSettingField {
	type: "secret";
}

export type SettingField =
	| StringSettingField
	| NumberSettingField
	| BooleanSettingField
	| SelectSettingField
	| SecretSettingField;

/**
 * Block Kit element for block editing fields.
 * This is the `Element` discriminated union from `@emdash-cms/blocks`.
 * Plugin authors should use `@emdash-cms/blocks` builder functions to create these.
 */
export type PortableTextBlockField = Element;

/**
 * Configuration for a Portable Text block type contributed by a plugin
 */
export interface PortableTextBlockConfig {
	/** Block type name (must match the `_type` in Portable Text) */
	type: string;
	/** Human-readable label shown in slash commands and modals */
	label: string;
	/** Icon key (e.g., "video", "code", "link", "link-external") */
	icon?: string;
	/** Description shown in slash command menu */
	description?: string;
	/** Placeholder text for the URL input */
	placeholder?: string;
	/** Block Kit form fields for the editing UI. If declared, replaces the simple URL input. */
	fields?: PortableTextBlockField[];
}

/**
 * Configuration for a field widget type contributed by a plugin.
 * A field widget provides a custom editing UI for a schema field.
 * The field references the widget via `widget: "pluginId:widgetName"`.
 */
export interface FieldWidgetConfig {
	/** Widget name (without plugin ID prefix) */
	name: string;
	/** Human-readable label for the admin UI */
	label: string;
	/** Which field types this widget can edit (e.g., ["json", "string"]) */
	fieldTypes: FieldType[];
	/** Block Kit elements for sandboxed rendering. Omit for trusted plugins using React. */
	elements?: Element[];
}

/**
 * Admin configuration
 */
export interface PluginAdminConfig {
	/** Module specifier for admin UI exports (e.g., "@emdash-cms/plugin-audit-log/admin") */
	entry?: string;
	/** Settings schema for auto-generated UI */
	settingsSchema?: Record<string, SettingField>;
	/** Admin pages */
	pages?: PluginAdminPage[];
	/** Dashboard widgets */
	widgets?: PluginDashboardWidget[];
	/** Portable Text block types this plugin provides */
	portableTextBlocks?: PortableTextBlockConfig[];
	/** Field widget types this plugin provides */
	fieldWidgets?: FieldWidgetConfig[];
}

/**
 * Plugin definition - input to definePlugin()
 */
export interface PluginDefinition<TStorage extends PluginStorageConfig = PluginStorageConfig> {
	/** Unique plugin identifier */
	id: string;
	/** Plugin version (semver) */
	version: string;

	/** Declared capabilities */
	capabilities?: PluginCapability[];

	/** Allowed hosts for network:fetch (wildcards supported: *.example.com) */
	allowedHosts?: string[];

	/** Storage collections with indexes */
	storage?: TStorage;

	/** Hooks */
	hooks?: PluginHooks;

	/** API routes */
	routes?: Record<string, PluginRoute>;

	/** Admin UI configuration */
	admin?: PluginAdminConfig;
}

/**
 * Resolved plugin - after definePlugin() processing
 */
export interface ResolvedPlugin<TStorage extends PluginStorageConfig = PluginStorageConfig> {
	id: string;
	version: string;
	capabilities: PluginCapability[];
	allowedHosts: string[];
	storage: TStorage;
	hooks: ResolvedPluginHooks;
	routes: Record<string, PluginRoute>;
	admin: PluginAdminConfig;
}

/**
 * Resolved hooks with normalized config
 */
export interface ResolvedPluginHooks {
	"plugin:install"?: ResolvedHook<LifecycleHandler>;
	"plugin:activate"?: ResolvedHook<LifecycleHandler>;
	"plugin:deactivate"?: ResolvedHook<LifecycleHandler>;
	"plugin:uninstall"?: ResolvedHook<UninstallHandler>;
	"content:beforeSave"?: ResolvedHook<ContentBeforeSaveHandler>;
	"content:afterSave"?: ResolvedHook<ContentAfterSaveHandler>;
	"content:beforeDelete"?: ResolvedHook<ContentBeforeDeleteHandler>;
	"content:afterDelete"?: ResolvedHook<ContentAfterDeleteHandler>;
	"content:afterPublish"?: ResolvedHook<ContentAfterPublishHandler>;
	"content:afterUnpublish"?: ResolvedHook<ContentAfterUnpublishHandler>;
	"media:beforeUpload"?: ResolvedHook<MediaBeforeUploadHandler>;
	"media:afterUpload"?: ResolvedHook<MediaAfterUploadHandler>;
	cron?: ResolvedHook<CronHandler>;
	"email:beforeSend"?: ResolvedHook<EmailBeforeSendHandler>;
	"email:deliver"?: ResolvedHook<EmailDeliverHandler>;
	"email:afterSend"?: ResolvedHook<EmailAfterSendHandler>;
	"comment:beforeCreate"?: ResolvedHook<CommentBeforeCreateHandler>;
	"comment:moderate"?: ResolvedHook<CommentModerateHandler>;
	"comment:afterCreate"?: ResolvedHook<CommentAfterCreateHandler>;
	"comment:afterModerate"?: ResolvedHook<CommentAfterModerateHandler>;
	"page:metadata"?: ResolvedHook<PageMetadataHandler>;
	"page:fragments"?: ResolvedHook<PageFragmentHandler>;
}

// =============================================================================
// Standard Plugin Format (Unified Plugin Format)
// =============================================================================

/**
 * Standard plugin hook handler -- same as sandbox entry format.
 * Receives the event as the first argument and a PluginContext as the second.
 *
 * Plugin authors annotate their event parameters with specific types for IDE
 * support. At the type level, we accept any function with compatible arity.
 */
// eslint-disable-next-line typescript-eslint/no-explicit-any -- must accept handlers with specific event types
export type StandardHookHandler = (...args: any[]) => Promise<any>;

/**
 * Standard plugin hook entry -- either a bare handler or a config object.
 */
export type StandardHookEntry =
	| StandardHookHandler
	| {
			handler: StandardHookHandler;
			priority?: number;
			timeout?: number;
			dependencies?: string[];
			errorPolicy?: "continue" | "abort";
			exclusive?: boolean;
	  };

/**
 * Standard plugin route handler -- takes (routeCtx, pluginCtx) like sandbox entries.
 * The routeCtx contains input and request info; pluginCtx is the full plugin context.
 *
 * Uses `any` for routeCtx to allow plugins to access properties like
 * `routeCtx.request.url` without needing exact type matches across
 * trusted (Request object) and sandboxed (plain object) modes.
 */
// eslint-disable-next-line typescript-eslint/no-explicit-any -- see above
export type StandardRouteHandler = (routeCtx: any, ctx: PluginContext) => Promise<unknown>;

/**
 * Standard plugin route entry -- either a config object with handler, or just a handler.
 */
export interface StandardRouteEntry {
	handler: StandardRouteHandler;
	input?: unknown;
	public?: boolean;
}

/**
 * Standard plugin definition -- the sandbox entry format.
 * Used by standard plugins that work in both trusted and sandboxed modes.
 * No id/version/capabilities -- those come from the descriptor.
 *
 * This is the input to definePlugin() for standard-format plugins.
 *
 * The hooks and routes use permissive types (Record<string, any>) so that
 * plugin authors can annotate their handlers with specific event types
 * without type errors from strictFunctionTypes contravariance.
 */
export interface StandardPluginDefinition {
	// eslint-disable-next-line typescript-eslint/no-explicit-any -- must accept handlers with specific event/route types
	hooks?: Record<string, any>;
	// eslint-disable-next-line typescript-eslint/no-explicit-any -- must accept handlers with specific event/route types
	routes?: Record<string, any>;
}

/**
 * Check if a value is a StandardPluginDefinition (has hooks/routes but no id/version).
 */
export function isStandardPluginDefinition(value: unknown): value is StandardPluginDefinition {
	if (typeof value !== "object" || value === null) return false;
	// Standard format: has hooks or routes, but NOT id+version (which are on PluginDefinition)
	const hasPluginShape = "hooks" in value || "routes" in value;
	const hasNativeShape = "id" in value && "version" in value;
	return hasPluginShape && !hasNativeShape;
}

// =============================================================================
// Plugin Admin Exports
// =============================================================================

/**
 * What a plugin exports from its /admin entrypoint
 * Uses generic component type to avoid React dependency
 */
export interface PluginAdminExports {
	widgets?: Record<string, JSX.Element>;
	pages?: Record<string, JSX.Element>;
	fields?: Record<string, JSX.Element>;
}

// =============================================================================
// Sandbox Types
// =============================================================================

/**
 * Plugin manifest - the metadata portion of a plugin bundle
 * Used for sandboxed plugins loaded from marketplace
 */
export interface PluginManifest {
	id: string;
	version: string;
	capabilities: PluginCapability[];
	allowedHosts: string[];
	storage: PluginStorageConfig;
	/** Hook declarations — either plain name strings or structured objects */
	hooks: Array<ManifestHookEntry | HookName>;
	/** Route declarations — either plain name strings or structured objects */
	routes: Array<ManifestRouteEntry | string>;
	admin: PluginAdminConfig;
}
