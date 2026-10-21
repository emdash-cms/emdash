/** What an AI Search item's status means for search. */
export type ItemState = "indexed" | "processing" | "failed";

/**
 * Searchable, still being worked on, or never going to be returned. Skipped
 * items are not searchable, so they count as failed. While an item is
 * queued, running, or outdated, search still serves its previous version.
 */
export function itemState(status: AiSearchItemInfo["status"]): ItemState {
	if (status === "completed") return "indexed";
	if (status === "error" || status === "skipped") return "failed";
	return "processing";
}

export interface TotalsInput {
	stats: Pick<
		AiSearchStatsResponse,
		"completed" | "queued" | "running" | "outdated" | "error" | "skipped"
	> | null;
	/**
	 * Items the instance lists. The list includes uploads as soon as AI Search
	 * accepts them, while its stats can take a while to count them.
	 */
	listedItems: number;
	/** Records the plugin could not upload or remove, retried automatically or not. */
	uploadFailures: Array<{ leftover?: ItemState }>;
	/** Upload failures no longer listed, whose leftover items are unknown. */
	droppedFailures: number;
}

/** Records per state, as every admin view reports them. */
export interface IndexTotals {
	indexed: number;
	processing: number;
	/** Records AI Search could not process, and records the plugin could not upload. */
	failed: number;
}

export function indexTotals({
	stats,
	listedItems,
	uploadFailures,
	droppedFailures,
}: TotalsInput): IndexTotals {
	const completed = stats?.completed ?? 0;
	const processingFailed = (stats?.error ?? 0) + (stats?.skipped ?? 0);
	const inProgress = (stats?.queued ?? 0) + (stats?.running ?? 0) + (stats?.outdated ?? 0);
	// Listed items the stats leave out are uploads they have not counted yet.
	const unseen = listedItems - completed - processingFailed - inProgress;
	// A record whose upload failed may still have an older item, which the stats count under its own state.
	const leftovers = { indexed: 0, processing: 0, failed: 0 };
	for (const failure of uploadFailures) if (failure.leftover) leftovers[failure.leftover]++;
	return {
		indexed: Math.max(completed - leftovers.indexed, 0),
		processing: Math.max(inProgress + Math.max(unseen, 0) - leftovers.processing, 0),
		failed:
			Math.max(processingFailed - leftovers.failed, 0) + uploadFailures.length + droppedFailures,
	};
}
