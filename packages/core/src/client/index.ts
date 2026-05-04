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

import type { PortableTextBlock, FieldSchema } from "./portable-text.js";
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mimeFromFilename(filename: string): string {
	return mime.getType(filename) ?? "application/octet-stream";
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
	alt?: string;
	caption?: string;
	createdAt: string;
	updatedAt: string;
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
				col.fields.map((f) => ({ slug: f.slug, type: f.type })),
			);
		}
		return col;
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
		},
	): Promise<ListResult<ContentItem>> {
		const params = new URLSearchParams();
		if (options?.status) params.set("status", options.status);
		if (options?.limit) params.set("limit", String(options.limit));
		if (options?.cursor) params.set("cursor", options.cursor);
		if (options?.orderBy) params.set("orderBy", options.orderBy);
		if (options?.order) params.set("order", options.order);
		if (options?.locale) params.set("locale", options.locale);

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
			...(input._rev ? { _rev: input._rev } : {}),
		};
		const result = await this.request<{ item: ContentItem; _rev?: string }>(
			"PUT",
			`/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`,
			body,
		);

		const item = result.item;
		if (result._rev) {
			item._rev = result._rev;
		}
		return item;
	}

	/** Delete (soft) a content item */
	async delete(collection: string, id: string): Promise<void> {
		await this.request<unknown>(
			"DELETE",
			`/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`,
		);
	}

	/** Publish a content item */
	async publish(collection: string, id: string): Promise<void> {
		await this.request<unknown>(
			"POST",
			`/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/publish`,
		);
	}

	/** Unpublish a content item */
	async unpublish(collection: string, id: string): Promise<void> {
		await this.request<unknown>(
			"POST",
			`/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/unpublish`,
		);
	}

	/** Schedule publishing */
	async schedule(collection: string, id: string, options: { at: string }): Promise<void> {
		await this.request<unknown>(
			"POST",
			`/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/schedule`,
			{ scheduledAt: options.at },
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
	async discardDraft(collection: string, id: string): Promise<void> {
		await this.request<unknown>(
			"POST",
			`/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/discard-draft`,
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
	}): Promise<ListResult<MediaItem>> {
		const params = new URLSearchParams();
		if (options?.mimeType) params.set("mimeType", options.mimeType);
		if (options?.limit) params.set("limit", String(options.limit));
		if (options?.cursor) params.set("cursor", options.cursor);

		const qs = params.toString();
		return this.request<ListResult<MediaItem>>("GET", `/media${qs ? `?${qs}` : ""}`);
	}

	/** Get a single media item */
	async mediaGet(id: string): Promise<MediaItem> {
		const data = await this.request<{ item: MediaItem }>("GET", `/media/${encodeURIComponent(id)}`);
		return data.item;
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
		return this.request<ListResult<Term>>(
			"GET",
			`/taxonomies/${encodeURIComponent(taxonomy)}/terms${qs ? `?${qs}` : ""}`,
		);
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
	// Internal helpers
	// -----------------------------------------------------------------------

	/** Make a typed JSON request to the API */
	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const response = await this.requestRaw(method, path, body);
		await this.assertOk(response);
		const json = (await response.json()) as { data: T };
		return json.data;
	}

	/** Make a raw request — caller handles response */
	private async requestRaw(method: string, path: string, body?: unknown): Promise<Response> {
		const url = `${this.baseUrl}/_emdash/api${path}`;
		const headers: Record<string, string> = {
			Accept: "application/json",
		};

		let requestBody: string | undefined;
		if (body !== undefined) {
			headers["Content-Type"] = "application/json";
			requestBody = JSON.stringify(body);
		}

		const request = new Request(url, {
			method,
			headers,
			body: requestBody,
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
			cached = col.fields.map((f) => ({ slug: f.slug, type: f.type }));
			this.fieldSchemaCache.set(collection, cached);
			return cached;
		} catch {
			// If we can't fetch the schema, skip conversion
			return [];
		}
	}
}

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
