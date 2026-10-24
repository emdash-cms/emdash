/**
 * In-memory stand-ins for an AI Search namespace and its Items API. Search
 * matches query words against the uploaded text and ranks by `priority`.
 */

import type { IndexerDeps } from "../src/indexer.js";

type ItemsApi = IndexerDeps["items"];

interface Version {
	metadata: Record<string, unknown> | undefined;
	body: string;
}

type StoredItem = AiSearchItemInfo &
	Version & {
		indexedAt: number;
		/** The last indexed version, searchable while this one is queued. */
		previous: Version | null;
	};

const WHITESPACE = /\s+/;
const NOT_FOUND = "AiSearchNotFoundError: ai_search_not_found";

/** Upload is an upsert by key. With `indexingMs`, an upload stays queued until that much time passes. */
export class FakeItems implements ItemsApi {
	readonly items = new Map<string, StoredItem>();
	uploads = 0;
	/** Number of list calls received. */
	lists = 0;
	/** Keys whose upload fails, as a transient service error would. */
	readonly failKeys = new Set<string>();
	/** Number of uploads accepted before every further upload is rate-limited. */
	rateLimitAfter = Number.POSITIVE_INFINITY;
	/** The instance was just created and AI Search does not serve it yet. */
	starting = false;

	constructor(readonly indexingMs = 0) {}

	async list(params: AiSearchListItemsParams = {}): Promise<AiSearchListItemsResponse> {
		this.lists++;
		if (this.starting) throw new Error(NOT_FOUND);
		const filter = params.metadata_filter
			? (JSON.parse(params.metadata_filter) as { folder?: string; source?: string })
			: {};
		const all = this.current().filter(
			(item) =>
				(!params.key || item.key === params.key) &&
				(!params.status || item.status === params.status) &&
				(!filter.folder || item.key.startsWith(filter.folder)) &&
				(!filter.source || item.metadata?.source === filter.source),
		);
		const perPage = params.per_page ?? 20;
		const start = ((params.page ?? 1) - 1) * perPage;
		return {
			result: all.slice(start, start + perPage),
			result_info: {
				count: Math.min(perPage, Math.max(0, all.length - start)),
				page: params.page ?? 1,
				per_page: perPage,
				total_count: all.length,
			},
		};
	}

	async upload(
		name: string,
		content: string | ReadableStream | Blob,
		options?: AiSearchUploadItemOptions,
	): Promise<AiSearchItemInfo> {
		if (Object.values(options?.metadata ?? {}).some((value) => typeof value !== "string")) {
			throw new Error("AiSearchError: invalid_metadata_format");
		}
		if (JSON.stringify(options?.metadata ?? {}).length > 10_240) {
			throw new Error("AiSearchInternalError: unable_to_connect_to_ai_search");
		}
		if (this.starting) throw new Error(NOT_FOUND);
		if (this.failKeys.has(name)) throw new Error("AiSearchError: internal_error");
		if (this.uploads >= this.rateLimitAfter) {
			throw new Error("AiSearchError: You are being rate limited.");
		}
		this.uploads++;
		const replaced = this.current().find((item) => item.key === name);
		const item: StoredItem = {
			id: `item-${name}`,
			key: name,
			status: this.indexingMs > 0 ? "queued" : "completed",
			last_seen_at: "2026-01-01 12:00:00",
			metadata: options?.metadata,
			body: typeof content === "string" ? content : "",
			indexedAt: Date.now() + this.indexingMs,
			previous: replaced ? searchable(replaced) : null,
		};
		this.items.set(name, item);
		return item;
	}

	async delete(itemId: string): Promise<void> {
		for (const [key, item] of this.items) if (item.id === itemId) this.items.delete(key);
	}

	/** Every item, with the uploads whose processing time has passed marked completed. */
	current(): StoredItem[] {
		for (const item of this.items.values()) {
			if (item.status === "queued" && Date.now() >= item.indexedAt) {
				item.status = "completed";
				item.previous = null;
			}
		}
		return [...this.items.values()];
	}
}

function searchable(item: StoredItem): Version | null {
	return item.status === "completed" ? item : item.previous;
}

/** A namespace holding one instance, which must be created before use. */
export class FakeAiSearch {
	created = false;
	readonly items: FakeItems;
	searchError: Error | null = null;
	private readonly instance: ReturnType<FakeAiSearch["createInstance"]>;

	constructor(options: { indexingMs?: number } = {}) {
		this.items = new FakeItems(options.indexingMs);
		this.instance = this.createInstance();
	}

	get = (_name: string) => this.instance;

	create = async (_config: unknown) => {
		this.created = true;
		return this.instance;
	};

	private createInstance() {
		const items = this.items;
		return {
			info: async () => {
				if (!this.created) throw new Error("AiSearchNotFoundError: instance not found");
				return {};
			},
			stats: async () => {
				const all = items.current();
				return {
					completed: all.filter((item) => item.status === "completed").length,
					queued: all.filter((item) => item.status === "queued").length,
				};
			},
			search: async (request: {
				query: string;
				ai_search_options?: { retrieval?: { filters?: { locale?: string } } };
			}) => {
				if (this.searchError) throw this.searchError;
				const words = request.query.toLowerCase().split(WHITESPACE);
				const locale = request.ai_search_options?.retrieval?.filters?.locale;
				const chunks = items
					.current()
					.flatMap((item) => {
						const version = searchable(item);
						return version ? [{ id: item.id, key: item.key, ...version }] : [];
					})
					.filter((item) => words.some((word) => item.body.toLowerCase().includes(word)))
					.filter((item) => !locale || item.metadata?.locale === locale)
					.toSorted((a, b) => Number(b.metadata?.priority) - Number(a.metadata?.priority))
					.map((item) => ({
						id: item.id,
						type: "text",
						score: 1,
						text: "",
						item: { key: item.key, metadata: item.metadata },
					}));
				return { search_query: request.query, chunks };
			},
			items,
		};
	}
}
