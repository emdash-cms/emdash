/**
 * Backfill queue consumer. Pulls one `BackfillJob` at a time and walks
 * `com.atproto.repo.listRecords` for that (DID, collection) pair, batching
 * results onto the records queue for the standard verify-and-write path.
 *
 * Why a separate queue from records: per-pair work (PDS resolution +
 * paginated listRecords + sendBatch onto the records queue) is bounded but
 * non-trivial — running it inside the records-queue consumer would burn the
 * sub-request budget for jobs that should just be writing to D1. Keeping
 * the queues separate also lets the operator throttle backfill work
 * independently of live ingest.
 *
 * Error policy:
 *   - Per-pair `processBackfillJob` throw → `message.retry()`. Cloudflare
 *     Queues backs off and retries; after `max_retries` (3, configured in
 *     wrangler.jsonc) the message lands in `emdash-aggregator-backfill-dlq`.
 *   - Unexpected throws inside the batch loop are caught per-message so one
 *     bad job can't poison the rest of the batch.
 *
 * DLQ drain (`drainBackfillDeadLetterBatch`): logs each dead-lettered
 * pair at error level (so operators tailing `wrangler tail` see it loud)
 * and acks so the DLQ doesn't accumulate unbounded. No D1 forensics row —
 * the recovery action for a backfill pair that exhausted retries is
 * "re-run backfill for the affected DID", which only needs the
 * (did, collection) pair already on the log line.
 */

import {
	AtprotoWebDidDocumentResolver,
	CompositeDidDocumentResolver,
	PlcDidDocumentResolver,
} from "@atcute/identity-resolver";

import { processBackfillJob, type ProcessBackfillJobDeps } from "./backfill.js";
import { createD1DidDocCache, DidResolver } from "./did-resolver.js";
import type { BackfillJob } from "./env.js";
import type { MessageBatchLike } from "./records-consumer.js";

/**
 * Process one batch of backfill jobs. Mirrors `records-consumer.processBatch`'s
 * shape: per-message try/catch, ack on success, retry on throw.
 *
 * `depsOverride` is the test seam — production calls without it and gets
 * the standard composite resolver wired against `env.DB`.
 */
export async function processBackfillBatch(
	batch: MessageBatchLike<BackfillJob>,
	env: Env,
	depsOverride?: ProcessBackfillJobDeps,
): Promise<void> {
	const deps = depsOverride ?? createProductionDeps(env);
	for (const message of batch.messages) {
		const job = message.body;
		try {
			const result = await processBackfillJob(job, deps);
			console.log("[aggregator] backfill job complete", {
				did: result.did,
				collection: result.collection,
				enqueued: result.enqueued,
			});
			message.ack();
		} catch (err) {
			// Resolution failures, listRecords 5xx, timeouts, and pagination
			// runaway all land here. Retry — Cloudflare Queues backoff handles
			// transient PDS failures; permanently broken DIDs land in the DLQ
			// after max_retries.
			console.error("[aggregator] backfill job failed, retrying", {
				did: job.did,
				collection: job.collection,
				error: err instanceof Error ? err.message : String(err),
			});
			message.retry();
		}
	}
}

/**
 * Drain the backfill DLQ. Mirror of `records-consumer.drainDeadLetterBatch`
 * but without the D1 forensics row — the recovery action for a backfill
 * pair that exhausted retries is "re-run backfill for the affected DID",
 * which only needs the (did, collection) pair from the log line.
 *
 * Logs at error level so operators tailing `wrangler tail` see the message
 * loud, acks so the DLQ doesn't accumulate unbounded.
 */
export function drainBackfillDeadLetterBatch(
	batch: MessageBatchLike<BackfillJob>,
	_env: Env,
): void {
	for (const message of batch.messages) {
		console.error("[aggregator] backfill DLQ drain: pair exhausted retries", {
			did: message.body.did,
			collection: message.body.collection,
		});
		message.ack();
	}
}

function createProductionDeps(env: Env): ProcessBackfillJobDeps {
	const composite = new CompositeDidDocumentResolver({
		methods: {
			plc: new PlcDidDocumentResolver(),
			web: new AtprotoWebDidDocumentResolver(),
		},
	});
	return {
		resolver: new DidResolver({
			cache: createD1DidDocCache(env.DB),
			resolver: composite,
		}),
		queue: env.RECORDS_QUEUE,
	};
}
