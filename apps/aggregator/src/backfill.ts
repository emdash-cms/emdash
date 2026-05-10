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
 * param; this guards against a hostile PDS returning an enormous array. */
const MAX_RECORDS_PER_PAGE = PAGE_SIZE * 2;
/** Atproto rkey grammar: ALPHA / DIGIT / "." / "-" / "_" / ":" / "~". */
const RKEY_PATTERN = /^[A-Za-z0-9._:~-]{1,512}$/;

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
 */
export async function backfillDids(
	dids: readonly string[],
	deps: BackfillDeps,
): Promise<BackfillSummary> {
	const results: BackfillDidResult[] = [];
	let totalEnqueued = 0;
	for (const did of dids) {
		const result = await backfillDid(did, deps);
		results.push(result);
		totalEnqueued += result.enqueued;
		deps.onDidComplete?.(result);
	}
	return { totalEnqueued, results };
}

/**
 * Backfill a single DID across every collection in `WANTED_COLLECTIONS`.
 * Resolution failure aborts (we can't enqueue verifiable jobs without
 * knowing the PDS); per-collection listRecords failures are recorded and
 * the loop continues to the next collection.
 */
export async function backfillDid(did: string, deps: BackfillDeps): Promise<BackfillDidResult> {
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
		try {
			enqueued += await backfillCollection({
				did,
				pds,
				collection,
				queue: deps.queue,
				fetchImpl,
			});
		} catch (err) {
			errors.push(`${collection}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return { did, enqueued, errors };
}

interface BackfillCollectionOpts {
	did: string;
	pds: string;
	collection: string;
	queue: BackfillQueue;
	fetchImpl: typeof fetch;
}

/**
 * Walk one DID's records for a single collection, paginating through
 * `listRecords` and enqueuing each result via `sendBatch` (one batch per
 * page). Returns the number of records enqueued.
 *
 * 404 from the PDS on the FIRST page means the repo doesn't host this
 * collection — silently treated as zero records, not an error. A 404
 * mid-pagination is a partial-failure signal (the PDS is misrouting one
 * page while the rest of the repo is fine) and throws.
 *
 * Pagination is capped at MAX_PAGES_PER_COLLECTION + cursor-equality check
 * to defend against a PDS that echoes the same cursor forever.
 */
async function backfillCollection(opts: BackfillCollectionOpts): Promise<number> {
	let enqueued = 0;
	let cursor: string | undefined;
	let prevCursor: string | undefined;
	let pages = 0;
	do {
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
				return enqueued;
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
				`PDS returned ${records.length} records, exceeding cap of ${MAX_RECORDS_PER_PAGE}`,
			);
		}
		cursor = extractCursor(body);

		const messages: { body: RecordsJob }[] = [];
		for (const record of records) {
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
			// Single batched send per page — far cheaper than the per-record
			// awaits this used to do (which couldn't possibly finish a
			// 4000-record DID inside the waitUntil budget).
			await opts.queue.sendBatch(messages);
			enqueued += messages.length;
		}
	} while (cursor);
	return enqueued;
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
