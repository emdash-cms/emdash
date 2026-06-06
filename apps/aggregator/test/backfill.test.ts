/**
 * Backfill worker tests.
 *
 * The worker is plain `fetch` + queue producers; tests stub both. The DID
 * resolver is also stubbed (in-memory cache + a simple stub upstream) so the
 * tests don't depend on the workers test pool or live PLC.
 *
 * Architecture under test (post-restructure):
 *   - `enqueueBackfillJobs`: synchronous fan-out of (DID × WANTED_COLLECTIONS)
 *     pairs onto BACKFILL_QUEUE, batched at QUEUE_SEND_BATCH_CAP.
 *   - `processBackfillJob`: per-pair worker. Resolve PDS, paginate
 *     `com.atproto.repo.listRecords`, batch-enqueue records onto RECORDS_QUEUE.
 *   - `processBackfillBatch`: queue consumer that calls `processBackfillJob`
 *     and translates throws to `message.retry()`.
 *   - `discoverDids`: relay enumeration via `com.atproto.sync.listReposByCollection`.
 */

import { P256PrivateKeyExportable } from "@atcute/crypto";
import type { DidDocument } from "@atcute/identity";
import type { Did } from "@atcute/lexicons/syntax";
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { drainBackfillDeadLetterBatch, processBackfillBatch } from "../src/backfill-consumer.js";
import {
	type BackfillQueueProducer,
	discoverDids,
	enqueueBackfillJobs,
	MAX_DISCOVERED_DIDS,
	processBackfillJob,
	QUEUE_SEND_BATCH_CAP,
	type RecordsQueueProducer,
} from "../src/backfill.js";
import { WANTED_COLLECTIONS } from "../src/constants.js";
import {
	type CachedDidDoc,
	type DidDocCache,
	type DidDocumentResolverLike,
	DidResolver,
} from "../src/did-resolver.js";
import type { BackfillJob, RecordsJob } from "../src/env.js";
import type { MessageController } from "../src/records-consumer.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}
const testEnv = env as unknown as TestEnv;

const DID_A = "did:plc:test00000000000000000000";
const DID_B = "did:plc:test00000000000000000001";
const PDS = "https://pds.test.example";

let signingKeyMultibase: string;

beforeAll(async () => {
	const kp = await P256PrivateKeyExportable.createKeypair();
	signingKeyMultibase = await kp.exportPublicKey("multikey");
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
	await testEnv.DB.prepare("DELETE FROM known_publishers").run();
});

class CapturingRecordsQueue implements RecordsQueueProducer {
	readonly sent: RecordsJob[] = [];
	sendBatch(messages: ReadonlyArray<{ body: RecordsJob }>): Promise<unknown> {
		for (const m of messages) this.sent.push(m.body);
		return Promise.resolve();
	}
}

class CapturingBackfillQueue implements BackfillQueueProducer {
	readonly sent: BackfillJob[] = [];
	readonly batches: number[] = [];
	sendBatch(messages: ReadonlyArray<{ body: BackfillJob }>): Promise<unknown> {
		this.batches.push(messages.length);
		for (const m of messages) this.sent.push(m.body);
		return Promise.resolve();
	}
}

class MapDidDocCache implements DidDocCache {
	private readonly entries = new Map<string, CachedDidDoc>();
	read(did: string): Promise<CachedDidDoc | null> {
		return Promise.resolve(this.entries.get(did) ?? null);
	}
	upsert(did: string, doc: Omit<CachedDidDoc, "resolvedAt">, now: Date): Promise<void> {
		this.entries.set(did, { ...doc, resolvedAt: now });
		return Promise.resolve();
	}
	expire(did: string): Promise<void> {
		const entry = this.entries.get(did);
		if (entry) this.entries.set(did, { ...entry, resolvedAt: new Date(0) });
		return Promise.resolve();
	}
}

class FakeMessage<T> implements MessageController {
	acked = 0;
	retried = 0;
	constructor(readonly body: T) {}
	ack() {
		this.acked += 1;
	}
	retry() {
		this.retried += 1;
	}
}

function buildResolver(): DidResolver {
	const cache = new MapDidDocCache();
	const resolver: DidDocumentResolverLike = {
		resolve(did: Did): Promise<DidDocument> {
			return Promise.resolve({
				id: did as `did:${string}:${string}`,
				verificationMethod: [
					{
						id: `${did}#atproto`,
						type: "Multikey",
						controller: did as `did:${string}:${string}`,
						publicKeyMultibase: signingKeyMultibase,
					},
				],
				service: [
					{
						id: "#atproto_pds",
						type: "AtprotoPersonalDataServer",
						serviceEndpoint: PDS,
					},
				],
			});
		},
	};
	return new DidResolver({ cache, resolver, ttlMs: 1_000_000, now: () => new Date() });
}

interface MockListRecord {
	uri: string;
	cid: string;
	value: Record<string, unknown>;
}

/**
 * Build a fetch stub that returns canned `listRecords` responses keyed by
 * collection. Records arrive as a single page; pagination is exercised in a
 * dedicated test by passing pages of records explicitly.
 */
function makeFetch(
	recordsByCollection: Record<string, MockListRecord[]>,
	overrides?: { status?: Record<string, number> },
): typeof fetch {
	return async (input) => {
		const url =
			typeof input === "string"
				? new URL(input)
				: input instanceof URL
					? input
					: new URL(input.url);
		if (!url.pathname.endsWith("/xrpc/com.atproto.repo.listRecords")) {
			return new Response("not stubbed", { status: 599 });
		}
		const collection = url.searchParams.get("collection") ?? "";
		const status = overrides?.status?.[collection];
		if (status !== undefined) {
			return new Response(JSON.stringify({ error: "X" }), {
				status,
				headers: { "content-type": "application/json" },
			});
		}
		const records = recordsByCollection[collection] ?? [];
		return new Response(JSON.stringify({ records }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
}

describe("processBackfillJob", () => {
	it("enqueues each listRecords result as a RecordsJob", async () => {
		const queue = new CapturingRecordsQueue();
		const resolver = buildResolver();
		const collection = WANTED_COLLECTIONS[0];
		if (!collection) throw new Error("test assumes ≥1 collection");
		const fetchImpl = makeFetch({
			[collection]: [
				{
					uri: `at://${DID_A}/${collection}/demo`,
					cid: "bafyc1",
					value: { foo: "bar" },
				},
			],
		});

		const result = await processBackfillJob(
			{ did: DID_A, collection },
			{ resolver, queue, fetch: fetchImpl },
		);

		expect(result.enqueued).toBe(1);
		expect(result.did).toBe(DID_A);
		expect(result.collection).toBe(collection);
		expect(queue.sent).toHaveLength(1);
		expect(queue.sent[0]).toMatchObject({
			did: DID_A,
			collection,
			rkey: "demo",
			operation: "create",
			cid: "bafyc1",
		});
		// jetstreamRecord intentionally not set on backfill jobs — the
		// consumer's DLQ payload field would otherwise mislabel
		// `listRecords` data as Jetstream-supplied data.
		expect(queue.sent[0]?.jetstreamRecord).toBeUndefined();
	});

	it("treats 404 from the PDS as 'no records of this collection', not an error", async () => {
		const queue = new CapturingRecordsQueue();
		const resolver = buildResolver();
		const collection = WANTED_COLLECTIONS[0];
		if (!collection) throw new Error("test assumes ≥1 collection");
		const fetchImpl = makeFetch({}, { status: { [collection]: 404 } });

		const result = await processBackfillJob(
			{ did: DID_A, collection },
			{ resolver, queue, fetch: fetchImpl },
		);

		expect(result.enqueued).toBe(0);
		expect(queue.sent).toHaveLength(0);
	});

	it("throws on non-404 PDS errors so the consumer can retry", async () => {
		const queue = new CapturingRecordsQueue();
		const resolver = buildResolver();
		const collection = WANTED_COLLECTIONS[0];
		if (!collection) throw new Error("test assumes ≥1 collection");
		const fetchImpl = makeFetch({}, { status: { [collection]: 503 } });

		await expect(
			processBackfillJob({ did: DID_A, collection }, { resolver, queue, fetch: fetchImpl }),
		).rejects.toThrow(/503/);
	});

	it("throws when the resolver fails (queue consumer translates to retry)", async () => {
		const queue = new CapturingRecordsQueue();
		const resolver = new DidResolver({
			cache: new MapDidDocCache(),
			resolver: {
				resolve: () => Promise.reject(new Error("PLC unreachable")),
			},
		});
		const collection = WANTED_COLLECTIONS[0];
		if (!collection) throw new Error("test assumes ≥1 collection");
		const fetchImpl = makeFetch({});

		await expect(
			processBackfillJob({ did: DID_A, collection }, { resolver, queue, fetch: fetchImpl }),
		).rejects.toThrow(/PLC unreachable/);
		expect(queue.sent).toHaveLength(0);
	});

	it("paginates listRecords via cursor", async () => {
		const queue = new CapturingRecordsQueue();
		const resolver = buildResolver();
		const collection = WANTED_COLLECTIONS[0];
		if (!collection) throw new Error("test assumes ≥1 collection");

		let calls = 0;
		const fetchImpl: typeof fetch = async (input) => {
			const url =
				typeof input === "string"
					? new URL(input)
					: input instanceof URL
						? input
						: new URL(input.url);
			calls += 1;
			const cursor = url.searchParams.get("cursor");
			if (!cursor) {
				return new Response(
					JSON.stringify({
						records: [{ uri: `at://${DID_A}/${collection}/p1`, cid: "c1", value: {} }],
						cursor: "p2",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(
				JSON.stringify({
					records: [{ uri: `at://${DID_A}/${collection}/p2`, cid: "c2", value: {} }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const result = await processBackfillJob(
			{ did: DID_A, collection },
			{ resolver, queue, fetch: fetchImpl },
		);

		expect(calls).toBe(2);
		expect(queue.sent.map((j) => j.rkey)).toEqual(["p1", "p2"]);
		expect(result.enqueued).toBe(2);
	});

	it("skips records whose URI doesn't match the expected collection (defensive)", async () => {
		const queue = new CapturingRecordsQueue();
		const resolver = buildResolver();
		const collection = WANTED_COLLECTIONS[0];
		if (!collection) throw new Error("test assumes ≥1 collection");
		const fetchImpl = makeFetch({
			[collection]: [
				{ uri: `at://${DID_A}/${collection}/legit`, cid: "c1", value: {} },
				// Buggy PDS: returns a record under the wrong collection.
				{ uri: `at://${DID_A}/wrong.collection/x`, cid: "c2", value: {} },
				// Buggy URI shape (missing rkey).
				{ uri: `at://${DID_A}/${collection}/`, cid: "c3", value: {} },
			],
		});

		const result = await processBackfillJob(
			{ did: DID_A, collection },
			{ resolver, queue, fetch: fetchImpl },
		);

		expect(queue.sent.map((j) => j.rkey)).toEqual(["legit"]);
		expect(result.enqueued).toBe(1);
	});

	it("skips records whose URI references a different DID than the job (defensive)", async () => {
		const queue = new CapturingRecordsQueue();
		const resolver = buildResolver();
		const collection = WANTED_COLLECTIONS[0];
		if (!collection) throw new Error("test assumes ≥1 collection");
		// Buggy/malicious PDS: returns a record under a *different* repo's DID.
		// Even if everything else parses, that record's signature would be
		// from the wrong key — enqueueing it would just churn dead-letters.
		const fetchImpl = makeFetch({
			[collection]: [
				{ uri: `at://${DID_A}/${collection}/legit`, cid: "c1", value: {} },
				{ uri: `at://${DID_B}/${collection}/imposter`, cid: "c2", value: {} },
			],
		});

		const result = await processBackfillJob(
			{ did: DID_A, collection },
			{ resolver, queue, fetch: fetchImpl },
		);

		expect(queue.sent.map((j) => j.rkey)).toEqual(["legit"]);
		expect(result.enqueued).toBe(1);
	});

	it("rejects records with malformed rkey (atproto rkey grammar violation)", async () => {
		const queue = new CapturingRecordsQueue();
		const resolver = buildResolver();
		const collection = WANTED_COLLECTIONS[0];
		if (!collection) throw new Error("test assumes ≥1 collection");
		const fetchImpl = makeFetch({
			[collection]: [
				{ uri: `at://${DID_A}/${collection}/legit`, cid: "c1", value: {} },
				{ uri: `at://${DID_A}/${collection}/has?queryparam`, cid: "c2", value: {} },
				{ uri: `at://${DID_A}/${collection}/has#fragment`, cid: "c3", value: {} },
				{ uri: `at://${DID_A}/${collection}/has space`, cid: "c4", value: {} },
			],
		});

		const result = await processBackfillJob(
			{ did: DID_A, collection },
			{ resolver, queue, fetch: fetchImpl },
		);
		expect(queue.sent.map((j) => j.rkey)).toEqual(["legit"]);
		expect(result.enqueued).toBe(1);
	});

	it("end-to-end against the production D1 cache: DID is registered in known_publishers", async () => {
		const queue = new CapturingRecordsQueue();
		const { createD1DidDocCache } = await import("../src/did-resolver.js");
		const cache = createD1DidDocCache(testEnv.DB);
		const collection = WANTED_COLLECTIONS[0];
		if (!collection) throw new Error("test assumes ≥1 collection");
		const resolver = new DidResolver({
			cache,
			resolver: {
				resolve: (did) =>
					Promise.resolve({
						id: did as `did:${string}:${string}`,
						verificationMethod: [
							{
								id: `${did}#atproto`,
								type: "Multikey",
								controller: did as `did:${string}:${string}`,
								publicKeyMultibase: signingKeyMultibase,
							},
						],
						service: [
							{
								id: "#atproto_pds",
								type: "AtprotoPersonalDataServer",
								serviceEndpoint: PDS,
							},
						],
					}),
			},
		});
		const fetchImpl = makeFetch({});

		await processBackfillJob({ did: DID_A, collection }, { resolver, queue, fetch: fetchImpl });

		const row = await testEnv.DB.prepare(
			`SELECT did, pds, signing_key, signing_key_id FROM known_publishers WHERE did = ?`,
		)
			.bind(DID_A)
			.first<{ did: string; pds: string; signing_key: string; signing_key_id: string }>();
		expect(row).toMatchObject({ did: DID_A, pds: PDS });
		expect(row?.signing_key).toBe(signingKeyMultibase);
	});
});

describe("processBackfillJob: defenses against malicious / buggy PDS", () => {
	it("aborts after MAX_PAGES_PER_COLLECTION when cursor never empties", async () => {
		const queue = new CapturingRecordsQueue();
		const resolver = buildResolver();
		const collection = WANTED_COLLECTIONS[0];
		if (!collection) throw new Error("test assumes ≥1 collection");
		// Hostile PDS: returns a different non-empty cursor every call so the
		// cursor-equality check doesn't fire — only the page cap stops us.
		let counter = 0;
		const fetchImpl: typeof fetch = async () => {
			counter += 1;
			return new Response(JSON.stringify({ records: [], cursor: `cursor-${counter}` }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		await expect(
			processBackfillJob({ did: DID_A, collection }, { resolver, queue, fetch: fetchImpl }),
		).rejects.toThrow(/exceeded/);
		// Loop ran at most MAX_PAGES_PER_COLLECTION times.
		expect(counter).toBeLessThanOrEqual(1001);
	});

	it("aborts when the PDS returns the identical cursor twice", async () => {
		const queue = new CapturingRecordsQueue();
		const resolver = buildResolver();
		const collection = WANTED_COLLECTIONS[0];
		if (!collection) throw new Error("test assumes ≥1 collection");
		// Buggy PDS: echoes the cursor we sent.
		let calls = 0;
		const fetchImpl: typeof fetch = async () => {
			calls += 1;
			return new Response(JSON.stringify({ records: [], cursor: "stuck" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		await expect(
			processBackfillJob({ did: DID_A, collection }, { resolver, queue, fetch: fetchImpl }),
		).rejects.toThrow(/identical cursor/);
		expect(calls).toBe(2); // first page, then second page caught the dupe
	});

	it("treats 404 mid-pagination as a partial failure (throws)", async () => {
		const queue = new CapturingRecordsQueue();
		const resolver = buildResolver();
		const collection = WANTED_COLLECTIONS[0];
		if (!collection) throw new Error("test assumes ≥1 collection");
		const fetchImpl: typeof fetch = async (input) => {
			const url =
				typeof input === "string"
					? new URL(input)
					: input instanceof URL
						? input
						: new URL(input.url);
			const cursor = url.searchParams.get("cursor");
			if (!cursor) {
				return new Response(
					JSON.stringify({
						records: [{ uri: `at://${DID_A}/${collection}/p1`, cid: "c1", value: {} }],
						cursor: "p2",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response("not found", { status: 404 });
		};

		await expect(
			processBackfillJob({ did: DID_A, collection }, { resolver, queue, fetch: fetchImpl }),
		).rejects.toThrow(/404 mid-pagination/);
	});

	it("rejects pages with > MAX_RECORDS_PER_PAGE records (PDS oversize attack)", async () => {
		const queue = new CapturingRecordsQueue();
		const resolver = buildResolver();
		const collection = WANTED_COLLECTIONS[0];
		if (!collection) throw new Error("test assumes ≥1 collection");
		const records = Array.from({ length: 250 }, (_, i) => ({
			uri: `at://${DID_A}/${collection}/r${i}`,
			cid: `c${i}`,
			value: {},
		}));
		const fetchImpl = makeFetch({ [collection]: records });

		await expect(
			processBackfillJob({ did: DID_A, collection }, { resolver, queue, fetch: fetchImpl }),
		).rejects.toThrow(/per-page cap/);
		expect(queue.sent).toHaveLength(0);
	});

	it("aborts a hung PDS fetch via the listRecords timeout", async () => {
		const queue = new CapturingRecordsQueue();
		const resolver = buildResolver();
		const collection = WANTED_COLLECTIONS[0];
		if (!collection) throw new Error("test assumes ≥1 collection");
		const fetchImpl: typeof fetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject(new DOMException("aborted", "AbortError"));
				});
			});

		await expect(
			processBackfillJob(
				{ did: DID_A, collection },
				{ resolver, queue, fetch: fetchImpl, listRecordsTimeoutMs: 25 },
			),
		).rejects.toThrow(/timed out after 25ms/);
	});

	it("throws when listRecords body isn't a JSON object (no silent zero)", async () => {
		const queue = new CapturingRecordsQueue();
		const resolver = buildResolver();
		const collection = WANTED_COLLECTIONS[0];
		if (!collection) throw new Error("test assumes ≥1 collection");
		const fetchImpl: typeof fetch = async () =>
			new Response(JSON.stringify(["not", "an", "object"]), {
				status: 200,
				headers: { "content-type": "application/json" },
			});

		await expect(
			processBackfillJob({ did: DID_A, collection }, { resolver, queue, fetch: fetchImpl }),
		).rejects.toThrow(/not a JSON object/);
	});

	it("throws when listRecords body is missing the records array", async () => {
		const queue = new CapturingRecordsQueue();
		const resolver = buildResolver();
		const collection = WANTED_COLLECTIONS[0];
		if (!collection) throw new Error("test assumes ≥1 collection");
		const fetchImpl: typeof fetch = async () =>
			new Response(JSON.stringify({ cursor: "x" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});

		await expect(
			processBackfillJob({ did: DID_A, collection }, { resolver, queue, fetch: fetchImpl }),
		).rejects.toThrow(/missing `records` array/);
	});

	it("throws when cursor is present but not a string (no silent end-of-pagination)", async () => {
		const queue = new CapturingRecordsQueue();
		const resolver = buildResolver();
		const collection = WANTED_COLLECTIONS[0];
		if (!collection) throw new Error("test assumes ≥1 collection");
		const fetchImpl: typeof fetch = async () =>
			new Response(JSON.stringify({ records: [], cursor: 42 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});

		await expect(
			processBackfillJob({ did: DID_A, collection }, { resolver, queue, fetch: fetchImpl }),
		).rejects.toThrow(/cursor was not a string/);
	});
});

describe("enqueueBackfillJobs", () => {
	it("emits one job per (DID × WANTED_COLLECTIONS) pair", async () => {
		const queue = new CapturingBackfillQueue();
		const enqueued = await enqueueBackfillJobs([DID_A, DID_B], queue);

		const expected = 2 * WANTED_COLLECTIONS.length;
		expect(enqueued).toBe(expected);
		expect(queue.sent).toHaveLength(expected);

		// Cartesian shape: every DID appears with every collection exactly once.
		for (const did of [DID_A, DID_B]) {
			for (const collection of WANTED_COLLECTIONS) {
				expect(queue.sent.filter((j) => j.did === did && j.collection === collection)).toHaveLength(
					1,
				);
			}
		}
	});

	it("batches sendBatch calls at QUEUE_SEND_BATCH_CAP", async () => {
		const queue = new CapturingBackfillQueue();
		// Pick enough DIDs that the total job count exceeds the cap. With
		// QUEUE_SEND_BATCH_CAP = 100 and 4 collections, 30 DIDs → 120 jobs
		// → batches of [100, 20].
		const dids = Array.from(
			{ length: 30 },
			(_, i) => `did:plc:bulk${i.toString().padStart(20, "0")}`,
		);
		const total = dids.length * WANTED_COLLECTIONS.length;
		const expectedBatches: number[] = [];
		for (let i = 0; i < total; i += QUEUE_SEND_BATCH_CAP) {
			expectedBatches.push(Math.min(QUEUE_SEND_BATCH_CAP, total - i));
		}

		const enqueued = await enqueueBackfillJobs(dids, queue);

		expect(enqueued).toBe(total);
		expect(queue.batches).toEqual(expectedBatches);
		expect(queue.batches.every((n) => n <= QUEUE_SEND_BATCH_CAP)).toBe(true);
	});

	it("emits no batches for an empty DID list", async () => {
		const queue = new CapturingBackfillQueue();
		const enqueued = await enqueueBackfillJobs([], queue);
		expect(enqueued).toBe(0);
		expect(queue.batches).toEqual([]);
		expect(queue.sent).toHaveLength(0);
	});
});

describe("processBackfillBatch (consumer)", () => {
	it("acks each message after a successful per-pair run", async () => {
		const recordsQueue = new CapturingRecordsQueue();
		const resolver = buildResolver();
		const collection = WANTED_COLLECTIONS[0];
		if (!collection) throw new Error("test assumes ≥1 collection");
		const fetchImpl = makeFetch({
			[collection]: [{ uri: `at://${DID_A}/${collection}/r1`, cid: "c", value: {} }],
		});

		const message = new FakeMessage<BackfillJob>({ did: DID_A, collection });
		await processBackfillBatch({ messages: [message] }, {} as Env, {
			resolver,
			queue: recordsQueue,
			fetch: fetchImpl,
		});

		expect(message.acked).toBe(1);
		expect(message.retried).toBe(0);
		expect(recordsQueue.sent).toHaveLength(1);
	});

	it("retries when processBackfillJob throws (transient PDS failure)", async () => {
		const recordsQueue = new CapturingRecordsQueue();
		const resolver = buildResolver();
		const collection = WANTED_COLLECTIONS[0];
		if (!collection) throw new Error("test assumes ≥1 collection");
		const fetchImpl = makeFetch({}, { status: { [collection]: 503 } });

		const message = new FakeMessage<BackfillJob>({ did: DID_A, collection });
		await processBackfillBatch({ messages: [message] }, {} as Env, {
			resolver,
			queue: recordsQueue,
			fetch: fetchImpl,
		});

		expect(message.retried).toBe(1);
		expect(message.acked).toBe(0);
	});

	it("does not let one failed job poison the rest of the batch", async () => {
		const recordsQueue = new CapturingRecordsQueue();
		const resolver = buildResolver();
		const collection = WANTED_COLLECTIONS[0];
		const collection2 = WANTED_COLLECTIONS[1];
		if (!collection || !collection2) throw new Error("test assumes ≥2 collections");
		// First collection 503s; second succeeds with one record.
		const fetchImpl: typeof fetch = async (input) => {
			const url =
				typeof input === "string"
					? new URL(input)
					: input instanceof URL
						? input
						: new URL(input.url);
			const c = url.searchParams.get("collection");
			if (c === collection) return new Response("err", { status: 503 });
			return new Response(
				JSON.stringify({
					records: [{ uri: `at://${DID_A}/${c}/r1`, cid: "c", value: {} }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const failing = new FakeMessage<BackfillJob>({ did: DID_A, collection });
		const succeeding = new FakeMessage<BackfillJob>({ did: DID_A, collection: collection2 });
		await processBackfillBatch({ messages: [failing, succeeding] }, {} as Env, {
			resolver,
			queue: recordsQueue,
			fetch: fetchImpl,
		});

		expect(failing.retried).toBe(1);
		expect(failing.acked).toBe(0);
		expect(succeeding.acked).toBe(1);
		expect(succeeding.retried).toBe(0);
		expect(recordsQueue.sent).toHaveLength(1);
		expect(recordsQueue.sent[0]?.collection).toBe(collection2);
	});
});

describe("drainBackfillDeadLetterBatch", () => {
	it("acks every dead-lettered job (DLQ doesn't accumulate)", () => {
		const collection = WANTED_COLLECTIONS[0];
		if (!collection) throw new Error("test assumes ≥1 collection");
		const messages = [
			new FakeMessage<BackfillJob>({ did: DID_A, collection }),
			new FakeMessage<BackfillJob>({ did: DID_B, collection }),
		];

		drainBackfillDeadLetterBatch({ messages }, {} as Env);

		for (const m of messages) {
			expect(m.acked).toBe(1);
			expect(m.retried).toBe(0);
		}
	});
});

describe("discoverDids: listReposByCollection enumeration", () => {
	const RELAY = "https://relay.test.example";

	function makeRelayFetch(reposByCollection: Record<string, Array<{ did: string }>>): typeof fetch {
		return async (input) => {
			const url =
				typeof input === "string"
					? new URL(input)
					: input instanceof URL
						? input
						: new URL(input.url);
			if (!url.pathname.endsWith("/xrpc/com.atproto.sync.listReposByCollection")) {
				return new Response("not stubbed", { status: 599 });
			}
			const collection = url.searchParams.get("collection") ?? "";
			const repos = reposByCollection[collection] ?? [];
			return new Response(JSON.stringify({ repos }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
	}

	it("returns the union of distinct DIDs across all WANTED_COLLECTIONS", async () => {
		const c0 = WANTED_COLLECTIONS[0];
		const c1 = WANTED_COLLECTIONS[1];
		if (!c0 || !c1) throw new Error("test assumes ≥2 collections");
		const fetchImpl = makeRelayFetch({
			[c0]: [{ did: "did:plc:a" }, { did: "did:plc:b" }],
			[c1]: [{ did: "did:plc:b" }, { did: "did:plc:c" }],
		});

		const dids = await discoverDids(RELAY, { fetch: fetchImpl });

		expect(new Set(dids)).toEqual(new Set(["did:plc:a", "did:plc:b", "did:plc:c"]));
	});

	it("paginates via cursor", async () => {
		const c0 = WANTED_COLLECTIONS[0];
		if (!c0) throw new Error("test assumes ≥1 collection");
		let calls = 0;
		const fetchImpl: typeof fetch = async (input) => {
			const url =
				typeof input === "string"
					? new URL(input)
					: input instanceof URL
						? input
						: new URL(input.url);
			if (url.searchParams.get("collection") !== c0) {
				return new Response(JSON.stringify({ repos: [] }), { status: 200 });
			}
			calls += 1;
			const cursor = url.searchParams.get("cursor");
			if (!cursor) {
				return new Response(JSON.stringify({ repos: [{ did: "did:plc:a" }], cursor: "next" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ repos: [{ did: "did:plc:b" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const dids = await discoverDids(RELAY, { fetch: fetchImpl });

		expect(calls).toBe(2);
		expect(new Set(dids)).toEqual(new Set(["did:plc:a", "did:plc:b"]));
	});

	it("logs and continues when one collection's listReposByCollection fails", async () => {
		const c0 = WANTED_COLLECTIONS[0];
		const c1 = WANTED_COLLECTIONS[1];
		if (!c0 || !c1) throw new Error("test assumes ≥2 collections");
		const fetchImpl: typeof fetch = async (input) => {
			const url =
				typeof input === "string"
					? new URL(input)
					: input instanceof URL
						? input
						: new URL(input.url);
			const collection = url.searchParams.get("collection");
			if (collection === c0) return new Response("relay broken", { status: 503 });
			if (collection === c1) {
				return new Response(JSON.stringify({ repos: [{ did: "did:plc:c1" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ repos: [] }), { status: 200 });
		};

		const dids = await discoverDids(RELAY, { fetch: fetchImpl });

		expect(dids).toContain("did:plc:c1");
	});

	it("aborts a hung relay fetch via the timeout", async () => {
		const fetchImpl: typeof fetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject(new DOMException("aborted", "AbortError"));
				});
			});

		const dids = await discoverDids(RELAY, { fetch: fetchImpl, timeoutMs: 25 });

		// Every collection's discovery throws "timed out"; the function returns
		// an empty set rather than propagating the error.
		expect(dids).toEqual([]);
	});

	it("stops enumerating once MAX_DISCOVERED_DIDS is hit (defense vs runaway relay)", async () => {
		const c0 = WANTED_COLLECTIONS[0];
		if (!c0) throw new Error("test assumes ≥1 collection");
		// Relay returns MAX_DISCOVERED_DIDS+50 repos in one page for the first
		// collection. discoverDids should add exactly MAX_DISCOVERED_DIDS DIDs
		// then stop without paging further or hitting the next collection.
		let pdsCalls = 0;
		const fetchImpl: typeof fetch = async (input) => {
			const url =
				typeof input === "string"
					? new URL(input)
					: input instanceof URL
						? input
						: new URL(input.url);
			pdsCalls += 1;
			const collection = url.searchParams.get("collection");
			if (collection !== c0) {
				// Should never be reached if the cap fires.
				return new Response(JSON.stringify({ repos: [{ did: "did:plc:later" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			const repos = Array.from({ length: MAX_DISCOVERED_DIDS + 50 }, (_, i) => ({
				did: `did:plc:cap${i.toString().padStart(20, "0")}`,
			}));
			return new Response(JSON.stringify({ repos }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const dids = await discoverDids("https://relay.test.example", { fetch: fetchImpl });

		expect(dids).toHaveLength(MAX_DISCOVERED_DIDS);
		expect(dids).not.toContain("did:plc:later");
		// Only the first collection was queried; the cap fired before reaching
		// any subsequent collection.
		expect(pdsCalls).toBe(1);
	});
});

describe("backfill admin route: auth + input validation", () => {
	it("returns 401 when Authorization header is missing", async () => {
		const res = await SELF.fetch("https://test/_admin/backfill", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ dids: [DID_A] }),
		});
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toBe("Bearer");
	});

	it("returns 401 with wrong token", async () => {
		const res = await SELF.fetch("https://test/_admin/backfill", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer wrong-token",
			},
			body: JSON.stringify({ dids: [DID_A] }),
		});
		expect(res.status).toBe(401);
	});

	it("returns 405 on GET", async () => {
		const res = await SELF.fetch("https://test/_admin/backfill", {
			method: "GET",
			headers: { authorization: "Bearer test-admin-token" },
		});
		expect(res.status).toBe(405);
	});

	it("accepts an empty body and triggers discovery (production cold-start path)", async () => {
		const res = await SELF.fetch("https://test/_admin/backfill", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer test-admin-token",
			},
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(202);
	});

	it("accepts a literal empty request body (no JSON) and triggers discovery", async () => {
		const res = await SELF.fetch("https://test/_admin/backfill", {
			method: "POST",
			headers: { authorization: "Bearer test-admin-token" },
		});
		expect(res.status).toBe(202);
	});

	it("returns 400 on a non-array `dids` value (string instead of array)", async () => {
		const res = await SELF.fetch("https://test/_admin/backfill", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer test-admin-token",
			},
			body: JSON.stringify({ dids: "did:plc:foo" }),
		});
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("must be an array");
	});

	it("returns 400 on empty dids array (suggests omitting the field for discovery)", async () => {
		const res = await SELF.fetch("https://test/_admin/backfill", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer test-admin-token",
			},
			body: JSON.stringify({ dids: [] }),
		});
		expect(res.status).toBe(400);
		const text = await res.text();
		expect(text).toContain("not be empty");
		expect(text).toMatch(/discover|omit/i);
	});

	it("returns 400 on dids list larger than the cap", async () => {
		// Cap is currently 100 (lowered from 1000 because the queue-fan-out
		// path amplifies a leaked-token attack). 101 DIDs → over cap.
		const dids = Array.from(
			{ length: 101 },
			(_, i) => `did:plc:test${i.toString().padStart(20, "0")}`,
		);
		const res = await SELF.fetch("https://test/_admin/backfill", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer test-admin-token",
			},
			body: JSON.stringify({ dids }),
		});
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("at most 100");
	});

	it("returns 400 on malformed DID (caught by DID_PATTERN)", async () => {
		const res = await SELF.fetch("https://test/_admin/backfill", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer test-admin-token",
			},
			body: JSON.stringify({ dids: ["did:plc:has space"] }),
		});
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("invalid DID");
	});

	it("returns 202 with a valid token + body (fires backfill in waitUntil)", async () => {
		const res = await SELF.fetch("https://test/_admin/backfill", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer test-admin-token",
			},
			body: JSON.stringify({ dids: [DID_A] }),
		});
		expect(res.status).toBe(202);
	});

	it("dedupes duplicate DIDs in input", async () => {
		// We can't assert the dedup directly through SELF without race-y waits,
		// but the route accepts the body and returns 202 — the dedup is exercised
		// in parseBackfillBody, which is unit-tested via the 'invalid DID' path
		// (a duplicate doesn't surface as an error). Smoke test only.
		const res = await SELF.fetch("https://test/_admin/backfill", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer test-admin-token",
			},
			body: JSON.stringify({ dids: [DID_A, DID_A, DID_A] }),
		});
		expect(res.status).toBe(202);
	});
});

describe("admin auth: scheme + token edge cases", () => {
	it("accepts canonical mixed-case Bearer (regression guard)", async () => {
		const res = await SELF.fetch("https://test/_admin/start", {
			method: "POST",
			headers: { authorization: "Bearer test-admin-token" },
		});
		expect(res.status).toBe(204);
	});

	it("accepts uppercase BEARER scheme (RFC 6750 case-insensitive)", async () => {
		const res = await SELF.fetch("https://test/_admin/start", {
			method: "POST",
			headers: { authorization: "BEARER test-admin-token" },
		});
		expect(res.status).toBe(204);
	});

	it("rejects an Authorization header with a non-Bearer scheme", async () => {
		const res = await SELF.fetch("https://test/_admin/start", {
			method: "POST",
			headers: { authorization: "Basic dGVzdC1hZG1pbi10b2tlbjo=" },
		});
		expect(res.status).toBe(401);
	});

	it("rejects empty token after Bearer prefix", async () => {
		const res = await SELF.fetch("https://test/_admin/start", {
			method: "POST",
			headers: { authorization: "Bearer " },
		});
		expect(res.status).toBe(401);
	});
});

describe("admin start route: auth + method", () => {
	it("returns 405 on GET (POST-only route)", async () => {
		const res = await SELF.fetch("https://test/_admin/start");
		expect(res.status).toBe(405);
		expect(res.headers.get("allow")).toBe("POST");
	});

	it("returns 401 on POST without token", async () => {
		const res = await SELF.fetch("https://test/_admin/start", { method: "POST" });
		expect(res.status).toBe(401);
	});

	it("returns 204 on POST with valid token", async () => {
		const res = await SELF.fetch("https://test/_admin/start", {
			method: "POST",
			headers: { authorization: "Bearer test-admin-token" },
		});
		expect(res.status).toBe(204);
	});

	it("accepts case-insensitive Bearer scheme (RFC 6750 §2.1)", async () => {
		const res = await SELF.fetch("https://test/_admin/start", {
			method: "POST",
			headers: { authorization: "bearer test-admin-token" },
		});
		expect(res.status).toBe(204);
	});
});
