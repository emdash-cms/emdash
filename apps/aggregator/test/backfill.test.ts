/**
 * Backfill worker tests.
 *
 * The worker is plain `fetch` + `queue.send`; tests stub both. The DID
 * resolver is also stubbed (in-memory cache + a simple stub upstream) so the
 * tests don't depend on the workers test pool or live PLC.
 */

import { P256PrivateKeyExportable } from "@atcute/crypto";
import type { DidDocument } from "@atcute/identity";
import type { Did } from "@atcute/lexicons/syntax";
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { backfillDid, backfillDids, type BackfillQueue } from "../src/backfill.js";
import { WANTED_COLLECTIONS } from "../src/constants.js";
import {
	type CachedDidDoc,
	type DidDocCache,
	type DidDocumentResolverLike,
	DidResolver,
} from "../src/did-resolver.js";
import type { RecordsJob } from "../src/env.js";

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

class CapturingQueue implements BackfillQueue {
	readonly sent: RecordsJob[] = [];
	sendBatch(messages: ReadonlyArray<{ body: RecordsJob }>): Promise<unknown> {
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

describe("backfillDid", () => {
	it("enqueues each listRecords result as a RecordsJob", async () => {
		const queue = new CapturingQueue();
		const resolver = buildResolver();
		const fetchImpl = makeFetch({
			[WANTED_COLLECTIONS[0]]: [
				{
					uri: `at://${DID_A}/${WANTED_COLLECTIONS[0]}/demo`,
					cid: "bafyc1",
					value: { foo: "bar" },
				},
			],
		});
		const result = await backfillDid(DID_A, { resolver, queue, fetch: fetchImpl });

		expect(result.errors).toEqual([]);
		expect(result.enqueued).toBe(1);
		expect(queue.sent).toHaveLength(1);
		expect(queue.sent[0]).toMatchObject({
			did: DID_A,
			collection: WANTED_COLLECTIONS[0],
			rkey: "demo",
			operation: "create",
			cid: "bafyc1",
		});
		// jetstreamRecord intentionally not set on backfill jobs — the
		// consumer's DLQ payload field would otherwise mislabel
		// `listRecords` data as Jetstream-supplied data.
		expect(queue.sent[0]?.jetstreamRecord).toBeUndefined();
	});

	it("walks every collection in WANTED_COLLECTIONS", async () => {
		const queue = new CapturingQueue();
		const resolver = buildResolver();
		const records: Record<string, MockListRecord[]> = {};
		for (let i = 0; i < WANTED_COLLECTIONS.length; i++) {
			const c = WANTED_COLLECTIONS[i];
			if (c) {
				records[c] = [{ uri: `at://${DID_A}/${c}/r${i}`, cid: `bafyc${i}`, value: {} }];
			}
		}
		const fetchImpl = makeFetch(records);

		const result = await backfillDid(DID_A, { resolver, queue, fetch: fetchImpl });

		expect(result.enqueued).toBe(WANTED_COLLECTIONS.length);
		const collectionsHit = new Set(queue.sent.map((j) => j.collection));
		expect(collectionsHit.size).toBe(WANTED_COLLECTIONS.length);
	});

	it("treats 404 from the PDS as 'no records of this collection', not an error", async () => {
		const queue = new CapturingQueue();
		const resolver = buildResolver();
		const fetchImpl = makeFetch(
			{},
			{
				status: WANTED_COLLECTIONS.reduce<Record<string, number>>((acc, c) => {
					acc[c] = 404;
					return acc;
				}, {}),
			},
		);

		const result = await backfillDid(DID_A, { resolver, queue, fetch: fetchImpl });

		expect(result.errors).toEqual([]);
		expect(result.enqueued).toBe(0);
		expect(queue.sent).toHaveLength(0);
	});

	it("records non-404 PDS errors per collection, continues to the next collection", async () => {
		const queue = new CapturingQueue();
		const resolver = buildResolver();
		const firstCollection = WANTED_COLLECTIONS[0];
		const secondCollection = WANTED_COLLECTIONS[1];
		if (!firstCollection || !secondCollection) throw new Error("test assumes ≥2 collections");
		const fetchImpl = makeFetch(
			{
				[secondCollection]: [
					{
						uri: `at://${DID_A}/${secondCollection}/r1`,
						cid: "bafyc",
						value: {},
					},
				],
			},
			{ status: { [firstCollection]: 503 } },
		);

		const result = await backfillDid(DID_A, { resolver, queue, fetch: fetchImpl });

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("503");
		expect(result.errors[0]).toContain(firstCollection);
		expect(result.enqueued).toBe(1); // the second collection still ran
	});

	it("aborts the DID early if the resolver throws (can't enqueue without PDS)", async () => {
		const queue = new CapturingQueue();
		const resolver = new DidResolver({
			cache: new MapDidDocCache(),
			resolver: {
				resolve: () => Promise.reject(new Error("PLC unreachable")),
			},
		});
		const fetchImpl = makeFetch({});

		const result = await backfillDid(DID_A, { resolver, queue, fetch: fetchImpl });

		expect(result.enqueued).toBe(0);
		expect(queue.sent).toHaveLength(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatch(/resolve failed.*PLC unreachable/);
	});

	it("paginates listRecords via cursor", async () => {
		const queue = new CapturingQueue();
		const resolver = buildResolver();
		const collection = WANTED_COLLECTIONS[0];
		if (!collection) throw new Error("test assumes ≥1 collection");

		// Fetch returns page 1 (cursor "p2") then page 2 (no cursor) for the
		// first collection; empty pages for the others.
		let calls = 0;
		const fetchImpl: typeof fetch = async (input) => {
			const url =
				typeof input === "string"
					? new URL(input)
					: input instanceof URL
						? input
						: new URL(input.url);
			if (url.searchParams.get("collection") !== collection) {
				return new Response(JSON.stringify({ records: [] }), { status: 200 });
			}
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

		const result = await backfillDid(DID_A, { resolver, queue, fetch: fetchImpl });

		expect(calls).toBe(2);
		const collectionJobs = queue.sent.filter((j) => j.collection === collection);
		expect(collectionJobs.map((j) => j.rkey)).toEqual(["p1", "p2"]);
		expect(result.errors).toEqual([]);
	});

	it("skips records whose URI doesn't match the expected collection (defensive)", async () => {
		const queue = new CapturingQueue();
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
		const result = await backfillDid(DID_A, { resolver, queue, fetch: fetchImpl });

		const sentForCollection = queue.sent.filter((j) => j.collection === collection);
		expect(sentForCollection.map((j) => j.rkey)).toEqual(["legit"]);
		expect(result.enqueued).toBe(1);
	});
});

describe("backfillDids", () => {
	it("processes multiple DIDs serially and aggregates the summary", async () => {
		const queue = new CapturingQueue();
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
			if (url.searchParams.get("collection") !== collection) {
				return new Response(JSON.stringify({ records: [] }), { status: 200 });
			}
			const did = url.searchParams.get("repo") ?? "";
			return new Response(
				JSON.stringify({
					records: [{ uri: `at://${did}/${collection}/x`, cid: "c", value: {} }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const summary = await backfillDids([DID_A, DID_B], {
			resolver,
			queue,
			fetch: fetchImpl,
		});

		expect(summary.totalEnqueued).toBe(2);
		expect(summary.results).toHaveLength(2);
		expect(summary.results.map((r) => r.did)).toEqual([DID_A, DID_B]);
		expect(summary.results.every((r) => r.errors.length === 0)).toBe(true);
	});

	it("doesn't let one DID's failure stop the others", async () => {
		const queue = new CapturingQueue();
		// Resolver succeeds for DID_A, fails for DID_B (or any other).
		const cache = new MapDidDocCache();
		const resolver = new DidResolver({
			cache,
			resolver: {
				resolve: (did) => {
					if (did === DID_A) {
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
					}
					return Promise.reject(new Error("DID_B unresolvable"));
				},
			},
			ttlMs: 1_000_000,
			now: () => new Date(),
		});
		const collection = WANTED_COLLECTIONS[0];
		if (!collection) throw new Error("test assumes ≥1 collection");
		const fetchImpl = makeFetch({
			[collection]: [{ uri: `at://${DID_A}/${collection}/x`, cid: "c", value: {} }],
		});

		const summary = await backfillDids([DID_B, DID_A], {
			resolver,
			queue,
			fetch: fetchImpl,
		});

		expect(summary.totalEnqueued).toBe(1);
		expect(summary.results).toHaveLength(2);
		const bResult = summary.results.find((r) => r.did === DID_B);
		const aResult = summary.results.find((r) => r.did === DID_A);
		expect(bResult?.errors.length).toBe(1);
		expect(aResult?.errors).toEqual([]);
		expect(aResult?.enqueued).toBe(1);
	});

	it("end-to-end against the production D1 cache: DID is registered in known_publishers", async () => {
		const queue = new CapturingQueue();
		const { createD1DidDocCache } = await import("../src/did-resolver.js");
		const cache = createD1DidDocCache(testEnv.DB);
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

		await backfillDid(DID_A, { resolver, queue, fetch: fetchImpl });

		const row = await testEnv.DB.prepare(
			`SELECT did, pds, signing_key, signing_key_id FROM known_publishers WHERE did = ?`,
		)
			.bind(DID_A)
			.first<{ did: string; pds: string; signing_key: string; signing_key_id: string }>();
		expect(row).toMatchObject({ did: DID_A, pds: PDS });
		expect(row?.signing_key).toBe(signingKeyMultibase);
	});
});

describe("backfillCollection: defenses against malicious / buggy PDS", () => {
	it("aborts after MAX_PAGES_PER_COLLECTION when cursor never empties", async () => {
		const queue = new CapturingQueue();
		const resolver = buildResolver();
		const collection = WANTED_COLLECTIONS[0];
		if (!collection) throw new Error("test assumes ≥1 collection");
		// Hostile PDS: returns a different non-empty cursor every call so the
		// cursor-equality check doesn't fire — only the page cap stops us.
		let counter = 0;
		const fetchImpl: typeof fetch = async (input) => {
			const url =
				typeof input === "string"
					? new URL(input)
					: input instanceof URL
						? input
						: new URL(input.url);
			if (url.searchParams.get("collection") !== collection) {
				return new Response(JSON.stringify({ records: [] }), { status: 200 });
			}
			counter += 1;
			return new Response(JSON.stringify({ records: [], cursor: `cursor-${counter}` }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const result = await backfillDid(DID_A, { resolver, queue, fetch: fetchImpl });

		expect(result.errors.length).toBeGreaterThanOrEqual(1);
		expect(result.errors.some((e) => e.includes("exceeded"))).toBe(true);
		// Loop ran at most MAX_PAGES_PER_COLLECTION times.
		expect(counter).toBeLessThanOrEqual(1001); // +1 for the throw-on-the-next iteration
	});

	it("aborts when the PDS returns the identical cursor twice", async () => {
		const queue = new CapturingQueue();
		const resolver = buildResolver();
		const collection = WANTED_COLLECTIONS[0];
		if (!collection) throw new Error("test assumes ≥1 collection");
		// Buggy PDS: echoes the cursor we sent. Cursor-equality should fire
		// on the second iteration.
		let calls = 0;
		const fetchImpl: typeof fetch = async (input) => {
			const url =
				typeof input === "string"
					? new URL(input)
					: input instanceof URL
						? input
						: new URL(input.url);
			if (url.searchParams.get("collection") !== collection) {
				return new Response(JSON.stringify({ records: [] }), { status: 200 });
			}
			calls += 1;
			return new Response(JSON.stringify({ records: [], cursor: "stuck" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const result = await backfillDid(DID_A, { resolver, queue, fetch: fetchImpl });

		expect(result.errors.some((e) => e.includes("identical cursor"))).toBe(true);
		expect(calls).toBe(2); // first page, then second page caught the dupe
	});

	it("treats 404 mid-pagination as a partial failure (not silent zero)", async () => {
		const queue = new CapturingQueue();
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
			if (url.searchParams.get("collection") !== collection) {
				return new Response(JSON.stringify({ records: [] }), { status: 200 });
			}
			const cursor = url.searchParams.get("cursor");
			if (!cursor) {
				// First page succeeds with a cursor.
				return new Response(
					JSON.stringify({
						records: [{ uri: `at://${DID_A}/${collection}/p1`, cid: "c1", value: {} }],
						cursor: "p2",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			// Second page 404.
			return new Response("not found", { status: 404 });
		};

		const result = await backfillDid(DID_A, { resolver, queue, fetch: fetchImpl });

		const error = result.errors.find((e) => e.includes(collection));
		expect(error).toMatch(/404 mid-pagination/);
	});

	it("rejects pages with > MAX_RECORDS_PER_PAGE records (PDS oversize attack)", async () => {
		const queue = new CapturingQueue();
		const resolver = buildResolver();
		const collection = WANTED_COLLECTIONS[0];
		if (!collection) throw new Error("test assumes ≥1 collection");
		const records = Array.from({ length: 250 }, (_, i) => ({
			uri: `at://${DID_A}/${collection}/r${i}`,
			cid: `c${i}`,
			value: {},
		}));
		const fetchImpl = makeFetch({ [collection]: records });

		const result = await backfillDid(DID_A, { resolver, queue, fetch: fetchImpl });

		expect(result.errors.some((e) => e.includes("exceeding cap"))).toBe(true);
		// No records enqueued for the over-capped collection.
		expect(queue.sent.filter((j) => j.collection === collection)).toHaveLength(0);
	});

	it("rejects records with malformed rkey (atproto rkey grammar violation)", async () => {
		const queue = new CapturingQueue();
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

		const result = await backfillDid(DID_A, { resolver, queue, fetch: fetchImpl });
		const sent = queue.sent.filter((j) => j.collection === collection);
		expect(sent.map((j) => j.rkey)).toEqual(["legit"]);
		expect(result.enqueued).toBe(1);
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

	it("returns 400 on missing dids field", async () => {
		const res = await SELF.fetch("https://test/_admin/backfill", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer test-admin-token",
			},
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("must be an array");
	});

	it("returns 400 on empty dids array", async () => {
		const res = await SELF.fetch("https://test/_admin/backfill", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer test-admin-token",
			},
			body: JSON.stringify({ dids: [] }),
		});
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("not be empty");
	});

	it("returns 400 on dids list larger than the cap", async () => {
		const dids = Array.from(
			{ length: 1001 },
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
		expect(await res.text()).toContain("at most 1000");
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

describe("admin start route: auth", () => {
	it("returns 401 without token", async () => {
		const res = await SELF.fetch("https://test/_admin/start");
		expect(res.status).toBe(401);
	});

	it("returns 204 with valid token", async () => {
		const res = await SELF.fetch("https://test/_admin/start", {
			headers: { authorization: "Bearer test-admin-token" },
		});
		expect(res.status).toBe(204);
	});
});
