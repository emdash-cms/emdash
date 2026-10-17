import type { StorageCollection } from "emdash";

import { readMetadata } from "./documents.js";
import { itemState, type ItemState } from "./ingestion.js";

/** Name of the plugin storage collection holding the snapshot. */
export const SNAPSHOT = "snapshot";

/** Rows deleted per round trip. D1 binds at most 100 parameters per statement. */
const CLEAR_BATCH = 50;

/** What a build needs to know about an existing AI Search item. */
export interface IndexedItem {
	itemId: string;
	/** Hash of the document the item was uploaded from. */
	hash: string | null;
	/** AI Search could not process the item, so it must be uploaded again. */
	failed: boolean;
	state: ItemState;
}

/** A snapshot row, stored under the item's key. */
export interface SnapshotRow extends IndexedItem {
	source: string;
}

/**
 * The AI Search items of the source a build is working on, read before it
 * uploads anything. Items cannot be looked up in bulk by key, and their list
 * order shifts with every upload, so the build reads them all first.
 */
export type SnapshotStore = Pick<
	StorageCollection<SnapshotRow>,
	"getMany" | "putMany" | "query" | "deleteMany"
>;

export function toIndexedItem(item: AiSearchItemInfo): IndexedItem {
	return {
		itemId: item.id,
		hash: readMetadata(item.metadata)?.hash ?? null,
		failed: item.status === "error",
		state: itemState(item.status),
	};
}

export async function clearSnapshot(store: SnapshotStore, source: string): Promise<void> {
	for (;;) {
		// oxlint-disable-next-line no-await-in-loop -- each batch depends on the previous delete
		const { items } = await store.query({ where: { source }, limit: CLEAR_BATCH });
		if (items.length === 0) return;
		// oxlint-disable-next-line no-await-in-loop -- see above
		await store.deleteMany(items.map((row) => row.id));
	}
}

export async function saveSnapshot(
	store: SnapshotStore,
	source: string,
	items: AiSearchItemInfo[],
): Promise<void> {
	await store.putMany(
		items.map((item) => ({ id: item.key, data: { source, ...toIndexedItem(item) } })),
	);
}
