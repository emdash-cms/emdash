/**
 * An in-memory AI Search provider. Search matches query words against the
 * uploaded text and ranks by `priority`.
 */

import {
	type AiSearchProvider,
	type InstanceInfo,
	type InstanceStats,
	type Item,
	type ItemPage,
	type ItemQuery,
	ProviderError,
	type ProviderErrorReason,
	type SearchChunk,
	type SearchQuery,
} from "../src/ports/ai-search.js";

interface Version {
	metadata: Record<string, string>;
	body: string;
}

type StoredItem = Item &
	Version & {
		indexedAt: number;
		/** The last indexed version, searchable while this one is queued. */
		previous: Version | null;
	};

const WHITESPACE = /\s+/;

/**
 * Upload is an upsert by key. With `indexingMs`, an upload stays queued until
 * that much time passes. Calls fail before the instance is created only when
 * `requireInstance` is set.
 */
export class FakeAiSearch implements AiSearchProvider {
	kind: AiSearchProvider["kind"] = "binding";
	readonly items = new Map<string, StoredItem>();
	created = false;
	uploads = 0;
	/** Number of list calls received. */
	lists = 0;
	/** Keys whose upload fails, as a transient service error would. */
	readonly failKeys = new Set<string>();
	/** Number of uploads accepted before every further upload is rate-limited. */
	rateLimitAfter = Number.POSITIVE_INFINITY;
	/** The instance was just created and AI Search does not serve it yet. */
	starting = false;
	searchError: Error | null = null;
	/** Every call fails for this reason, as when a token expires or the account is rate-limited. */
	failAll: ProviderErrorReason | null = null;
	/** Cloudflare rejects the token when asked directly. */
	rejectsToken = false;
	/** Search requests received. */
	readonly searches: SearchQuery[] = [];

	constructor(readonly options: { indexingMs?: number; requireInstance?: boolean } = {}) {}

	async ensureInstance(): Promise<{ created: boolean }> {
		if (this.created) return { created: false };
		this.created = true;
		return { created: true };
	}

	async tokenRejected(): Promise<boolean> {
		return this.rejectsToken;
	}

	async info(): Promise<InstanceInfo> {
		this.assertServing();
		return { id: "emdash", namespace: "default" };
	}

	async stats(): Promise<InstanceStats> {
		this.assertServing();
		const count = (status: Item["status"]) =>
			this.current().filter((item) => item.status === status).length;
		return {
			queued: count("queued"),
			running: count("running"),
			completed: count("completed"),
			error: count("error"),
			skipped: count("skipped"),
			outdated: count("outdated"),
			lastActivity: null,
		};
	}

	async search(query: SearchQuery): Promise<SearchChunk[]> {
		this.assertServing();
		this.searches.push(query);
		if (this.searchError) throw this.searchError;
		const words = query.query.toLowerCase().split(WHITESPACE);
		return this.current()
			.flatMap((item) => {
				const version = searchable(item);
				return version ? [{ key: item.key, ...version }] : [];
			})
			.filter((item) => words.some((word) => item.body.toLowerCase().includes(word)))
			.filter((item) =>
				Object.entries(query.filters ?? {}).every(([name, value]) => item.metadata[name] === value),
			)
			.toSorted((a, b) => Number(b.metadata.priority) - Number(a.metadata.priority))
			.slice(0, query.maxResults)
			.map((item) => ({ key: item.key, metadata: item.metadata }));
	}

	async listItems(query: ItemQuery = {}): Promise<ItemPage> {
		this.lists++;
		this.assertServing();
		const { folder, ...metadata } = query.metadata ?? {};
		const all = this.current().filter(
			(item) =>
				(!query.key || item.key === query.key) &&
				(!query.status || item.status === query.status) &&
				(!folder || item.key.startsWith(folder)) &&
				Object.entries(metadata).every(([name, value]) => item.metadata[name] === value),
		);
		const perPage = query.perPage ?? 20;
		const start = ((query.page ?? 1) - 1) * perPage;
		return { items: all.slice(start, start + perPage).map(toItem), total: all.length };
	}

	async uploadItem(key: string, body: string, metadata: Record<string, string>): Promise<Item> {
		if (JSON.stringify(metadata).length > 10_240) {
			throw new ProviderError("failed", "AiSearchInternalError: unable_to_connect_to_ai_search");
		}
		this.assertServing();
		if (this.failKeys.has(key)) throw new ProviderError("failed", "AiSearchError: internal_error");
		if (this.uploads >= this.rateLimitAfter) {
			throw new ProviderError("rate-limited", "AiSearchError: You are being rate limited.");
		}
		this.uploads++;
		const indexingMs = this.options.indexingMs ?? 0;
		const replaced = this.current().find((item) => item.key === key);
		const item: StoredItem = {
			id: `item-${key}`,
			key,
			status: indexingMs > 0 ? "queued" : "completed",
			updatedAt: "2026-01-01T12:00:00Z",
			metadata,
			body,
			indexedAt: Date.now() + indexingMs,
			previous: replaced ? searchable(replaced) : null,
		};
		this.items.set(key, item);
		return toItem(item);
	}

	async deleteItem(id: string): Promise<void> {
		this.assertServing();
		for (const [key, item] of this.items) if (item.id === id) this.items.delete(key);
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

	private assertServing(): void {
		if (this.failAll) throw new ProviderError(this.failAll, "Cloudflare refused the call");
		if (this.starting || (this.options.requireInstance && !this.created)) {
			throw new ProviderError("not-found", "AiSearchNotFoundError: ai_search_not_found");
		}
	}
}

function toItem(item: StoredItem): Item {
	const { id, key, status, metadata, error, updatedAt } = item;
	return {
		id,
		key,
		status,
		metadata,
		...(error ? { error } : {}),
		...(updatedAt ? { updatedAt } : {}),
	};
}

function searchable(item: StoredItem): Version | null {
	return item.status === "completed" ? item : item.previous;
}
