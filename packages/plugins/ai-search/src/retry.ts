import type { PluginContext } from "emdash";

import { failureOf, type Indexer, shouldBackOff } from "./indexer.js";
import type { ItemState } from "./ingestion.js";
import { updateKv } from "./kv.js";

/** Key of the queue in `ctx.kv`, and name of the cron task that works through it. */
const RETRY = "retry";

const MAX_ATTEMPTS = 5;
const FIRST_DELAY_MS = 60_000;
/** Older failures beyond this are dropped and only counted. A rebuild retries them. */
const MAX_QUEUED = 500;
const MAX_ERROR_LENGTH = 300;

export interface RecordRef {
	source: string;
	id: string;
}

interface Failure extends RecordRef {
	error: string;
	/** The state of the item AI Search still holds for the record, if any. */
	leftover?: ItemState;
}

export interface RetryItem extends Failure {
	attempts: number;
	failedAt: number;
	/** When the next automatic attempt is due, or null once attempts run out. */
	nextAt: number | null;
}

export interface RetryQueue {
	items: RetryItem[];
	/** Failures dropped because the queue was full. */
	dropped: number;
}

type RetryContext = Pick<PluginContext, "kv" | "cron">;

export async function getRetryQueue(ctx: Pick<PluginContext, "kv">): Promise<RetryQueue> {
	return (await ctx.kv.get<RetryQueue>(RETRY)) ?? { items: [], dropped: 0 };
}

/**
 * Records records that could not be synced, so the `retry` cron task tries
 * them again with increasing delays.
 */
export async function queueRetries(ctx: RetryContext, failures: Failure[]): Promise<void> {
	if (failures.length === 0) return;
	await updateKv<RetryQueue>(ctx, RETRY, (queue) => {
		const now = Date.now();
		const items = new Map((queue?.items ?? []).map((item) => [refKey(item), item]));
		for (const failure of failures) {
			const attempts = (items.get(refKey(failure))?.attempts ?? 0) + 1;
			items.delete(refKey(failure));
			items.set(refKey(failure), {
				...failure,
				error: failure.error.slice(0, MAX_ERROR_LENGTH),
				attempts,
				failedAt: now,
				nextAt: attempts < MAX_ATTEMPTS ? now + FIRST_DELAY_MS * 2 ** (attempts - 1) : null,
			});
		}
		const all = [...items.values()];
		const overflow = Math.max(0, all.length - MAX_QUEUED);
		return { items: all.slice(overflow), dropped: (queue?.dropped ?? 0) + overflow };
	});
	await ctx.cron?.schedule(RETRY, { schedule: "* * * * *" });
}

export type RetryOutcome = "synced" | "failed" | "busy";

/** Syncs a record again, removing it from the queue on success. */
export async function retryRecord(
	ctx: RetryContext,
	indexer: Pick<Indexer, "syncRecord">,
	record: RecordRef,
): Promise<RetryOutcome> {
	try {
		await indexer.syncRecord(record.source, record.id);
	} catch (error) {
		if (shouldBackOff(error)) return "busy";
		await queueRetries(ctx, [{ source: record.source, id: record.id, ...failureOf(error) }]);
		return "failed";
	}
	await clearRetry(ctx, record);
	return "synced";
}

/** Removes a record from the queue once it has been synced. */
export async function clearRetry(ctx: Pick<PluginContext, "kv">, record: RecordRef): Promise<void> {
	await updateKv<RetryQueue>(ctx, RETRY, (queue) => {
		if (!queue?.items.some((item) => refKey(item) === refKey(record))) return undefined;
		const items = queue.items.filter((item) => refKey(item) !== refKey(record));
		return items.length > 0 || queue.dropped > 0 ? { ...queue, items } : null;
	});
}

/**
 * Removes records from the queue once a build has synced them, including
 * those whose automatic retries ran out. Keeps failures recorded at or after
 * `syncedSince`, which may be newer than the sync.
 */
export async function clearSynced(
	ctx: Pick<PluginContext, "kv">,
	records: RecordRef[],
	syncedSince: number,
): Promise<void> {
	if (records.length === 0) return;
	const synced = new Set(records.map(refKey));
	await updateKv<RetryQueue>(ctx, RETRY, (queue) => {
		const isCleared = (item: RetryItem) => synced.has(refKey(item)) && item.failedAt < syncedSince;
		if (!queue?.items.some(isCleared)) return undefined;
		const items = queue.items.filter((item) => !isCleared(item));
		return items.length > 0 || queue.dropped > 0 ? { ...queue, items } : null;
	});
}

/** Retries every record that is due, until `budgetMs` has passed or AI Search rate-limits. */
export async function runRetries(
	ctx: RetryContext,
	indexer: Pick<Indexer, "syncRecord">,
	budgetMs: number,
): Promise<void> {
	const deadline = Date.now() + budgetMs;
	const { items } = await getRetryQueue(ctx);
	const due = items.filter((item) => item.nextAt !== null && item.nextAt <= Date.now());
	for (const item of due) {
		if (Date.now() >= deadline) break;
		// oxlint-disable-next-line no-await-in-loop -- one at a time, to stop at the first rate limit
		if ((await retryRecord(ctx, indexer, item)) === "busy") break;
	}
	const remaining = await getRetryQueue(ctx);
	if (!remaining.items.some((item) => item.nextAt !== null)) await ctx.cron?.cancel(RETRY);
}

/** Forgets how many failures were dropped, once a rebuild will retry them. */
export async function clearDropped(ctx: Pick<PluginContext, "kv">): Promise<void> {
	await updateKv<RetryQueue>(ctx, RETRY, (queue) => {
		if (!queue?.dropped) return undefined;
		return queue.items.length > 0 ? { ...queue, dropped: 0 } : null;
	});
}

function refKey(record: RecordRef): string {
	return `${record.source}/${record.id}`;
}
