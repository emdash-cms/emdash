/**
 * What the plugin needs from Cloudflare AI Search, in its own terms. The
 * Workers binding and the REST API each implement it as an adapter.
 */

/** Where AI Search stands with an item. */
export type ItemStatus = "queued" | "running" | "completed" | "error" | "skipped" | "outdated";

export interface Item {
	id: string;
	key: string;
	status: ItemStatus;
	metadata?: Record<string, unknown>;
	/** Why AI Search could not process the item. */
	error?: string;
	/** When AI Search last changed the item, as an ISO time. */
	updatedAt?: string;
}

export interface ItemQuery {
	key?: string;
	status?: ItemStatus;
	/** Items whose metadata has these values. `folder` matches every key under that path. */
	metadata?: Record<string, string>;
	/** Most recently modified first, instead of grouped by status. */
	newestFirst?: boolean;
	page?: number;
	perPage?: number;
}

export interface ItemPage {
	items: Item[];
	/** Items matching the query, across every page. */
	total: number;
}

/** Items per status. */
export interface InstanceStats {
	queued: number;
	running: number;
	completed: number;
	error: number;
	skipped: number;
	outdated: number;
	/** When AI Search last changed an item, as an ISO time. */
	lastActivity: string | null;
}

export interface InstanceInfo {
	id: string;
	namespace: string | null;
}

export interface SearchQuery {
	query: string;
	maxResults: number;
	/** Only chunks whose item metadata has these values. */
	filters?: Record<string, string>;
	/** Metadata field whose higher values rank first. */
	boostBy?: string;
}

/** A matching chunk, identified by its item. Chunks arrive best first. */
export interface SearchChunk {
	key: string;
	metadata?: Record<string, unknown>;
}

export interface AiSearchProvider {
	readonly kind: "binding" | "rest";
	/** Creates the instance unless it exists. `created` is true when this call created it. */
	ensureInstance(): Promise<{ created: boolean }>;
	info(): Promise<InstanceInfo>;
	stats(): Promise<InstanceStats>;
	search(query: SearchQuery): Promise<SearchChunk[]>;
	listItems(query?: ItemQuery): Promise<ItemPage>;
	/** Uploads a document, replacing any item with the same key. */
	uploadItem(key: string, body: string, metadata: Record<string, string>): Promise<Item>;
	deleteItem(id: string): Promise<void>;
	/**
	 * Whether Cloudflare rejects the credentials outright. Cloudflare answers
	 * repeated calls with a rejected token as rate-limited, so a rate limit
	 * alone does not tell the two apart. Absent when there are no credentials.
	 */
	tokenRejected?(): Promise<boolean>;
	/** Cloudflare API requests this provider has made, when they count against a rate limit. */
	readonly requests?: number;
	/** Caps subsequent requests, throwing `rate-limited` once spent. Infinity removes the cap. */
	limitRequests?(remaining: number): void;
}

/**
 * - `rate-limited`: AI Search refused the call for now.
 * - `not-found`: the instance, namespace, or item does not exist.
 * - `unauthorized`: the credentials are invalid or lack permission.
 * - `failed`: anything else.
 */
export type ProviderErrorReason = "rate-limited" | "not-found" | "unauthorized" | "failed";

/** A call AI Search refused or could not complete. Adapters throw nothing else. */
export class ProviderError extends Error {
	override readonly name = "ProviderError";

	constructor(
		readonly reason: ProviderErrorReason,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
	}
}

export const isProviderError = (error: unknown, reason: ProviderErrorReason): boolean =>
	error instanceof ProviderError && error.reason === reason;

/** Metadata fields the instance declares. Only these can be used in search filters and boosts. */
export const CUSTOM_METADATA = [
	{ field_name: "source", data_type: "text" },
	{ field_name: "locale", data_type: "text" },
	{ field_name: "priority", data_type: "number" },
	{ field_name: "published_at", data_type: "datetime" },
] as const;
