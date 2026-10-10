import type { PluginContext } from "emdash";

import { readMetadata } from "./documents.js";
import type { Indexer } from "./indexer.js";
import { getRetryQueue, type RetryItem } from "./retry.js";

const RECENT_COUNT = 5;
/** Processing failures read from AI Search to group; the rest are only counted. */
const FAILED_SAMPLE = 50;
const MAX_GROUPS = 10;
const RECORDS_PER_GROUP = 5;
const KEY = /^([^/]+)\/(.+)\.md$/;

export interface ActivityItem {
	source: string;
	id: string;
	title: string;
	locale: string;
	status: AiSearchItemInfo["status"];
	error?: string;
	updatedAt?: string;
}

export interface AttentionRecord {
	source: string;
	id: string;
	/** Null when the record no longer exists. */
	title: string | null;
}

/** Failed records that share a stage and an error message. */
export interface AttentionGroup {
	/** `upload`: the plugin could not send the records. `processing`: AI Search could not process them. */
	stage: "upload" | "processing";
	/** The error message, or an empty string when AI Search gave none. */
	reason: string;
	count: number;
	/** Upload groups only: whether any record still has an automatic retry to come. */
	retrying: boolean;
	/** The newest few records in the group. */
	records: AttentionRecord[];
}

export interface Activity {
	/** Items AI Search changed most recently. */
	recent: ActivityItem[];
	/** Failed records grouped by reason, largest group first. */
	attention: AttentionGroup[];
	/** Failures counted but not in any group. */
	unlisted: number;
}

export async function loadActivity(
	ctx: Pick<PluginContext, "kv">,
	items: Pick<AiSearchItems, "list">,
	indexer: Pick<Indexer, "describeRecord">,
): Promise<Activity> {
	const [recent, errors, skipped, queue] = await Promise.all([
		items.list({ per_page: RECENT_COUNT }),
		items.list({ status: "error", per_page: FAILED_SAMPLE }),
		items.list({ status: "skipped", per_page: FAILED_SAMPLE }),
		getRetryQueue(ctx),
	]);
	const failed = [errors, skipped];
	const processing = failed.flatMap((list) => list.result.flatMap(toActivityItem));
	const groups = [
		...groupBy(queue.items.toReversed(), "upload", (item) => item.error, {
			retrying: (item) => item.nextAt !== null,
		}),
		...groupBy(processing, "processing", (item) => item.error ?? ""),
	].toSorted((a, b) => b.count - a.count);
	const shown = groups.slice(0, MAX_GROUPS);
	const failedTotal = failed.reduce(
		(sum, list) => sum + (list.result_info?.total_count ?? list.result.length),
		0,
	);
	const grouped = shown.reduce((sum, group) => sum + group.count, 0);

	const titleOf = async (record: RetryItem | ActivityItem) =>
		"title" in record ? record.title : indexer.describeRecord(record.source, record.id);
	const attention = await Promise.all(
		shown.map(async ({ records, ...group }) => ({
			...group,
			records: await Promise.all(
				records.slice(0, RECORDS_PER_GROUP).map(async (record) => ({
					source: record.source,
					id: record.id,
					title: await titleOf(record),
				})),
			),
		})),
	);
	return {
		recent: recent.result.flatMap(toActivityItem),
		attention,
		unlisted: queue.items.length + queue.dropped + failedTotal - grouped,
	};
}

function groupBy<T extends { source: string; id: string }>(
	records: T[],
	stage: AttentionGroup["stage"],
	reasonOf: (record: T) => string,
	options: { retrying?: (record: T) => boolean } = {},
): Array<Omit<AttentionGroup, "records"> & { records: T[] }> {
	const groups = new Map<string, Omit<AttentionGroup, "records"> & { records: T[] }>();
	for (const record of records) {
		const reason = reasonOf(record);
		const group = groups.get(reason) ?? { stage, reason, count: 0, retrying: false, records: [] };
		group.count++;
		group.retrying ||= options.retrying?.(record) ?? false;
		group.records.push(record);
		groups.set(reason, group);
	}
	return [...groups.values()];
}

/** Number of items per source, in any state. While an item is reprocessed, search still serves its previous version. */
export async function countBySource(
	items: Pick<AiSearchItems, "list">,
	sources: string[],
): Promise<Record<string, number>> {
	const counts = await Promise.all(
		sources.map(async (source) => {
			const { result_info } = await items.list({
				metadata_filter: JSON.stringify({ source }),
				per_page: 1,
			});
			return [source, result_info?.total_count ?? 0] as const;
		}),
	);
	return Object.fromEntries(counts);
}

function toActivityItem(item: AiSearchItemInfo): ActivityItem[] {
	const match = KEY.exec(item.key);
	if (!match) return [];
	const [, source = "", id = ""] = match;
	const metadata = readMetadata(item.metadata);
	return [
		{
			source,
			id,
			title: metadata?.title ?? id,
			locale: metadata?.locale ?? "",
			status: item.status,
			...(item.error ? { error: item.error } : {}),
			...(item.last_seen_at ? { updatedAt: toIsoTime(item.last_seen_at) } : {}),
		},
	];
}

/** AI Search reports UTC times as `YYYY-MM-DD HH:MM:SS`, without a zone. */
export function toIsoTime(time: string): string {
	return `${time.replace(" ", "T")}Z`;
}
