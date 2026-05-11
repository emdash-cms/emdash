/**
 * Cold-start discovery worker.
 *
 * Operator-triggered (via `POST /_admin/backfill`). Two trigger shapes:
 *
 *   - `{ "dids": [...] }` — explicit list, primarily for testing or recovery
 *     of a known DID set.
 *   - `{}` (empty body) — production cold-start. Calls
 *     `com.atproto.sync.listReposByCollection` against the configured relay
 *     for each NSID in `WANTED_COLLECTIONS`, paginates the full DID set,
 *     dedupes, and feeds the union into the same backfill loop.
 *
 * Architecture: the POST handler synchronously discovers DIDs (or accepts an
 * explicit list), then fans out one `BackfillJob = { did, collection }` per
 * (DID × WANTED_COLLECTIONS) pair onto the dedicated `BACKFILL_QUEUE` via
 * `sendBatch`. A separate consumer (`backfill-consumer.ts`) processes one
 * pair at a time: resolve PDS, paginate `com.atproto.repo.listRecords`,
 * batch-enqueue each returned record onto the existing Records Queue.
 *
 * Why a separate queue rather than running the per-DID loop inside the
 * `ctx.waitUntil` of the POST handler: Cloudflare's hard 30-second
 * wall-clock cap on `waitUntil` would limit a single backfill POST to
 * ~15–25 DIDs before in-flight work was cancelled. The queue gives us
 * automatic retry, concurrency, and per-pair invocation budgets that each
 * fit comfortably under the sub-request ceiling.
 *
 * Live discovery (post-cold-start) is Jetstream's job, not this worker's;
 * the consumer writes `known_publishers` opportunistically on any record
 * event for an unseen DID. Backfill exists for the cold-start gap
 * (publishers who published before the aggregator was listening) and for
 * operator-triggered recovery after a known outage. There is deliberately
 * no periodic scheduler — see plan §"Why no reconciliation cron".
 */

import { parseCanonicalResourceUri } from "@atcute/lexicons/syntax";

import { WANTED_COLLECTIONS } from "./constants.js";
import type { DidResolver } from "./did-resolver.js";
import type { BackfillJob, RecordsJob } from "./env.js";
import { isPlainObject } from "./utils.js";

const PAGE_SIZE = 100;
/** Per-listRecords-page timeout. A hostile or hung publisher PDS that
 * accepts the connection but stalls the body would otherwise block the
 * fetch until workerd's overall sub-request budget exhausts — starving
 * every later page in the same consumer invocation. Same shape as
 * `pds-verify.ts`'s fetchCar timeout. */
const LIST_RECORDS_TIMEOUT_MS = 15_000;
/** Cap on listRecords pagination per (DID, collection) pair. A buggy or
 * malicious PDS that echoes the same cursor would otherwise loop forever
 * inside one consumer invocation. 1000 pages × 100 records = 100k records
 * per pair, which is past anything we'd legitimately backfill in one shot. */
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
export const QUEUE_SEND_BATCH_CAP = 100;
// Static guard: bumping MAX_RECORDS_PER_PAGE above the queue's batch cap
// would silently break sendBatch in production. Surface the violation at
// module load rather than at the first batch send.
if (MAX_RECORDS_PER_PAGE > QUEUE_SEND_BATCH_CAP) {
	throw new Error(
		`MAX_RECORDS_PER_PAGE (${MAX_RECORDS_PER_PAGE}) exceeds QUEUE_SEND_BATCH_CAP (${QUEUE_SEND_BATCH_CAP})`,
	);
}
/** Producer-side records queue surface. The production binding
 * `env.RECORDS_QUEUE` satisfies this; tests pass an in-memory implementation. */
export interface RecordsQueueProducer {
	sendBatch(messages: ReadonlyArray<{ body: RecordsJob }>): Promise<unknown>;
}

/** Producer-side backfill-jobs queue surface. The production binding
 * `env.BACKFILL_QUEUE` satisfies this; tests pass an in-memory
 * implementation. Same shape as `RecordsQueueProducer`, separated so the
 * type system catches accidental cross-wiring. */
export interface BackfillQueueProducer {
	sendBatch(messages: ReadonlyArray<{ body: BackfillJob }>): Promise<unknown>;
}

/** Cap on pages walked per relay collection. Same shape as
 * MAX_PAGES_PER_COLLECTION but for the discovery side. At 100 repos/page,
 * 100 pages = 10k publishers — past anything we'd legitimately discover at
 * Slice 1 scale. */
const MAX_DISCOVERY_PAGES_PER_COLLECTION = 100;
const DISCOVERY_PAGE_SIZE = 100;
const DISCOVERY_TIMEOUT_MS = 15_000;
/** Defensive cap on the union of discovered DIDs. A relay returning a
 * runaway list (bug or hostile mirror) would otherwise let one POST fan
 * out millions of jobs onto BACKFILL_QUEUE. At Slice 1 scale we expect a
 * handful to a few hundred publishers. */
export const MAX_DISCOVERED_DIDS = 1000;

/**
 * Discover all DIDs publishing any of `WANTED_COLLECTIONS` by querying the
 * relay's `com.atproto.sync.listReposByCollection`. Returns the union of
 * unique DIDs across all collections, in arbitrary order.
 *
 * Uses the same defenses as the per-pair listRecords loop: per-page
 * timeout, max-page cap, cursor-equality check. Per-collection failures
 * are logged and the loop continues — discovery via the relay is
 * best-effort; a partial discovery list is better than none. Stops early
 * once `MAX_DISCOVERED_DIDS` is reached so a runaway relay can't pump
 * arbitrary fan-out into the queue.
 */
export async function discoverDids(
	relayUrl: string,
	opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<string[]> {
	const fetchImpl = opts.fetch ?? fetch;
	const timeoutMs = opts.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
	const dids = new Set<string>();
	for (const collection of WANTED_COLLECTIONS) {
		try {
			await discoverCollection(relayUrl, collection, fetchImpl, timeoutMs, dids);
		} catch (err) {
			console.error("[aggregator] backfill discovery failed for collection", {
				collection,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		if (dids.size >= MAX_DISCOVERED_DIDS) {
			console.warn("[aggregator] backfill discovery hit DID cap, stopping early", {
				cap: MAX_DISCOVERED_DIDS,
				stoppedAfterCollection: collection,
			});
			break;
		}
	}
	return [...dids];
}

async function discoverCollection(
	relayUrl: string,
	collection: string,
	fetchImpl: typeof fetch,
	timeoutMs: number,
	dids: Set<string>,
): Promise<void> {
	let cursor: string | undefined;
	let prevCursor: string | undefined;
	let pages = 0;
	do {
		if (++pages > MAX_DISCOVERY_PAGES_PER_COLLECTION) {
			throw new Error(`exceeded ${MAX_DISCOVERY_PAGES_PER_COLLECTION} discovery pages`);
		}
		if (cursor !== undefined && cursor === prevCursor) {
			throw new Error("relay returned identical cursor twice");
		}
		prevCursor = cursor;

		const url = new URL("/xrpc/com.atproto.sync.listReposByCollection", relayUrl);
		url.searchParams.set("collection", collection);
		url.searchParams.set("limit", String(DISCOVERY_PAGE_SIZE));
		if (cursor) url.searchParams.set("cursor", cursor);

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let response: Response;
		try {
			response = await fetchImpl(url.toString(), {
				headers: { accept: "application/json" },
				signal: controller.signal,
			});
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") {
				throw new Error(`listReposByCollection timed out after ${timeoutMs}ms`, { cause: err });
			}
			throw err;
		} finally {
			clearTimeout(timer);
		}
		if (!response.ok) {
			throw new Error(`listReposByCollection returned ${response.status}`);
		}
		const body: unknown = await response.json();
		if (!isPlainObject(body)) throw new Error("listReposByCollection returned non-object body");
		const repos = body["repos"];
		if (!Array.isArray(repos)) {
			throw new Error("listReposByCollection response missing `repos` array");
		}
		for (const repo of repos) {
			if (!isPlainObject(repo)) continue;
			const did = repo["did"];
			if (typeof did === "string") {
				dids.add(did);
				if (dids.size >= MAX_DISCOVERED_DIDS) return;
			}
		}
		const nextCursor = body["cursor"];
		cursor = typeof nextCursor === "string" && nextCursor.length > 0 ? nextCursor : undefined;
	} while (cursor);
}

/**
 * Fan out backfill work for a list of DIDs onto `BACKFILL_QUEUE`. Produces
 * one `BackfillJob` per (DID × WANTED_COLLECTIONS) pair, sent in batches
 * of up to `QUEUE_SEND_BATCH_CAP` to honour Cloudflare Queues' sendBatch
 * limit. Returns the total number of jobs enqueued.
 *
 * Caller is responsible for capping `dids.length` (admin route enforces
 * `MAX_BACKFILL_DIDS` for the explicit path; `discoverDids` enforces
 * `MAX_DISCOVERED_DIDS` for the discovery path). This function trusts its
 * input and just fans out — the per-call work is bounded by
 * `dids.length * WANTED_COLLECTIONS.length` enqueues.
 */
export async function enqueueBackfillJobs(
	dids: readonly string[],
	queue: BackfillQueueProducer,
): Promise<number> {
	const messages: { body: BackfillJob }[] = [];
	for (const did of dids) {
		for (const collection of WANTED_COLLECTIONS) {
			messages.push({ body: { did, collection } });
		}
	}
	// Fan the sendBatch calls in parallel. Each is an independent outbound
	// sub-request and the orchestrator runs inside the POST handler's 30s
	// `waitUntil` budget — serial awaits on a `MAX_DISCOVERED_DIDS`-sized
	// fan-out (1000 DIDs × 4 collections / 100 = 40 batches) would
	// noticeably eat into the cold-start budget on top of discovery's own
	// fetches.
	const sends: Promise<unknown>[] = [];
	for (let i = 0; i < messages.length; i += QUEUE_SEND_BATCH_CAP) {
		sends.push(queue.sendBatch(messages.slice(i, i + QUEUE_SEND_BATCH_CAP)));
	}
	await Promise.all(sends);
	return messages.length;
}

export interface ProcessBackfillJobDeps {
	resolver: DidResolver;
	queue: RecordsQueueProducer;
	/** Inject for tests; defaults to `globalThis.fetch`. */
	fetch?: typeof fetch;
	/** Override for the per-listRecords-page timeout. Defaults to
	 * `LIST_RECORDS_TIMEOUT_MS`. Tests use a small value to exercise the
	 * abort path without burning the production budget. */
	listRecordsTimeoutMs?: number;
}

export interface ProcessBackfillJobResult {
	did: string;
	collection: string;
	enqueued: number;
}

/**
 * Process one (DID, collection) pair: resolve the DID's PDS, paginate
 * `com.atproto.repo.listRecords` for the collection, and batch-enqueue
 * each returned record onto the records queue.
 *
 * Throws on any failure (resolution, listRecords status, pagination
 * runaway). The queue consumer translates a thrown result into
 * `message.retry()`; messages that exhaust max_retries land in the
 * backfill DLQ for the operator to inspect.
 *
 * 404 from the PDS on the first page is treated as "publisher does not
 * host this collection" and returns 0 enqueues without throwing — same
 * shape as the previous serial-loop semantics.
 */
export async function processBackfillJob(
	job: BackfillJob,
	deps: ProcessBackfillJobDeps,
): Promise<ProcessBackfillJobResult> {
	const resolved = await deps.resolver.resolve(job.did);
	const fetchImpl = deps.fetch ?? fetch;
	const timeoutMs = deps.listRecordsTimeoutMs ?? LIST_RECORDS_TIMEOUT_MS;
	const enqueued = await paginateAndEnqueue({
		did: job.did,
		pds: resolved.pds,
		collection: job.collection,
		queue: deps.queue,
		fetchImpl,
		timeoutMs,
	});
	return { did: job.did, collection: job.collection, enqueued };
}

interface PaginateOpts {
	did: string;
	pds: string;
	collection: string;
	queue: RecordsQueueProducer;
	fetchImpl: typeof fetch;
	timeoutMs: number;
}

/**
 * Walk one DID's records for a single collection, paginating through
 * `listRecords` and enqueuing each result via `sendBatch` (one batch per
 * page). Returns the total records enqueued.
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
async function paginateAndEnqueue(opts: PaginateOpts): Promise<number> {
	let cursor: string | undefined;
	let prevCursor: string | undefined;
	let pages = 0;
	let totalEnqueued = 0;
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

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
		let response: Response;
		try {
			response = await opts.fetchImpl(url.toString(), {
				headers: { accept: "application/json" },
				signal: controller.signal,
			});
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") {
				throw new Error(`listRecords timed out after ${opts.timeoutMs}ms`, { cause: err });
			}
			throw err;
		} finally {
			clearTimeout(timer);
		}
		if (response.status === 404) {
			if (cursor === undefined) {
				// First-page 404: publisher has no records of this collection.
				return totalEnqueued;
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
			const parsed = parseCanonicalResourceUri(record.uri);
			if (!parsed.ok) continue;
			// Defence vs. a buggy/malicious PDS that returns records under
			// a different DID (or a different collection) than the one we
			// asked for. Such jobs would never verify (signature would be
			// from a different key) and would just churn dead-letters; drop
			// at the source. `parseCanonicalResourceUri` already validated
			// the rkey grammar and the collection NSID for us, so we only
			// need the cross-checks here.
			if (parsed.value.repo !== opts.did) continue;
			if (parsed.value.collection !== opts.collection) continue;
			messages.push({
				body: {
					did: opts.did,
					collection: opts.collection,
					rkey: parsed.value.rkey,
					operation: "create",
					cid: record.cid,
				},
			});
		}
		if (messages.length > 0) {
			// Page size is capped at QUEUE_SEND_BATCH_CAP at module load via
			// the static assertion above, so this sendBatch never exceeds
			// Cloudflare's 100-message limit by construction.
			await opts.queue.sendBatch(messages);
			totalEnqueued += messages.length;
		}
	} while (cursor);
	return totalEnqueued;
}

interface ListRecordEntry {
	uri: string;
	cid: string;
	value: unknown;
}

/**
 * Parse a `com.atproto.repo.listRecords` response body. Throws on any
 * structural mismatch — a PDS that 200s with the wrong shape is upstream
 * breakage, not "no records", and silently treating it as the latter
 * causes operator-invisible partial backfills. The thrown error
 * propagates out of `processBackfillJob` and the queue consumer retries
 * (then DLQs) per the standard policy.
 */
function extractListRecordsBody(body: unknown): ListRecordEntry[] {
	if (!isPlainObject(body)) {
		throw new Error("listRecords response was not a JSON object");
	}
	const records = body["records"];
	if (!Array.isArray(records)) {
		throw new Error("listRecords response missing `records` array");
	}
	const out: ListRecordEntry[] = [];
	for (const r of records) {
		if (!isPlainObject(r)) {
			throw new Error("listRecords record entry was not a JSON object");
		}
		const uri = r["uri"];
		const cid = r["cid"];
		if (typeof uri !== "string" || typeof cid !== "string") {
			throw new Error("listRecords record entry missing string `uri` or `cid`");
		}
		out.push({ uri, cid, value: r["value"] });
	}
	return out;
}

/**
 * Pull the optional `cursor` out of a `listRecords` response. `undefined`
 * (no key) is the spec-compliant signal for "end of pagination"; any other
 * non-string value (number, object, etc.) is a PDS bug and throws so the
 * pagination loop doesn't silently terminate on the wrong page.
 */
function extractCursor(body: unknown): string | undefined {
	if (!isPlainObject(body)) {
		throw new Error("listRecords response was not a JSON object");
	}
	const cursor = body["cursor"];
	if (cursor === undefined) return undefined;
	if (typeof cursor !== "string") {
		throw new Error(`listRecords cursor was not a string (got ${typeof cursor})`);
	}
	return cursor;
}
