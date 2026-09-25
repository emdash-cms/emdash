/**
 * EmDashClient — typed HTTP client for the EmDash REST API.
 *
 * Handles auth, CSRF, PT ↔ Markdown conversion, and optional `_rev`
 * concurrency tokens. Shared foundation for the CLI and future MCP server.
 *
 * @example
 * ```ts
 * import { EmDashClient } from "emdash/client";
 *
 * const client = new EmDashClient({
 *   baseUrl: "http://localhost:4321",
 *   devBypass: true,
 * });
 *
 * const posts = await client.list("posts", { status: "published" });
 * ```
 */

import mime from "mime/lite";

import type { ContentFieldFilters } from "../content-list-query.js";
import type {
	BlockType,
	CreateBlockTypeInput,
	UpdateBlockTypeInput,
} from "../schema/block-types.js";
import type { Sha256Digest } from "../transfer/format/digest.js";
import type { SiteImportDecisionsInput, SiteImportPlan } from "../transfer/format/plan.js";
import type { SiteImportReceipt } from "../transfer/format/receipt.js";
import type { PublicTransferOperation } from "../transfer/ops/operations.js";
import type { FieldSchema } from "./portable-text.js";
import { convertDataForRead, convertDataForWrite } from "./portable-text.js";
import type { Interceptor } from "./transport.js";
import {
	createTransport,
	csrfInterceptor,
	devBypassInterceptor,
	refreshInterceptor,
	tokenInterceptor,
} from "./transport.js";

// Regex patterns for client utilities
const TRAILING_SLASH_PATTERN = /\/$/;
const DECIMAL_PATTERN = /^\d+$/;
const SHA256_ETAG_PATTERN = /^"([0-9a-f]{64})"$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mimeFromFilename(filename: string): string {
	return mime.getType(filename) ?? "application/octet-stream";
}

function idempotencyHeader(request: { idempotencyKey?: string }): Record<string, string> {
	return request.idempotencyKey === undefined ? {} : { "Idempotency-Key": request.idempotencyKey };
}

function pageQuery(options?: { limit?: number; cursor?: string }): string {
	const params = new URLSearchParams();
	if (options?.limit !== undefined) params.set("limit", String(options.limit));
	if (options?.cursor !== undefined) params.set("cursor", options.cursor);
	const qs = params.toString();
	return qs ? `?${qs}` : "";
}

/** Encode a site package path (`records/post/000000.ndjson`) segment by segment */
function encodePackagePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmDashClientOptions {
	/** Base URL of the EmDash instance */
	baseUrl: string;
	/** API token (ec_pat_...) or OAuth token (ec_oat_...) */
	token?: string;
	/** OAuth refresh token for auto-refresh on 401 */
	refreshToken?: string;
	/** Called when a token is refreshed (for persisting new access token) */
	onTokenRefresh?: (accessToken: string, expiresIn: number) => void;
	/** Use dev-bypass authentication (localhost only) */
	devBypass?: boolean;
	/** Additional request interceptors */
	interceptors?: Interceptor[];
}

/** Standard API error shape */
export interface ApiError {
	code: string;
	message: string;
	details?: Record<string, unknown>;
}

/** Standard API response wrapper */
export interface ClientResponse<T> {
	success: true;
	data: T;
}

/** Paginated list response */
export interface ListResult<T> {
	items: T[];
	nextCursor?: string;
}

/** Content item as returned by the API */
export interface ContentItem {
	id: string;
	type: string;
	slug: string | null;
	status: string;
	data: Record<string, unknown>;
	authorId: string | null;
	createdAt: string;
	updatedAt: string;
	publishedAt: string | null;
	scheduledAt: string | null;
	liveRevisionId: string | null;
	draftRevisionId: string | null;
	locale: string | null;
	translationGroup: string | null;
	_rev?: string;
}

/** Collection metadata */
export interface Collection {
	slug: string;
	label: string;
	labelSingular: string;
	description?: string;
	icon?: string;
	supports: string[];
}

/** Collection with fields */
export interface CollectionWithFields extends Collection {
	fields: Field[];
}

/** Field metadata */
export interface Field {
	slug: string;
	label: string;
	type: string;
	required: boolean;
	unique: boolean;
	defaultValue?: unknown;
	validation?: unknown;
	widget?: string;
	options?: unknown;
	sortOrder?: number;
	blockTypes?: BlockType[];
	blockTypeFingerprint?: string;
}

/** Aggregate trust state for media usage reads */
export type MediaUsageCoverageStatus =
	| "complete"
	| "never"
	| "running"
	| "partial"
	| "failed"
	| "stale"
	| "unknown";

/** Aggregate media usage coverage across all content collections */
export interface MediaUsageCoverage {
	scope: "all_content_collections";
	status: MediaUsageCoverageStatus;
}

/** Coverage-aware usage count for a media item */
export interface MediaUsageSummary {
	count: number | null;
	coverage: MediaUsageCoverage;
}

/** One indexed media reference within a content source */
export interface MediaUsageOccurrenceDetail {
	fieldSlug: string;
	fieldPath: string;
	occurrenceIndex: number;
	referenceType: "image_field" | "file_field" | "portable_text_image" | "unknown";
}

/** Indexed references from one visible content source */
export interface MediaUsageSourceDetail {
	variant: "columns" | "draft_overlay";
	occurrences: MediaUsageOccurrenceDetail[];
}

/** One content entry that references a media item */
export interface MediaUsageEntryDetail {
	collection: string;
	contentId: string;
	title: string | null;
	slug: string | null;
	locale: string | null;
	status: string | null;
	scheduledAt: string | null;
	deletedAt: string | null;
	sources: MediaUsageSourceDetail[];
}

/** A site setting that selects a media item */
export interface MediaUsageSiteSettingDetail {
	setting: "logo" | "favicon" | "seo.defaultOgImage";
}

/** Entry-grouped media usage details */
export interface MediaUsageDetailsResponse {
	items: MediaUsageEntryDetail[];
	nextCursor?: string;
	siteSettings: MediaUsageSiteSettingDetail[];
	coverage: MediaUsageCoverage;
}

/** Media item */
export interface MediaItem {
	id: string;
	filename: string;
	key: string;
	mimeType: string;
	size: number;
	width?: number;
	height?: number;
	focalX?: number | null;
	focalY?: number | null;
	alt?: string;
	caption?: string;
	createdAt: string;
	updatedAt: string;
	folderId?: string | null;
	usage?: MediaUsageSummary;
}

/** Result of assigning local media to a folder or the Main library */
export interface MediaFolderAssignment {
	id: string;
	folderId: string | null;
}

/** Flat media-library folder */
export interface MediaFolder {
	id: string;
	name: string;
}

/** Media usage repair request */
export type MediaUsageRepairInput = { scope: "collection"; collection: string } | { scope: "all" };

/** Media usage repair status */
export type MediaUsageRepairStatus = "complete" | "partial" | "failed" | "stale";

/** Per-collection media usage repair summary */
export interface MediaUsageRepairCollectionSummary {
	collection: string;
	status: MediaUsageRepairStatus;
	indexedSourceCount: number;
	failedSourceCount: number;
	skippedSourceCount: number;
	deletedSourceCount: number;
	lastErrorCode: string | null;
	startedAt: string;
	completedAt: string | null;
}

/** Media usage repair response */
export interface MediaUsageRepairResponse {
	status: MediaUsageRepairStatus;
	indexedSourceCount: number;
	failedSourceCount: number;
	skippedSourceCount: number;
	deletedSourceCount: number;
	collections: MediaUsageRepairCollectionSummary[];
}

export interface MediaUsageProgress {
	status: "indexing" | "ready" | "needs_attention";
	readyCollections: number;
	totalCollections: number;
}

export interface MediaUsageProgressAdvanceResponse {
	activation: MediaUsageActivationStatus;
	progress: MediaUsageProgress | null;
	nextRequestInMs: 0 | 30_000 | null;
}

/** Durable media usage entry-work state */
export type MediaUsageWorkState = "pending" | "retry" | "leased" | "failed";

/** Redacted operator view of one durable media usage job */
export interface MediaUsageWorkItem {
	collectionId: string;
	collectionSlug: string;
	contentId: string;
	state: MediaUsageWorkState;
	attemptCount: number;
	nextAttemptAt: string;
	leaseExpiresAt: string | null;
	lastAttemptedAt: string | null;
	lastErrorCode: string | null;
	updatedAt: string;
}

/** Filters and pagination for durable media usage work */
export interface MediaUsageWorkListOptions {
	collection: string;
	state?: MediaUsageWorkState;
	limit?: number;
	cursor?: string;
}

/** One bounded page of durable media usage work */
export interface MediaUsageWorkListResponse {
	items: MediaUsageWorkItem[];
	nextCursor?: string;
}

/** Identity for explicitly retrying one durable media usage job */
export interface MediaUsageWorkRetryInput {
	collectionId: string;
	contentId: string;
}

/** Result of explicitly retrying one durable media usage job */
export interface MediaUsageWorkRetryResponse {
	changed: boolean;
	item: MediaUsageWorkItem;
}

export interface MediaUsageActivationStatus {
	state: "expanded" | "activating" | "active";
	collectionCursor: string | null;
	attemptCount: number;
	drainConfirmedAt: string | null;
	lastAttemptedAt: string | null;
	lastErrorCode: "MEDIA_USAGE_ACTIVATION_FAILED" | null;
	leaseExpiresAt: string | null;
	activatedAt: string | null;
	updatedAt: string;
}

export interface MediaUsageActivationAdvanceInput {
	writersDrained: true;
}

export interface MediaUsageActivationAdvanceResponse {
	outcome: "activating" | "active";
	processedCollections: number;
	activation: MediaUsageActivationStatus;
}

export type MediaUsageCollectionDeletionState = "pending" | "retry" | "leased" | "failed";
export type MediaUsageCollectionDeletionPhase =
	| "fence"
	| "registry"
	| "table"
	| "work"
	| "sources"
	| "status"
	| "finalize";
export interface MediaUsageCollectionDeletionItem {
	collectionId: string;
	collectionSlug: string;
	state: MediaUsageCollectionDeletionState;
	phase: MediaUsageCollectionDeletionPhase;
	attemptCount: number;
	nextAttemptAt: string;
	leaseExpiresAt: string | null;
	lastErrorCode: string | null;
	updatedAt: string;
}
export interface MediaUsageCollectionDeletionListResponse {
	items: MediaUsageCollectionDeletionItem[];
	nextCursor?: string;
}

/** Search result */
export interface SearchResult {
	id: string;
	collection: string;
	title: string;
	excerpt?: string;
	score: number;
}

/** Taxonomy */
export interface Taxonomy {
	name: string;
	label: string;
	hierarchical: boolean;
}

/** Taxonomy term */
export interface Term {
	id: string;
	slug: string;
	label: string;
	parentId?: string | null;
	description?: string;
	count?: number;
}

/** Menu */
export interface Menu {
	name: string;
	label: string;
}

/** Menu with items */
export interface MenuWithItems extends Menu {
	items: MenuItem[];
}

/** Menu item */
export interface MenuItem {
	id: string;
	type: string;
	label: string;
	customUrl?: string;
	referenceCollection?: string;
	referenceId?: string;
	target?: string;
	parentId?: string | null;
	sortOrder: number;
}

/** Full schema export (returned by /api/schema) */
export interface SchemaExport {
	collections: Array<{
		slug: string;
		label: string;
		labelSingular: string;
		description?: string;
		icon?: string;
		supports: string[];
		fields: Array<{
			slug: string;
			label: string;
			type: string;
			required: boolean;
			unique: boolean;
			defaultValue?: unknown;
			validation?: unknown;
			widget?: string;
			options?: unknown;
		}>;
	}>;
	version: string;
}

/** Manifest — full schema + field descriptors */
export interface Manifest {
	version: string;
	hash: string;
	collections: Record<
		string,
		{
			label: string;
			labelSingular: string;
			supports: string[];
			fields: Record<string, { kind: string; label?: string; required?: boolean }>;
		}
	>;
}

/** User as listed by the admin users API */
export interface UserSummary {
	id: string;
	email: string;
	name: string | null;
	role: number;
	disabled: boolean;
}

/** A site transfer operation (export or import) */
export type TransferOperation = PublicTransferOperation;

/** Site transfer capabilities of an instance */
export interface TransferCapabilities {
	formatVersions: string[];
	features: string[];
	optionalFeatures: string[];
	limits: {
		manifestBytes: number;
		recordLineBytes: number;
		chunkBytes: number;
		chunkRecords: number;
		totalRecords: number;
		totalFiles: number;
		indexChunks: number;
		jsonDepth: number;
		maxBlobBytes: number;
	};
	portableDomain: {
		empty: boolean;
		blockers: Array<Record<string, string>>;
		seededScaffold: Array<Record<string, string>>;
	};
}

/** Result of one bounded `advance` step */
export interface TransferAdvanceResult {
	operation: TransferOperation;
	/** Milliseconds until the next step should be requested, or null once the operation has ended. */
	nextRequestInMs: number | null;
}

/** A package file the import has declared but not yet received */
export interface TransferPackageFile {
	path: string;
	bytes: number;
	sha256: string;
}

export interface TransferImportCreateResult {
	operation: TransferOperation;
	created: boolean;
	missing: ListResult<TransferPackageFile>;
}

export interface TransferFileUploadResult {
	path: string;
	bytes: number;
	/** True when the file was already stored and the uploaded bytes matched it. */
	alreadyVerified: boolean;
	/** Declared files still to upload. */
	remaining: number;
}

export interface TransferImportAnalyzeResult {
	operation: TransferOperation;
	plan?: SiteImportPlan;
	planDigest?: Sha256Digest;
	/** Milliseconds until the next step should be requested, or null once analysis has ended. */
	nextRequestInMs: number | null;
}

export interface TransferImportStatus {
	operation: TransferOperation;
	files: { declared: number; verified: number };
}

/** A downloaded export file, streamed */
export interface TransferFileDownload {
	body: ReadableStream<Uint8Array>;
	/** Size from `Content-Length`, when sent */
	bytes: number | null;
	/** Hex SHA-256 from the `ETag`, when sent */
	sha256: string | null;
}

// ---------------------------------------------------------------------------
// Client errors
// ---------------------------------------------------------------------------

export class EmDashApiError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message: string,
		public readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "EmDashApiError";
	}
}

export class EmDashClientError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EmDashClientError";
	}
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class EmDashClient {
	private readonly baseUrl: string;
	private readonly transport: { fetch: (request: Request) => Promise<Response> };

	/** Cached field schemas per collection for PT conversion */
	private fieldSchemaCache = new Map<string, FieldSchema[]>();

	constructor(options: EmDashClientOptions) {
		this.baseUrl = options.baseUrl.replace(TRAILING_SLASH_PATTERN, "");

		// Build interceptor chain
		const interceptors: Interceptor[] = [csrfInterceptor()];

		if (options.token) {
			interceptors.push(tokenInterceptor(options.token));
		} else if (options.devBypass) {
			interceptors.push(devBypassInterceptor(this.baseUrl));
		}

		// Auto-refresh expired OAuth tokens
		if (options.refreshToken) {
			interceptors.push(
				refreshInterceptor({
					refreshToken: options.refreshToken,
					tokenEndpoint: `${this.baseUrl}/_emdash/api/oauth/token/refresh`,
					onTokenRefreshed: options.onTokenRefresh
						? (accessToken, _refreshToken, expiresAt) => {
								const expiresIn = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000);
								options.onTokenRefresh!(accessToken, expiresIn);
							}
						: undefined,
				}),
			);
		}

		if (options.interceptors) {
			interceptors.push(...options.interceptors);
		}

		this.transport = createTransport({ interceptors });
	}

	// -----------------------------------------------------------------------
	// Schema
	// -----------------------------------------------------------------------

	/** List all collections */
	async collections(): Promise<Collection[]> {
		const data = await this.request<{ items: Collection[] }>("GET", "/schema/collections");
		return data.items;
	}

	/** Get a single collection with its fields */
	async collection(slug: string): Promise<CollectionWithFields> {
		const data = await this.request<{ item: CollectionWithFields }>(
			"GET",
			`/schema/collections/${encodeURIComponent(slug)}?includeFields=true`,
		);
		const col = data.item;
		// Cache field schemas for PT conversion
		if (col.fields) {
			this.fieldSchemaCache.set(
				slug,
				col.fields.map((f) => ({ slug: f.slug, type: f.type, blockTypes: f.blockTypes })),
			);
		}
		return col;
	}

	async blockTypes(): Promise<BlockType[]> {
		const data = await this.request<{ items: BlockType[] }>("GET", "/schema/block-types");
		return data.items;
	}

	async blockType(slug: string): Promise<BlockType> {
		const data = await this.request<{ item: BlockType }>(
			"GET",
			`/schema/block-types/${encodeURIComponent(slug)}`,
		);
		return data.item;
	}

	async createBlockType(input: CreateBlockTypeInput): Promise<BlockType> {
		const data = await this.request<{ item: BlockType }>("POST", "/schema/block-types", input);
		return data.item;
	}

	async updateBlockType(slug: string, input: UpdateBlockTypeInput): Promise<BlockType> {
		const data = await this.request<{ item: BlockType }>(
			"PUT",
			`/schema/block-types/${encodeURIComponent(slug)}`,
			input,
		);
		return data.item;
	}

	async activateBlockTypeVersion(
		slug: string,
		version: number,
		expectedFingerprint: string,
	): Promise<BlockType> {
		const data = await this.request<{ item: BlockType }>(
			"POST",
			`/schema/block-types/${encodeURIComponent(slug)}/versions/${version}/activate`,
			{ expectedFingerprint },
		);
		return data.item;
	}

	/** Create a collection */
	async createCollection(input: {
		slug: string;
		label: string;
		labelSingular?: string;
		description?: string;
		icon?: string;
		supports?: string[];
	}): Promise<Collection> {
		const data = await this.request<{ item: Collection }>("POST", "/schema/collections", input);
		return data.item;
	}

	/** Delete a collection */
	async deleteCollection(slug: string): Promise<void> {
		await this.request<unknown>("DELETE", `/schema/collections/${encodeURIComponent(slug)}`);
	}

	/** Create a field on a collection */
	async createField(
		collection: string,
		input: {
			slug: string;
			type: string;
			label: string;
			required?: boolean;
			unique?: boolean;
			defaultValue?: unknown;
			validation?: unknown;
			widget?: string;
			options?: unknown;
			sortOrder?: number;
		},
	): Promise<Field> {
		const data = await this.request<{ item: Field }>(
			"POST",
			`/schema/collections/${encodeURIComponent(collection)}/fields`,
			input,
		);
		// Invalidate field cache
		this.fieldSchemaCache.delete(collection);
		return data.item;
	}

	/** Delete a field from a collection */
	async deleteField(collection: string, fieldSlug: string): Promise<void> {
		await this.request<unknown>(
			"DELETE",
			`/schema/collections/${encodeURIComponent(collection)}/fields/${encodeURIComponent(fieldSlug)}`,
		);
		this.fieldSchemaCache.delete(collection);
	}

	/** Get full manifest (schema + field descriptors + features) */
	async manifest(): Promise<Manifest> {
		return this.request<Manifest>("GET", "/manifest");
	}

	/** Export full schema as JSON (used by `emdash types`) */
	async schemaExport(): Promise<SchemaExport> {
		return this.request<SchemaExport>("GET", "/schema");
	}

	/** Export schema as TypeScript type definitions (used by `emdash types`) */
	async schemaTypes(): Promise<string> {
		const response = await this.requestRaw("GET", "/schema?format=typescript");
		await this.assertOk(response);
		return response.text();
	}

	// -----------------------------------------------------------------------
	// Content
	// -----------------------------------------------------------------------

	/** List content in a collection */
	async list(
		collection: string,
		options?: {
			status?: string;
			limit?: number;
			cursor?: string;
			orderBy?: string;
			order?: "asc" | "desc";
			locale?: string;
			/** AND-combined filters over custom fields explicitly marked as indexed. */
			fieldFilters?: ContentFieldFilters;
		},
	): Promise<ListResult<ContentItem>> {
		const params = new URLSearchParams();
		if (options?.status) params.set("status", options.status);
		if (options?.limit) params.set("limit", String(options.limit));
		if (options?.cursor) params.set("cursor", options.cursor);
		if (options?.orderBy) params.set("orderBy", options.orderBy);
		if (options?.order) params.set("order", options.order);
		if (options?.locale) params.set("locale", options.locale);
		if (options?.fieldFilters && Object.keys(options.fieldFilters).length > 0) {
			params.set("fieldFilters", JSON.stringify(options.fieldFilters));
		}

		const qs = params.toString();
		const path = `/content/${encodeURIComponent(collection)}${qs ? `?${qs}` : ""}`;
		return this.request<ListResult<ContentItem>>("GET", path);
	}

	/** Async iterator that auto-follows cursors */
	async *listAll(
		collection: string,
		options?: {
			status?: string;
			limit?: number;
			orderBy?: string;
			order?: "asc" | "desc";
			locale?: string;
			/** AND-combined filters over custom fields explicitly marked as indexed. */
			fieldFilters?: ContentFieldFilters;
		},
	): AsyncGenerator<ContentItem> {
		let cursor: string | undefined;
		do {
			const result = await this.list(collection, { ...options, cursor });
			for (const item of result.items) {
				yield item;
			}
			cursor = result.nextCursor;
		} while (cursor);
	}

	/**
	 * Get a single content item. Returns the item with a `_rev` token
	 * that can be passed to update() for optimistic concurrency.
	 */
	async get(
		collection: string,
		id: string,
		options?: { raw?: boolean; locale?: string },
	): Promise<ContentItem> {
		const params = new URLSearchParams();
		if (options?.locale) params.set("locale", options.locale);
		const qs = params.size > 0 ? `?${params}` : "";
		const result = await this.requestRaw(
			"GET",
			`/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}${qs}`,
		);
		if (!result.ok) {
			await this.assertOk(result);
		}

		const raw = (await result.json()) as { data: { item: ContentItem; _rev?: string } };
		const json = raw.data;
		const item = json.item;

		// Attach _rev to the item so callers can pass it back on update
		if (json._rev) {
			item._rev = json._rev;
		}

		// Convert PT fields to markdown unless raw is requested
		if (!options?.raw && item.data) {
			const fields = await this.getFieldSchemas(collection);
			item.data = convertDataForRead(item.data, fields, false);
		}

		return item;
	}

	/** Create a new content item */
	async create(
		collection: string,
		input: {
			data: Record<string, unknown>;
			slug?: string;
			status?: string;
			locale?: string;
			translationOf?: string;
			migrateBlocks?: boolean;
			replaceBlocks?: boolean;
		},
	): Promise<ContentItem> {
		// Convert markdown strings to PT for portableText fields
		const fields = await this.getFieldSchemas(collection);
		const data = convertDataForWrite(input.data, fields);

		const result = await this.request<{ item: ContentItem }>(
			"POST",
			`/content/${encodeURIComponent(collection)}`,
			{ ...input, data },
		);
		return result.item;
	}

	/**
	 * Update a content item. Pass `_rev` from a prior get() for optimistic
	 * concurrency — the server returns 409 if the item has changed.
	 * Omit `_rev` for a blind write (no conflict detection).
	 */
	async update(
		collection: string,
		id: string,
		input: {
			data?: Record<string, unknown>;
			slug?: string;
			status?: string;
			_rev?: string;
			locale?: string;
			migrateBlocks?: boolean;
			replaceBlocks?: boolean;
			/** Write even though another editor holds this entry's edit lock. */
			overrideLock?: boolean;
		},
	): Promise<ContentItem> {
		// Convert markdown strings to PT
		let data = input.data;
		if (data) {
			const fields = await this.getFieldSchemas(collection);
			data = convertDataForWrite(data, fields);
		}

		const body = {
			data,
			slug: input.slug,
			status: input.status,
			migrateBlocks: input.migrateBlocks,
			replaceBlocks: input.replaceBlocks,
			...(input._rev ? { _rev: input._rev } : {}),
			...(input.overrideLock ? { overrideLock: true } : {}),
		};
		const params = new URLSearchParams();
		if (input.locale) params.set("locale", input.locale);
		const result = await this.request<{ item: ContentItem; _rev?: string }>(
			"PUT",
			`/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}${params.toString() ? `?${params}` : ""}`,
			body,
		);

		const item = result.item;
		if (result._rev) {
			item._rev = result._rev;
		}
		return item;
	}

	/** Delete (soft) a content item */
	async delete(
		collection: string,
		id: string,
		options: { overrideLock?: boolean } = {},
	): Promise<void> {
		const query = options.overrideLock ? "?overrideLock=true" : "";
		await this.request<unknown>(
			"DELETE",
			`/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}${query}`,
		);
	}

	/** Publish a content item */
	async publish(
		collection: string,
		id: string,
		options: { overrideLock?: boolean } = {},
	): Promise<void> {
		await this.request<unknown>(
			"POST",
			`/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/publish`,
			options.overrideLock ? { overrideLock: true } : undefined,
		);
	}

	/** Unpublish a content item */
	async unpublish(
		collection: string,
		id: string,
		options: { overrideLock?: boolean } = {},
	): Promise<void> {
		await this.request<unknown>(
			"POST",
			`/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/unpublish`,
			options.overrideLock ? { overrideLock: true } : undefined,
		);
	}

	/** Schedule publishing */
	async schedule(
		collection: string,
		id: string,
		options: { at: string; overrideLock?: boolean },
	): Promise<void> {
		await this.request<unknown>(
			"POST",
			`/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/schedule`,
			{ scheduledAt: options.at, ...(options.overrideLock ? { overrideLock: true } : {}) },
		);
	}

	/** Restore a trashed content item */
	async restore(collection: string, id: string): Promise<void> {
		await this.request<unknown>(
			"POST",
			`/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/restore`,
		);
	}

	/** Compare live and draft revisions */
	async compare(
		collection: string,
		id: string,
	): Promise<{
		hasChanges: boolean;
		live: Record<string, unknown> | null;
		draft: Record<string, unknown> | null;
	}> {
		return this.request<{
			hasChanges: boolean;
			live: Record<string, unknown> | null;
			draft: Record<string, unknown> | null;
		}>("GET", `/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/compare`);
	}

	/** Discard draft revision, reverting to the published version */
	async discardDraft(
		collection: string,
		id: string,
		options: { overrideLock?: boolean } = {},
	): Promise<void> {
		await this.request<unknown>(
			"POST",
			`/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/discard-draft`,
			options.overrideLock ? { overrideLock: true } : undefined,
		);
	}

	/**
	 * Get all translations of a content item.
	 * Returns the translation group ID and a summary of each locale version.
	 */
	async translations(
		collection: string,
		id: string,
	): Promise<{
		translationGroup: string;
		translations: Array<{
			id: string;
			locale: string | null;
			slug: string | null;
			status: string;
			updatedAt: string;
		}>;
	}> {
		return this.request(
			"GET",
			`/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/translations`,
		);
	}

	// -----------------------------------------------------------------------
	// Media
	// -----------------------------------------------------------------------

	/** List media items */
	async mediaList(options?: {
		mimeType?: string;
		limit?: number;
		cursor?: string;
		page?: number;
		includeUsage?: boolean;
		folderId?: string | null;
	}): Promise<ListResult<MediaItem> & { totalCount?: number }> {
		const params = new URLSearchParams();
		if (options?.mimeType) params.set("mimeType", options.mimeType);
		if (options?.limit) params.set("limit", String(options.limit));
		if (options?.cursor) params.set("cursor", options.cursor);
		if (options?.page !== undefined) params.set("page", String(options.page));
		if (options?.includeUsage === true) params.set("includeUsage", "1");
		if (options?.folderId === null) {
			params.set("folderId", "unfiled");
		} else if (options?.folderId !== undefined) {
			params.set("folderId", options.folderId);
		}

		const qs = params.toString();
		return this.request<ListResult<MediaItem> & { totalCount?: number }>(
			"GET",
			`/media${qs ? `?${qs}` : ""}`,
		);
	}

	/** Get a single media item */
	async mediaGet(id: string, options?: { includeUsage?: boolean }): Promise<MediaItem> {
		const params = new URLSearchParams();
		if (options?.includeUsage === true) params.set("includeUsage", "1");

		const qs = params.toString();
		const data = await this.request<{ item: MediaItem }>(
			"GET",
			`/media/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`,
		);
		return data.item;
	}

	/** List media folders */
	async mediaFolderList(
		options: { limit?: number; cursor?: string; q?: string } = {},
	): Promise<ListResult<MediaFolder>> {
		const params = new URLSearchParams();
		if (options.limit !== undefined) params.set("limit", String(options.limit));
		if (options.cursor !== undefined) params.set("cursor", options.cursor);
		if (options.q !== undefined) params.set("q", options.q);
		const qs = params.toString();
		return this.request<ListResult<MediaFolder>>("GET", `/media/folders${qs ? `?${qs}` : ""}`);
	}

	/** Get one media folder */
	async mediaFolderGet(id: string): Promise<MediaFolder> {
		const data = await this.request<{ item: MediaFolder }>(
			"GET",
			`/media/folders/${encodeURIComponent(id)}`,
		);
		return data.item;
	}

	/** Create a media folder */
	async mediaFolderCreate(name: string): Promise<MediaFolder> {
		const data = await this.request<{ item: MediaFolder }>("POST", "/media/folders", { name });
		return data.item;
	}

	/** Rename a media folder */
	async mediaFolderUpdate(id: string, name: string): Promise<MediaFolder> {
		const data = await this.request<{ item: MediaFolder }>(
			"PUT",
			`/media/folders/${encodeURIComponent(id)}`,
			{ name },
		);
		return data.item;
	}

	/** Delete a media folder */
	async mediaFolderDelete(id: string): Promise<void> {
		await this.request<unknown>("DELETE", `/media/folders/${encodeURIComponent(id)}`);
	}

	/** Assign media to a folder, or return it to the Main library */
	async mediaSetFolder(id: string, folderId: string | null): Promise<MediaFolderAssignment> {
		const data = await this.request<{ item: MediaFolderAssignment }>(
			"PUT",
			`/media/${encodeURIComponent(id)}`,
			{ folderId },
		);
		return { id: data.item.id, folderId: data.item.folderId };
	}

	/** Get entry-grouped usage details for a media item */
	async mediaGetUsage(
		id: string,
		options?: { limit?: number; cursor?: string },
	): Promise<MediaUsageDetailsResponse> {
		const params = new URLSearchParams();
		if (options?.limit !== undefined) params.set("limit", String(options.limit));
		if (options?.cursor !== undefined) params.set("cursor", options.cursor);

		const qs = params.toString();
		return this.request<MediaUsageDetailsResponse>(
			"GET",
			`/media/${encodeURIComponent(id)}/usage${qs ? `?${qs}` : ""}`,
		);
	}

	/** Upload a media file */
	async mediaUpload(
		file: Uint8Array | Blob,
		filename: string,
		options?: { alt?: string; caption?: string; contentType?: string },
	): Promise<MediaItem> {
		const formData = new FormData();

		// Handle different file types
		if (file instanceof Blob) {
			formData.append("file", file, filename);
		} else {
			const mimeType = options?.contentType ?? mimeFromFilename(filename);
			formData.append("file", new Blob([file as BlobPart], { type: mimeType }), filename);
		}

		if (options?.alt) formData.append("alt", options.alt);
		if (options?.caption) formData.append("caption", options.caption);

		const url = `${this.baseUrl}/_emdash/api/media`;
		const request = new Request(url, {
			method: "POST",
			body: formData,
		});

		const response = await this.transport.fetch(request);
		await this.assertOk(response);

		const raw = (await response.json()) as { data: { item: MediaItem } };
		return raw.data.item;
	}

	/** Delete a media item */
	async mediaDelete(id: string): Promise<void> {
		await this.request<unknown>("DELETE", `/media/${encodeURIComponent(id)}`);
	}

	/** Repair content media usage indexes for one collection or all collections */
	async mediaRepairUsage(input: MediaUsageRepairInput): Promise<MediaUsageRepairResponse> {
		return this.request<MediaUsageRepairResponse>("POST", "/admin/media-usage/repair", input);
	}

	/** Read aggregate Media Usage indexing progress */
	async mediaGetUsageProgress(): Promise<MediaUsageProgress> {
		return this.request<MediaUsageProgress>("GET", "/admin/media-usage/progress");
	}

	/** Advance exactly one Media Usage maintenance step */
	async mediaAdvanceUsageProgress(): Promise<MediaUsageProgressAdvanceResponse> {
		return this.request<MediaUsageProgressAdvanceResponse>("POST", "/admin/media-usage/progress");
	}

	/** Read the redacted controlled-activation status */
	async mediaGetUsageActivation(): Promise<MediaUsageActivationStatus> {
		return this.request<MediaUsageActivationStatus>("GET", "/admin/media-usage/activation");
	}

	/** Advance exactly one controlled-activation batch */
	async mediaAdvanceUsageActivation(
		input: MediaUsageActivationAdvanceInput,
	): Promise<MediaUsageActivationAdvanceResponse> {
		return this.request<MediaUsageActivationAdvanceResponse>(
			"POST",
			"/admin/media-usage/activation",
			input,
		);
	}

	/** List a bounded page of durable media usage entry work */
	async mediaListUsageWork(
		options: MediaUsageWorkListOptions,
	): Promise<MediaUsageWorkListResponse> {
		const params = new URLSearchParams({ collection: options.collection });
		if (options.state) params.set("state", options.state);
		if (options.limit !== undefined) params.set("limit", String(options.limit));
		if (options.cursor) params.set("cursor", options.cursor);
		return this.request<MediaUsageWorkListResponse>("GET", `/admin/media-usage/work?${params}`);
	}

	/** Explicitly retry one durable media usage entry job */
	async mediaRetryUsageWork(input: MediaUsageWorkRetryInput): Promise<MediaUsageWorkRetryResponse> {
		return this.request<MediaUsageWorkRetryResponse>(
			"POST",
			"/admin/media-usage/work/retry",
			input,
		);
	}

	async mediaListCollectionDeletions(
		options: {
			state?: MediaUsageCollectionDeletionState;
			limit?: number;
			cursor?: string;
		} = {},
	): Promise<MediaUsageCollectionDeletionListResponse> {
		const params = new URLSearchParams();
		if (options.state) params.set("state", options.state);
		if (options.limit !== undefined) params.set("limit", String(options.limit));
		if (options.cursor) params.set("cursor", options.cursor);
		return this.request("GET", `/admin/media-usage/collection-deletions?${params}`);
	}

	async mediaRetryCollectionDeletion(collectionId: string): Promise<{
		changed: boolean;
		item: MediaUsageCollectionDeletionItem;
	}> {
		return this.request("POST", "/admin/media-usage/collection-deletions/retry", {
			collectionId,
		});
	}

	// -----------------------------------------------------------------------
	// Search
	// -----------------------------------------------------------------------

	/** Full-text search */
	async search(
		query: string,
		options?: { collection?: string; locale?: string; limit?: number },
	): Promise<SearchResult[]> {
		const params = new URLSearchParams({ q: query });
		if (options?.collection) params.set("collections", options.collection);
		if (options?.locale) params.set("locale", options.locale);
		if (options?.limit) params.set("limit", String(options.limit));

		const data = await this.request<{ items: SearchResult[] }>("GET", `/search?${params}`);
		return data.items;
	}

	// -----------------------------------------------------------------------
	// Taxonomies
	// -----------------------------------------------------------------------

	/** List taxonomies */
	async taxonomies(): Promise<Taxonomy[]> {
		const data = await this.request<{ taxonomies: Taxonomy[] }>("GET", "/taxonomies");
		return data.taxonomies;
	}

	/** List terms in a taxonomy */
	async terms(
		taxonomy: string,
		options?: { limit?: number; cursor?: string },
	): Promise<ListResult<Term>> {
		const params = new URLSearchParams();
		if (options?.limit) params.set("limit", String(options.limit));
		if (options?.cursor) params.set("cursor", options.cursor);

		const qs = params.toString();
		const data = await this.request<{ terms: Term[] }>(
			"GET",
			`/taxonomies/${encodeURIComponent(taxonomy)}/terms${qs ? `?${qs}` : ""}`,
		);
		return { items: data.terms };
	}

	/** Create a taxonomy term */
	async createTerm(
		taxonomy: string,
		input: { slug: string; label: string; parentId?: string; description?: string },
	): Promise<Term> {
		return this.request<Term>("POST", `/taxonomies/${encodeURIComponent(taxonomy)}/terms`, input);
	}

	// -----------------------------------------------------------------------
	// Menus
	// -----------------------------------------------------------------------

	/** List menus */
	async menus(): Promise<Menu[]> {
		// Handler returns a bare array, not { items: [...] }
		return this.request<Menu[]>("GET", "/menus");
	}

	/** Get a menu with its items */
	async menu(name: string): Promise<MenuWithItems> {
		return this.request<MenuWithItems>("GET", `/menus/${encodeURIComponent(name)}`);
	}

	// -----------------------------------------------------------------------
	// Users
	// -----------------------------------------------------------------------

	/** List users (admin only) */
	async users(options?: {
		search?: string;
		limit?: number;
		cursor?: string;
	}): Promise<ListResult<UserSummary>> {
		const params = new URLSearchParams();
		if (options?.search) params.set("search", options.search);
		if (options?.limit) params.set("limit", String(options.limit));
		if (options?.cursor) params.set("cursor", options.cursor);
		const qs = params.toString();
		return this.request<ListResult<UserSummary>>("GET", `/admin/users${qs ? `?${qs}` : ""}`);
	}

	// -----------------------------------------------------------------------
	// Site transfer
	// -----------------------------------------------------------------------

	/** Formats, features, limits, and whether this site can receive an import */
	async transferCapabilities(): Promise<TransferCapabilities> {
		return this.request<TransferCapabilities>("GET", "/admin/transfer/capabilities");
	}

	/**
	 * Start a site export. With an idempotency key, repeating the call returns
	 * the export first created with that key.
	 */
	async transferExportCreate(
		options: { comments?: boolean } = {},
		request: { idempotencyKey?: string } = {},
	): Promise<{ operation: TransferOperation; created: boolean }> {
		return this.request("POST", "/admin/transfer/exports", options, idempotencyHeader(request));
	}

	/** List exports, newest first */
	async transferExportList(options?: {
		limit?: number;
		cursor?: string;
	}): Promise<ListResult<TransferOperation>> {
		return this.request("GET", `/admin/transfer/exports${pageQuery(options)}`);
	}

	async transferExportGet(id: string): Promise<{ operation: TransferOperation }> {
		return this.request("GET", `/admin/transfer/exports/${encodeURIComponent(id)}`);
	}

	/** Run one bounded export step */
	async transferExportAdvance(id: string): Promise<TransferAdvanceResult> {
		return this.request("POST", `/admin/transfer/exports/${encodeURIComponent(id)}/advance`);
	}

	/** The complete export's `manifest.json`, byte for byte */
	async transferExportManifest(id: string): Promise<Uint8Array> {
		const response = await this.requestRaw(
			"GET",
			`/admin/transfer/exports/${encodeURIComponent(id)}/manifest`,
		);
		await this.assertOk(response);
		return new Uint8Array(await response.arrayBuffer());
	}

	/**
	 * Stream one file of a complete export. The server ends the stream with an
	 * error if the stored bytes no longer match the export, so callers must
	 * still check the size and digest of what they receive.
	 */
	async transferExportFile(id: string, path: string): Promise<TransferFileDownload> {
		const response = await this.requestRaw(
			"GET",
			`/admin/transfer/exports/${encodeURIComponent(id)}/files/${encodePackagePath(path)}`,
		);
		await this.assertOk(response);
		if (!response.body) throw new EmDashClientError(`Empty response for ${path}`);
		const length = response.headers.get("Content-Length");
		const etag = response.headers.get("ETag");
		return {
			body: response.body,
			bytes: length !== null && DECIMAL_PATTERN.test(length) ? Number(length) : null,
			sha256: etag ? (SHA256_ETAG_PATTERN.exec(etag)?.[1] ?? null) : null,
		};
	}

	/**
	 * Create an import from a package's `manifest.json` bytes. With an
	 * idempotency key, repeating the call with the same manifest returns the
	 * import first created with that key.
	 */
	async transferImportCreate(
		manifest: Uint8Array,
		request: { idempotencyKey?: string } = {},
	): Promise<TransferImportCreateResult> {
		const response = await this.send("POST", "/admin/transfer/imports", {
			body: manifest,
			headers: { "Content-Type": "application/json", ...idempotencyHeader(request) },
		});
		await this.assertOk(response);
		const json = (await response.json()) as { data: TransferImportCreateResult };
		return json.data;
	}

	/** List imports, newest first */
	async transferImportList(options?: {
		limit?: number;
		cursor?: string;
	}): Promise<ListResult<TransferOperation>> {
		return this.request("GET", `/admin/transfer/imports${pageQuery(options)}`);
	}

	async transferImportGet(id: string): Promise<TransferImportStatus> {
		return this.request("GET", `/admin/transfer/imports/${encodeURIComponent(id)}`);
	}

	/** Declared package files not uploaded yet, in path order */
	async transferImportMissing(
		id: string,
		options?: { limit?: number; cursor?: string },
	): Promise<ListResult<TransferPackageFile>> {
		return this.request(
			"GET",
			`/admin/transfer/imports/${encodeURIComponent(id)}/missing${pageQuery(options)}`,
		);
	}

	/**
	 * Upload one declared package file. `bytes` must be the file's exact size;
	 * a stream body is sent with that `Content-Length`.
	 */
	async transferImportUploadFile(
		id: string,
		path: string,
		body: Uint8Array | ReadableStream<Uint8Array>,
		bytes: number,
	): Promise<TransferFileUploadResult> {
		const response = await this.send(
			"PUT",
			`/admin/transfer/imports/${encodeURIComponent(id)}/files/${encodePackagePath(path)}`,
			{
				body,
				headers: {
					"Content-Type": "application/octet-stream",
					"Content-Length": String(bytes),
				},
			},
		);
		await this.assertOk(response);
		const json = (await response.json()) as { data: TransferFileUploadResult };
		return json.data;
	}

	/**
	 * Run one bounded analysis step. Once the import is planned the result
	 * carries the plan; `decisions` are then applied, producing a new plan
	 * digest.
	 */
	async transferImportAnalyze(
		id: string,
		decisions?: SiteImportDecisionsInput,
	): Promise<TransferImportAnalyzeResult> {
		return this.request(
			"POST",
			`/admin/transfer/imports/${encodeURIComponent(id)}/analyze`,
			decisions === undefined ? undefined : { decisions },
		);
	}

	async transferImportPlan(
		id: string,
	): Promise<{ plan: SiteImportPlan; planDigest: Sha256Digest }> {
		return this.request("GET", `/admin/transfer/imports/${encodeURIComponent(id)}/plan`);
	}

	/** Start a planned import. Both digests must match the reviewed package and plan. */
	async transferImportExecute(
		id: string,
		input: { packageDigest: string; planDigest: string },
	): Promise<{ operation: TransferOperation }> {
		return this.request("POST", `/admin/transfer/imports/${encodeURIComponent(id)}/execute`, {
			packageDigest: input.packageDigest,
			planDigest: input.planDigest,
		});
	}

	/** Run one bounded step of an executing import */
	async transferImportAdvance(id: string): Promise<TransferAdvanceResult> {
		return this.request("POST", `/admin/transfer/imports/${encodeURIComponent(id)}/advance`);
	}

	async transferImportReceipt(id: string): Promise<{ receipt: SiteImportReceipt }> {
		return this.request("GET", `/admin/transfer/imports/${encodeURIComponent(id)}/receipt`);
	}

	/**
	 * Cancel an import. An idle import is cancelled at once; a step in
	 * progress stops after its current batch, so the returned operation may
	 * still be executing with `cancelRequestedAt` set.
	 */
	async transferImportCancel(id: string): Promise<{ operation: TransferOperation }> {
		return this.request("POST", `/admin/transfer/imports/${encodeURIComponent(id)}/cancel`);
	}

	/**
	 * Abandon a failed or cancelled import, lifting the site write fence it
	 * holds. Data the import already wrote stays in place.
	 */
	async transferImportAbandon(id: string): Promise<{ operation: TransferOperation }> {
		return this.request("POST", `/admin/transfer/imports/${encodeURIComponent(id)}/abandon`);
	}

	// -----------------------------------------------------------------------
	// Internal helpers
	// -----------------------------------------------------------------------

	/** Make a typed JSON request to the API */
	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
		extraHeaders?: Record<string, string>,
	): Promise<T> {
		const response = await this.requestRaw(method, path, body, extraHeaders);
		await this.assertOk(response);
		const json = (await response.json()) as { data: T };
		return json.data;
	}

	/** Make a raw request — caller handles response */
	private async requestRaw(
		method: string,
		path: string,
		body?: unknown,
		extraHeaders?: Record<string, string>,
	): Promise<Response> {
		const headers: Record<string, string> = { ...extraHeaders };

		let requestBody: string | undefined;
		if (body !== undefined) {
			headers["Content-Type"] = "application/json";
			requestBody = JSON.stringify(body);
		}

		return this.send(method, path, { body: requestBody, headers });
	}

	/** Send a request with an arbitrary body; the caller handles the response */
	private async send(
		method: string,
		path: string,
		init: {
			body?: string | Uint8Array | ReadableStream<Uint8Array>;
			headers?: Record<string, string>;
		},
	): Promise<Response> {
		const url = `${this.baseUrl}/_emdash/api${path}`;
		const request = new Request(url, {
			method,
			headers: { Accept: "application/json", ...init.headers },
			body: init.body as BodyInit | undefined,
			...(init.body instanceof ReadableStream ? { duplex: "half" } : {}),
		});

		return this.transport.fetch(request);
	}

	/** Assert a response is OK, throw typed error if not */
	private async assertOk(response: Response): Promise<void> {
		if (response.ok) return;

		let code = "UNKNOWN_ERROR";
		let message = `HTTP ${response.status}`;
		let details: Record<string, unknown> | undefined;

		try {
			const json = (await response.json()) as {
				error?: { code?: string; message?: string; details?: Record<string, unknown> };
			};
			if (json.error) {
				code = json.error.code ?? code;
				message = json.error.message ?? message;
				details = json.error.details;
			}
		} catch {
			// Response body isn't JSON — use status text
			message = response.statusText || message;
		}

		throw new EmDashApiError(response.status, code, message, details);
	}

	/** Get cached field schemas for a collection, fetching if needed */
	private async getFieldSchemas(collection: string): Promise<FieldSchema[]> {
		let cached = this.fieldSchemaCache.get(collection);
		if (cached) return cached;

		try {
			const col = await this.collection(collection);
			cached = col.fields.map((f) => ({ slug: f.slug, type: f.type, blockTypes: f.blockTypes }));
			this.fieldSchemaCache.set(collection, cached);
			return cached;
		} catch {
			// If we can't fetch the schema, skip conversion
			return [];
		}
	}
}

type _AssertTrue<T extends true> = T;
type _MediaRepairUsageRequiresExplicitInput = _AssertTrue<
	Parameters<EmDashClient["mediaRepairUsage"]> extends [MediaUsageRepairInput] ? true : false
>;

export type { SiteImportDecisionsInput, SiteImportPlan, SiteImportReceipt, Sha256Digest };

// Re-export transport types for interceptor authors
export type { Interceptor } from "./transport.js";
export {
	createTransport,
	csrfInterceptor,
	tokenInterceptor,
	devBypassInterceptor,
} from "./transport.js";
export { portableTextToMarkdown, markdownToPortableText } from "./portable-text.js";
export type { PortableTextBlock } from "./portable-text.js";
