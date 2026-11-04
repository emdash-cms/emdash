/**
 * Concurrency-limited fan-out for bulk content actions.
 *
 * Bulk publish/draft/trash reuse the existing per-entry endpoints, so a
 * selection of N entries means N requests. Selection persists across
 * pagination, so N can grow large — an unbounded `Promise.allSettled`
 * fan-out would fire them all at once. This runs at most `concurrency`
 * requests in flight and reports which ids failed so the caller can keep
 * them selected for a retry.
 */

/** Max in-flight requests per bulk action. */
export const BULK_CONCURRENCY = 5;

export interface BulkResult {
	/** Ids whose action rejected, in input order. Empty on full success. */
	failedIds: string[];
}

export async function runBulkAction(
	ids: string[],
	action: (id: string) => Promise<unknown>,
	concurrency: number = BULK_CONCURRENCY,
): Promise<BulkResult> {
	const failed = new Set<string>();
	let nextIndex = 0;
	async function drain(): Promise<void> {
		while (nextIndex < ids.length) {
			const id = ids[nextIndex++];
			if (id === undefined) continue;
			try {
				await action(id);
			} catch {
				failed.add(id);
			}
		}
	}
	const workerCount = Math.max(1, Math.min(concurrency, ids.length));
	await Promise.all(Array.from({ length: workerCount }, () => drain()));
	return { failedIds: ids.filter((id) => failed.has(id)) };
}
