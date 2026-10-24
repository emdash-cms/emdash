// AI Search's request and response shapes, mapped to and from the port.

import { version } from "../../package.json";
import {
	CUSTOM_METADATA,
	type Item,
	type ItemPage,
	type ItemQuery,
	type ItemStatus,
	isProviderError,
	type SearchChunk,
	type SearchQuery,
} from "../ports/ai-search.js";

export function instanceConfig(id: string) {
	return {
		id,
		index_method: { vector: true, keyword: true },
		custom_metadata: CUSTOM_METADATA.map((field) => ({ ...field })),
		metadata: { created_from_emdash_plugin: { type: "native", version } },
	};
}

export async function ensureInstance(
	info: () => Promise<unknown>,
	create: () => Promise<unknown>,
): Promise<{ created: boolean }> {
	try {
		await info();
		return { created: false };
	} catch (error) {
		if (!isProviderError(error, "not-found")) throw error;
	}
	await create();
	return { created: true };
}

export function searchRequest(query: SearchQuery) {
	return {
		query: query.query,
		ai_search_options: {
			retrieval: defined({
				max_num_results: query.maxResults,
				// Results are built from item metadata alone, so chunk text is never needed.
				metadata_only: true,
				// Throw on failure so visitors see an error rather than a misleading empty result.
				return_on_failure: false,
				filters: query.filters,
				boost_by: query.boostBy
					? [{ field: query.boostBy, direction: "desc" as const }]
					: undefined,
			}),
		},
	};
}

export interface WireSearch {
	chunks: Array<{ item: { key: string; metadata?: Record<string, unknown> } }>;
}

export function toChunks(response: WireSearch): SearchChunk[] {
	return response.chunks.map(({ item }) => ({ key: item.key, metadata: item.metadata }));
}

export function listParams(query: ItemQuery) {
	return defined({
		key: query.key,
		status: query.status,
		metadata_filter: query.metadata ? JSON.stringify(query.metadata) : undefined,
		sort_by: query.newestFirst ? ("modified_at" as const) : undefined,
		page: query.page,
		per_page: query.perPage,
	});
}

/** Leaves out unset parameters rather than sending them as `undefined`. */
function defined<T extends object>(params: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
	return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined)) as {
		[K in keyof T]?: Exclude<T[K], undefined>;
	};
}

export interface WireItem {
	id: string;
	key: string;
	status: ItemStatus;
	metadata?: Record<string, unknown>;
	error?: string;
	last_seen_at?: string;
}

export function toItem(item: WireItem): Item {
	const { id, key, status, metadata, error } = item;
	return {
		id,
		key,
		status,
		metadata,
		error,
		updatedAt: item.last_seen_at && isoTime(item.last_seen_at),
	};
}

export function toPage(list: {
	result: WireItem[];
	result_info?: { total_count?: number };
}): ItemPage {
	return {
		items: list.result.map(toItem),
		total: list.result_info?.total_count ?? list.result.length,
	};
}

export interface WireStats {
	queued?: number;
	running?: number;
	completed?: number;
	error?: number;
	skipped?: number;
	outdated?: number;
	last_activity?: string;
}

export function toStats(stats: WireStats) {
	return {
		queued: stats.queued ?? 0,
		running: stats.running ?? 0,
		completed: stats.completed ?? 0,
		error: stats.error ?? 0,
		skipped: stats.skipped ?? 0,
		outdated: stats.outdated ?? 0,
		lastActivity: stats.last_activity ? isoTime(stats.last_activity) : null,
	};
}

const ZONELESS_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;

/** AI Search reports some UTC times as `YYYY-MM-DD HH:MM:SS`, without a zone. */
function isoTime(time: string): string {
	return ZONELESS_TIME.test(time) ? `${time.replace(" ", "T")}Z` : time;
}
