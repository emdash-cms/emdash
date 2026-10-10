import { toIsoTime } from "./activity.js";
import { type ContextLine, readMetadata } from "./documents.js";
import type { Exclusion, Indexer } from "./indexer.js";
import { itemState } from "./ingestion.js";
import type { RecordRef, RetryQueue } from "./retry.js";

/**
 * Where a record stands in AI Search:
 * - an `Exclusion` when it should not be indexed and is not;
 * - `leftover` when it should not be indexed but still is, until the next sync;
 * - `missing` when it should be indexed but is not;
 * - `processing`, `failed`, or `indexed` from AI Search's own item status;
 * - `outdated` when the indexed item was built from an older version.
 */
export type EntryIndexState =
	| Exclusion
	| "leftover"
	| "missing"
	| "processing"
	| "failed"
	| "outdated"
	| "indexed";

export interface EntryIndexStatus {
	state: EntryIndexState;
	/** When AI Search last changed the item. */
	updatedAt?: string;
	/** Why AI Search could not process the item. */
	error?: string;
	/** A failed upload waiting in the retry queue. */
	retry?: { error: string; automatic: boolean };
	/** Authors and terms that make the entry findable, for entries that should be indexed. */
	foundBy?: ContextLine[];
}

export async function entryIndexStatus(
	indexer: Pick<Indexer, "plan" | "indexedItem">,
	queue: RetryQueue,
	record: RecordRef,
): Promise<EntryIndexStatus> {
	const [plan, item] = await Promise.all([
		indexer.plan(record.source, record.id),
		indexer.indexedItem(record.source, record.id),
	]);
	const retry = queue.items.find(
		(queued) => queued.source === record.source && queued.id === record.id,
	);
	const status: Omit<EntryIndexStatus, "state"> = {
		...(item?.last_seen_at ? { updatedAt: toIsoTime(item.last_seen_at) } : {}),
		...(item?.error ? { error: item.error } : {}),
		...(retry ? { retry: { error: retry.error, automatic: retry.nextAt !== null } } : {}),
	};

	if (typeof plan === "string") return { ...status, state: item ? "leftover" : plan };
	if (plan.context.length > 0) status.foundBy = plan.context;
	if (!item) return { ...status, state: "missing" };
	const state = itemState(item.status);
	// While AI Search works on an upload, the item still shows the previous upload's metadata.
	if (state !== "indexed") return { ...status, state };
	if (readMetadata(item.metadata)?.hash !== plan.metadata.hash) {
		return { ...status, state: "outdated" };
	}
	return { ...status, state: "indexed" };
}
