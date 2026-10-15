import type { PluginContext } from "emdash";

import { isSavedConfig } from "./config.js";
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
		return capped(queue, [...items.values()]);
	});
	await scheduleRetries(ctx);
}

/** The queue holding `items`, dropping the oldest beyond `MAX_QUEUED`. */
function capped(queue: RetryQueue | null, items: RetryItem[]): RetryQueue {
	const overflow = Math.max(0, items.length - MAX_QUEUED);
	return { items: items.slice(overflow), dropped: (queue?.dropped ?? 0) + overflow };
}

const scheduleRetries = (ctx: RetryContext) => ctx.cron?.schedule(RETRY, { schedule: "* * * * *" });

const hasPending = (queue: RetryQueue) => queue.items.some((item) => item.nextAt !== null);

export type RetryOutcome = "synced" | "failed" | "busy";

type RetryIndexer = Pick<Indexer, "config" | "syncRecord">;

/**
 * Syncs a record again, removing it from the queue on success. When the
 * settings changed while it synced, leaves it queued for a run that loads the
 * new ones and reports AI Search as busy.
 */
export async function retryRecord(
	ctx: RetryContext,
	indexer: RetryIndexer,
	record: RecordRef,
): Promise<RetryOutcome> {
	const startedAt = Date.now();
	try {
		await indexer.syncRecord(record.source, record.id);
	} catch (error) {
		if (shouldBackOff(error)) return "busy";
		await queueRetries(ctx, [{ source: record.source, id: record.id, ...failureOf(error) }]);
		return "failed";
	}
	return (await finishSync(ctx, indexer, record, startedAt)) ? "synced" : "busy";
}

/**
 * Settles the queue after `indexer` synced a record, starting at `startedAt`.
 * Removes the record's failures recorded before then; a newer one may come
 * from a change the sync did not see. When the settings changed meanwhile,
 * queues the record for an immediate retry with the new ones instead, and
 * returns false.
 */
export async function finishSync(
	ctx: RetryContext,
	indexer: Pick<Indexer, "config">,
	record: RecordRef,
	startedAt: number,
): Promise<boolean> {
	if (!(await isSavedConfig(ctx, indexer.config))) {
		await retryNow(ctx, record);
		return false;
	}
	await clearSynced(ctx, [record], startedAt);
	return true;
}

/**
 * Queues a record to be retried as soon as possible, without counting an
 * attempt. Marks it failed now, so a build that synced it earlier does not
 * clear it.
 */
async function retryNow(ctx: RetryContext, record: RecordRef): Promise<void> {
	await updateKv<RetryQueue>(ctx, RETRY, (queue) => {
		const now = Date.now();
		const items = queue?.items ?? [];
		const queued = items.find((item) => refKey(item) === refKey(record));
		const item: RetryItem = {
			error: "The settings changed while it was synced",
			attempts: 0,
			...queued,
			source: record.source,
			id: record.id,
			failedAt: now,
			nextAt: now,
		};
		return capped(queue, [...items.filter((other) => other !== queued), item]);
	});
	await scheduleRetries(ctx);
}

/**
 * Removes records from the queue once they have been synced, including
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
	indexer: RetryIndexer,
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
	if (hasPending(await getRetryQueue(ctx))) return;
	await ctx.cron?.cancel(RETRY);
	// A failure queued since the check scheduled the task this just cancelled.
	if (hasPending(await getRetryQueue(ctx))) await scheduleRetries(ctx);
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
