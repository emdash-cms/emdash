/**
 * Cold-start discovery worker.
 *
 * Operator-triggered (via `POST /_admin/backfill`); takes a list of DIDs,
 * calls `com.atproto.repo.listRecords` against each publisher's PDS for every
 * collection in `WANTED_COLLECTIONS`, and enqueues each returned record onto
 * the existing Records Queue as a `RecordsJob`. The consumer's verification +
 * write + idempotency machinery handles the rest — same code path as live
 * Jetstream, distinguished only by trigger.
 *
 * Live discovery is Jetstream's job, not this worker's; it picks up new
 * publishers automatically. Backfill exists for the cold-start gap (publishers
 * who published before the aggregator was listening) and for operator-triggered
 * recovery after a known outage. There is deliberately no periodic scheduler
 * — see plan §"Why no reconciliation cron".
 */

import { WANTED_COLLECTIONS } from "./constants.js";
import type { DidResolver } from "./did-resolver.js";
import type { RecordsJob } from "./env.js";
import { isPlainObject } from "./utils.js";

const PAGE_SIZE = 100;
/** Cap on listRecords pagination per collection. A buggy or malicious PDS
 * that echoes the same cursor would otherwise loop forever inside one
 * `ctx.waitUntil`. 1000 pages × 100 records = 100k records per collection,
 * which is past anything we'd legitimately backfill in one shot. */
const MAX_PAGES_PER_COLLECTION = 1000;
/** Defensive cap on records per page. Real PDSes honour the `limit` query
 * param; this guards against a hostile PDS returning an enormous array.
 * Capped at the same width as Cloudflare Queues' sendBatch (100) so a
 * compliant page maps 1:1 to one batch send; oversize pages are rejected
 * rather than chunked, surfacing the PDS's spec violation as a partial
 * failure the operator can investigate. */
const MAX_RECORDS_PER_PAGE = PAGE_SIZE;
/** Cloudflare Queues' hard cap on `sendBatch` size. Per-page enqueues are
 * always ≤ this thanks to MAX_RECORDS_PER_PAGE; documented here so the
 * relationship is visible at the call site. */
const QUEUE_SEND_BATCH_CAP = 100;
/** Cap on the total number of records a single backfill invocation may
 * enqueue. Defends against a leaked admin token being weaponised to flood
 * the queue at near-zero cost to the attacker. The blast radius of one
 * compromised POST is bounded by this number × per-message billing.
 *
 * 50k = ~50 plausible publishers × ~250 records each, well past v1 scale.
 * Worker waitUntil exhausts long before this in any honest workload. */
const MAX_TOTAL_ENQUEUE = 50_000;
/** Atproto rkey grammar: ALPHA / DIGIT / "." / "-" / "_" / ":" / "~". */
const RKEY_PATTERN = /^[A-Za-z0-9._:~-]{1,512}$/;

/** Thrown when the per-invocation enqueue cap is reached. Caller catches
 * and stops processing further DIDs / collections; partial work already
 * committed to the queue is what it is (consumer is idempotent on retry). */
export class EnqueueLimitReached extends Error {
	constructor(public readonly limit: number) {
		super(`backfill enqueue cap of ${limit} reached`);
	}
}

/** Producer-side queue surface. The production binding `env.RECORDS_QUEUE`
 * satisfies this; tests pass an in-memory implementation. The return type
 * is `unknown` rather than `void` so workerd's `Queue.send` (which returns
 * a `QueueSendResponse`) is structurally assignable. */
export interface BackfillQueue {
	sendBatch(messages: ReadonlyArray<{ body: RecordsJob }>): Promise<unknown>;
}

export interface BackfillDeps {
	resolver: DidResolver;
	queue: BackfillQueue;
	/** Inject for tests; defaults to `globalThis.fetch`. */
	fetch?: typeof fetch;
	/** Optional callback fired after each DID completes (success or failure).
	 * Used by the production wiring to log per-DID progress so an operator
	 * watching `wrangler tail` sees where a long backfill is up to. */
	onDidComplete?: (result: BackfillDidResult) => void;
}

export interface BackfillDidResult {
	did: string;
	enqueued: number;
	/** One entry per failure during this DID's backfill. listRecords failures
	 * are per-collection; resolution failures abort early. Empty array on
	 * total success. */
	errors: string[];
}

export interface BackfillSummary {
	totalEnqueued: number;
	results: BackfillDidResult[];
}

/**
 * Backfill multiple DIDs serially. Per-DID failures don't stop the loop —
 * one bad publisher doesn't block the rest.
 *
 * Aborts the loop early if the per-invocation enqueue cap is reached. The
 * partial summary still reflects what got through; the operator can re-run
 * with the unfinished tail of the DID list.
 */
export async function backfillDids(
	dids: readonly string[],
	deps: BackfillDeps,
): Promise<BackfillSummary> {
	const results: BackfillDidResult[] = [];
	const budget: EnqueueBudget = { remaining: MAX_TOTAL_ENQUEUE };
	for (const did of dids) {
		const result = await backfillDid(did, deps, budget);
		results.push(result);
		deps.onDidComplete?.(result);
		if (budget.remaining <= 0) {
			console.warn("[aggregator] backfill enqueue cap reached, aborting remaining DIDs", {
				cap: MAX_TOTAL_ENQUEUE,
				didsProcessed: results.length,
				didsRemaining: dids.length - results.length,
			});
			break;
		}
	}
	const totalEnqueued = results.reduce((sum, r) => sum + r.enqueued, 0);
	return { totalEnqueued, results };
}

/** Mutable counter shared across the per-DID / per-collection loops so the
 * cap is global to one backfill invocation. */
interface EnqueueBudget {
	remaining: number;
}

/**
 * Backfill a single DID across every collection in `WANTED_COLLECTIONS`.
 * Resolution failure aborts (we can't enqueue verifiable jobs without
 * knowing the PDS); per-collection listRecords failures are recorded and
 * the loop continues to the next collection.
 *
 * Optional `budget` shares the per-invocation enqueue cap across DIDs.
 * Tests that call this directly without a budget get an effectively
 * unbounded one.
 */
export async function backfillDid(
	did: string,
	deps: BackfillDeps,
	budget: EnqueueBudget = { remaining: MAX_TOTAL_ENQUEUE },
): Promise<BackfillDidResult> {
	const errors: string[] = [];
	let enqueued = 0;

	// resolve() writes to known_publishers as a side-effect of the cache
	// upsert, so this also registers the publisher for any future code path
	// that iterates that table.
	let pds: string;
	try {
		const resolved = await deps.resolver.resolve(did);
		pds = resolved.pds;
	} catch (err) {
		errors.push(`resolve failed: ${err instanceof Error ? err.message : String(err)}`);
		return { did, enqueued, errors };
	}

	const fetchImpl = deps.fetch ?? fetch;
	for (const collection of WANTED_COLLECTIONS) {
		// Track this collection's enqueues separately so a mid-pagination
		// throw still reports the partial count instead of swallowing the
		// records that already landed in the queue.
		const before = budget.remaining;
		try {
			await backfillCollection({
				did,
				pds,
				collection,
				queue: deps.queue,
				fetchImpl,
				budget,
			});
		} catch (err) {
			if (err instanceof EnqueueLimitReached) {
				// Stop processing further collections for this DID; outer
				// loop will catch the budget exhaustion and stop entirely.
				enqueued += before - budget.remaining;
				return { did, enqueued, errors };
			}
			errors.push(`${collection}: ${err instanceof Error ? err.message : String(err)}`);
		}
		enqueued += before - budget.remaining;
	}

	return { did, enqueued, errors };
}

interface BackfillCollectionOpts {
	did: string;
	pds: string;
	collection: string;
	queue: BackfillQueue;
	fetchImpl: typeof fetch;
	budget: EnqueueBudget;
}

/**
 * Walk one DID's records for a single collection, paginating through
 * `listRecords` and enqueuing each result via `sendBatch` (one batch per
 * page). Decrements `opts.budget.remaining` per record enqueued; throws
 * `EnqueueLimitReached` when the budget hits zero so the caller can stop
 * processing further collections / DIDs.
 *
 * 404 from the PDS on the FIRST page means the repo doesn't host this
 * collection — silently treated as zero records, not an error. A 404
 * mid-pagination is a partial-failure signal (the PDS is misrouting one
 * page while the rest of the repo is fine) and throws.
 *
 * Pagination is capped at MAX_PAGES_PER_COLLECTION + cursor-equality check
 * to defend against a PDS that echoes the same cursor forever.
 *
 * `MAX_RECORDS_PER_PAGE` matches Cloudflare Queues' `sendBatch` cap (100),
 * so a compliant page maps 1:1 to one batch send. A PDS that ignores the
 * `?limit=` query and returns more records than that throws — we'd rather
 * surface the spec violation than silently chunk and hide the upstream bug.
 */
async function backfillCollection(opts: BackfillCollectionOpts): Promise<void> {
	let cursor: string | undefined;
	let prevCursor: string | undefined;
	let pages = 0;
	do {
		if (opts.budget.remaining <= 0) throw new EnqueueLimitReached(MAX_TOTAL_ENQUEUE);
		if (++pages > MAX_PAGES_PER_COLLECTION) {
			throw new Error(`exceeded ${MAX_PAGES_PER_COLLECTION} pages`);
		}
		if (cursor !== undefined && cursor === prevCursor) {
			throw new Error("PDS returned identical cursor twice");
		}
		prevCursor = cursor;

		const url = new URL("/xrpc/com.atproto.repo.listRecords", opts.pds);
		url.searchParams.set("repo", opts.did);
		url.searchParams.set("collection", opts.collection);
		url.searchParams.set("limit", String(PAGE_SIZE));
		if (cursor) url.searchParams.set("cursor", cursor);

		const response = await opts.fetchImpl(url.toString(), {
			headers: { accept: "application/json" },
		});
		if (response.status === 404) {
			if (cursor === undefined) {
				// First-page 404: publisher has no records of this collection.
				return;
			}
			// Mid-pagination 404 is a partial failure; surface it.
			throw new Error(`listRecords returned 404 mid-pagination at cursor=${cursor}`);
		}
		if (!response.ok) {
			throw new Error(`listRecords returned ${response.status}`);
		}

		const body: unknown = await response.json();
		const records = extractListRecordsBody(body);
		if (records.length > MAX_RECORDS_PER_PAGE) {
			throw new Error(
				`PDS returned ${records.length} records, exceeding per-page cap of ${MAX_RECORDS_PER_PAGE}`,
			);
		}
		cursor = extractCursor(body);

		const messages: { body: RecordsJob }[] = [];
		for (const record of records) {
			if (opts.budget.remaining - messages.length <= 0) break;
			const rkey = parseRkeyFromUri(record.uri, opts.collection);
			if (!rkey) continue;
			messages.push({
				body: {
					did: opts.did,
					collection: opts.collection,
					rkey,
					operation: "create",
					cid: record.cid,
				},
			});
		}
		if (messages.length > 0) {
			// Page size is capped at QUEUE_SEND_BATCH_CAP, so this single
			// sendBatch never exceeds Cloudflare's 100-message limit.
			if (messages.length > QUEUE_SEND_BATCH_CAP) {
				// Defense in depth — should be unreachable given the cap
				// above, but throwing loudly here beats a runtime error from
				// the queue binding silently dropping the batch.
				throw new Error(
					`sendBatch payload of ${messages.length} exceeds Queue cap of ${QUEUE_SEND_BATCH_CAP}`,
				);
			}
			await opts.queue.sendBatch(messages);
			opts.budget.remaining -= messages.length;
		}
		if (opts.budget.remaining <= 0) throw new EnqueueLimitReached(MAX_TOTAL_ENQUEUE);
	} while (cursor);
}

interface ListRecordEntry {
	uri: string;
	cid: string;
	value: unknown;
}

function extractListRecordsBody(body: unknown): ListRecordEntry[] {
	if (!isPlainObject(body)) return [];
	const records = body["records"];
	if (!Array.isArray(records)) return [];
	const out: ListRecordEntry[] = [];
	for (const r of records) {
		if (!isPlainObject(r)) continue;
		const uri = r["uri"];
		const cid = r["cid"];
		if (typeof uri !== "string" || typeof cid !== "string") continue;
		out.push({ uri, cid, value: r["value"] });
	}
	return out;
}

function extractCursor(body: unknown): string | undefined {
	if (!isPlainObject(body)) return undefined;
	const cursor = body["cursor"];
	return typeof cursor === "string" ? cursor : undefined;
}

/**
 * Extract the rkey from an AT URI of the shape `at://did/collection/rkey`
 * and validate it against the atproto rkey grammar. Returns null if any
 * step fails; callers treat that as "this isn't a record we recognise"
 * and skip the entry without aborting the page.
 */
function parseRkeyFromUri(uri: string, expectedCollection: string): string | null {
	const expectedPrefix = `at://`;
	if (!uri.startsWith(expectedPrefix)) return null;
	const tail = uri.slice(expectedPrefix.length);
	const slash1 = tail.indexOf("/");
	if (slash1 < 0) return null;
	const slash2 = tail.indexOf("/", slash1 + 1);
	if (slash2 < 0) return null;
	const collection = tail.slice(slash1 + 1, slash2);
	if (collection !== expectedCollection) return null;
	const rkey = tail.slice(slash2 + 1);
	if (!RKEY_PATTERN.test(rkey)) return null;
	return rkey;
}
