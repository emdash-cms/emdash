/**
 * DidResolver unit tests + the D1 binding's contract test.
 *
 * The class is exercised end-to-end with a real WebCrypto-backed signing key
 * (generated once in `beforeAll`) and a Map-backed cache so cache behaviour is
 * verified independently of D1 wiring. A separate suite runs the D1 binding
 * against the test pool's in-memory D1 and re-runs the cache contract via
 * the same scenarios — that way the contract is the same in tests and in
 * production.
 */

import { P256PrivateKeyExportable } from "@atcute/crypto";
import type { DidDocument } from "@atcute/identity";
import type { Did } from "@atcute/lexicons/syntax";
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
	type CachedDidDoc,
	createD1DidDocCache,
	type DidDocCache,
	type DidDocumentResolverLike,
	DidResolver,
} from "../src/did-resolver.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;

const TEST_DID = "did:plc:test00000000000000000000";
const TEST_PDS = "https://pds.test.example";

let signingKeyMultibase: string;

beforeAll(async () => {
	const kp = await P256PrivateKeyExportable.createKeypair();
	signingKeyMultibase = await kp.exportPublicKey("multikey");
});

class MapDidDocCache implements DidDocCache {
	private readonly entries = new Map<string, CachedDidDoc>();
	readonly reads: string[] = [];
	readonly upserts: Array<{ did: string; doc: Omit<CachedDidDoc, "resolvedAt">; now: Date }> = [];
	readonly expires: string[] = [];

	read(did: string): Promise<CachedDidDoc | null> {
		this.reads.push(did);
		return Promise.resolve(this.entries.get(did) ?? null);
	}
	upsert(did: string, doc: Omit<CachedDidDoc, "resolvedAt">, now: Date): Promise<void> {
		this.upserts.push({ did, doc, now });
		this.entries.set(did, { ...doc, resolvedAt: now });
		return Promise.resolve();
	}
	expire(did: string): Promise<void> {
		this.expires.push(did);
		const entry = this.entries.get(did);
		if (entry) {
			this.entries.set(did, { ...entry, resolvedAt: new Date(0) });
		}
		return Promise.resolve();
	}
}

class StubResolver implements DidDocumentResolverLike {
	readonly calls: Did[] = [];
	private response: DidDocument;
	private error: Error | null = null;

	constructor(response: DidDocument) {
		this.response = response;
	}

	resolve(did: Did): Promise<DidDocument> {
		this.calls.push(did);
		if (this.error) return Promise.reject(this.error);
		return Promise.resolve(this.response);
	}

	setResponse(doc: DidDocument): void {
		this.response = doc;
	}
	setError(err: Error): void {
		this.error = err;
	}
}

function buildDidDoc(overrides: Partial<DidDocument> = {}): DidDocument {
	return {
		id: TEST_DID as `did:${string}:${string}`,
		verificationMethod: [
			{
				id: `${TEST_DID}#atproto`,
				type: "Multikey",
				controller: TEST_DID as `did:${string}:${string}`,
				publicKeyMultibase: signingKeyMultibase,
			},
		],
		service: [
			{
				id: "#atproto_pds",
				type: "AtprotoPersonalDataServer",
				serviceEndpoint: TEST_PDS,
			},
		],
		...overrides,
	};
}

describe("DidResolver", () => {
	describe("with in-memory cache", () => {
		it("resolves on cache miss, writes the row, returns a usable PublicKey", async () => {
			const cache = new MapDidDocCache();
			const resolver = new StubResolver(buildDidDoc());
			const subject = new DidResolver({ cache, resolver, now: () => new Date(1000) });

			const result = await subject.resolve(TEST_DID);

			expect(result.pds).toBe(TEST_PDS);
			expect(result.signingKeyId).toBe(`${TEST_DID}#atproto`);
			expect(typeof result.publicKey.verify).toBe("function");
			expect(resolver.calls).toEqual([TEST_DID]);
			expect(cache.upserts).toHaveLength(1);
			expect(cache.upserts[0]).toMatchObject({
				did: TEST_DID,
				doc: { pds: TEST_PDS, signingKey: signingKeyMultibase },
			});
		});

		it("hits cache on second call within TTL — no resolver call", async () => {
			const cache = new MapDidDocCache();
			const resolver = new StubResolver(buildDidDoc());
			const subject = new DidResolver({
				cache,
				resolver,
				ttlMs: 60_000,
				now: () => new Date(1000),
			});

			await subject.resolve(TEST_DID);
			await subject.resolve(TEST_DID);

			expect(resolver.calls).toHaveLength(1);
			expect(cache.upserts).toHaveLength(1);
		});

		it("re-resolves when cached entry is past TTL", async () => {
			const cache = new MapDidDocCache();
			const resolver = new StubResolver(buildDidDoc());
			let now = 1_000;
			const subject = new DidResolver({
				cache,
				resolver,
				ttlMs: 60_000,
				now: () => new Date(now),
			});

			await subject.resolve(TEST_DID);
			now = 1_000 + 60_001;
			await subject.resolve(TEST_DID);

			expect(resolver.calls).toHaveLength(2);
			expect(cache.upserts).toHaveLength(2);
		});

		it("propagates resolver errors without writing to cache", async () => {
			const cache = new MapDidDocCache();
			const resolver = new StubResolver(buildDidDoc());
			resolver.setError(new Error("plc unreachable"));
			const subject = new DidResolver({ cache, resolver });

			await expect(subject.resolve(TEST_DID)).rejects.toThrow("plc unreachable");
			expect(cache.upserts).toHaveLength(0);
		});

		it("rejects DID documents with no PDS service entry", async () => {
			const cache = new MapDidDocCache();
			const resolver = new StubResolver(buildDidDoc({ service: [] }));
			const subject = new DidResolver({ cache, resolver });

			await expect(subject.resolve(TEST_DID)).rejects.toThrow(/no atproto PDS/i);
		});

		it("rejects DID documents with no #atproto verification method", async () => {
			const cache = new MapDidDocCache();
			const resolver = new StubResolver(buildDidDoc({ verificationMethod: [] }));
			const subject = new DidResolver({ cache, resolver });

			await expect(subject.resolve(TEST_DID)).rejects.toThrow(/#atproto verification method/i);
		});

		it("rejects malformed DIDs without calling the resolver or cache", async () => {
			const cache = new MapDidDocCache();
			const resolver = new StubResolver(buildDidDoc());
			const subject = new DidResolver({ cache, resolver });

			await expect(subject.resolve("not-a-did")).rejects.toThrow(/invalid DID/i);
			expect(resolver.calls).toHaveLength(0);
			expect(cache.reads).toHaveLength(0);
		});

		it("invalidate() forces re-resolution on the next call", async () => {
			const cache = new MapDidDocCache();
			const resolver = new StubResolver(buildDidDoc());
			// Use a real-world `now` so invalidate's "epoch" sentinel falls
			// well outside the TTL window.
			const subject = new DidResolver({
				cache,
				resolver,
				ttlMs: 60_000,
				now: () => new Date("2026-05-09T12:00:00.000Z"),
			});

			await subject.resolve(TEST_DID);
			await subject.invalidate(TEST_DID);
			await subject.resolve(TEST_DID);

			expect(resolver.calls).toHaveLength(2);
		});

		it("invalidate() on an unknown DID is a no-op", async () => {
			const cache = new MapDidDocCache();
			const resolver = new StubResolver(buildDidDoc());
			const subject = new DidResolver({ cache, resolver });

			await expect(subject.invalidate(TEST_DID)).resolves.toBeUndefined();
			expect(cache.upserts).toHaveLength(0);
		});
	});

	describe("createD1DidDocCache", () => {
		beforeAll(async () => {
			await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
		});

		beforeEach(async () => {
			await testEnv.DB.exec("DELETE FROM known_publishers");
		});

		it("returns null when no row exists", async () => {
			const cache = createD1DidDocCache(testEnv.DB);
			expect(await cache.read(TEST_DID)).toBeNull();
		});

		it("returns null when row exists but cache fields are unpopulated", async () => {
			// Backfill or future code may insert a known_publishers row before the
			// consumer has resolved the DID doc; the read should treat that as
			// a cache miss, not a stale cache hit.
			const now = new Date().toISOString();
			await testEnv.DB.prepare(
				`INSERT INTO known_publishers (did, first_seen_at, last_seen_at)
				 VALUES (?, ?, ?)`,
			)
				.bind(TEST_DID, now, now)
				.run();

			const cache = createD1DidDocCache(testEnv.DB);
			expect(await cache.read(TEST_DID)).toBeNull();
		});

		it("upsert + read round-trips a cache entry", async () => {
			const cache = createD1DidDocCache(testEnv.DB);
			const now = new Date("2026-05-09T12:00:00.000Z");
			await cache.upsert(
				TEST_DID,
				{
					pds: TEST_PDS,
					signingKey: signingKeyMultibase,
					signingKeyId: `${TEST_DID}#atproto`,
				},
				now,
			);

			const out = await cache.read(TEST_DID);
			expect(out).not.toBeNull();
			expect(out?.pds).toBe(TEST_PDS);
			expect(out?.signingKey).toBe(signingKeyMultibase);
			expect(out?.signingKeyId).toBe(`${TEST_DID}#atproto`);
			expect(out?.resolvedAt.toISOString()).toBe(now.toISOString());
		});

		it("upsert preserves first_seen_at across updates", async () => {
			const cache = createD1DidDocCache(testEnv.DB);
			const t1 = new Date("2026-05-09T12:00:00.000Z");
			const t2 = new Date("2026-05-10T12:00:00.000Z");

			await cache.upsert(
				TEST_DID,
				{
					pds: TEST_PDS,
					signingKey: signingKeyMultibase,
					signingKeyId: `${TEST_DID}#atproto`,
				},
				t1,
			);
			await cache.upsert(
				TEST_DID,
				{
					pds: TEST_PDS,
					signingKey: signingKeyMultibase,
					signingKeyId: `${TEST_DID}#atproto`,
				},
				t2,
			);

			const row = await testEnv.DB.prepare(
				`SELECT first_seen_at, last_seen_at, pds_resolved_at FROM known_publishers WHERE did = ?`,
			)
				.bind(TEST_DID)
				.first<{ first_seen_at: string; last_seen_at: string; pds_resolved_at: string }>();
			expect(row?.first_seen_at).toBe(t1.toISOString());
			expect(row?.last_seen_at).toBe(t2.toISOString());
			expect(row?.pds_resolved_at).toBe(t2.toISOString());
		});

		it("end-to-end: resolver wired to D1 cache", async () => {
			const cache = createD1DidDocCache(testEnv.DB);
			const resolver = new StubResolver(buildDidDoc());
			const subject = new DidResolver({ cache, resolver });

			await subject.resolve(TEST_DID);
			await subject.resolve(TEST_DID);

			// One resolver call for the cache miss; the second resolve hits D1.
			expect(resolver.calls).toHaveLength(1);
		});

		it("expire only touches pds_resolved_at; preserves first_seen_at and last_seen_at", async () => {
			const cache = createD1DidDocCache(testEnv.DB);
			const seenAt = new Date("2026-05-09T12:00:00.000Z");
			await cache.upsert(
				TEST_DID,
				{
					pds: TEST_PDS,
					signingKey: signingKeyMultibase,
					signingKeyId: `${TEST_DID}#atproto`,
				},
				seenAt,
			);

			await cache.expire(TEST_DID);

			const row = await testEnv.DB.prepare(
				`SELECT first_seen_at, last_seen_at, pds_resolved_at FROM known_publishers WHERE did = ?`,
			)
				.bind(TEST_DID)
				.first<{ first_seen_at: string; last_seen_at: string; pds_resolved_at: string }>();
			expect(row?.first_seen_at).toBe(seenAt.toISOString());
			expect(row?.last_seen_at).toBe(seenAt.toISOString());
			// pds_resolved_at gets pushed to epoch so the next resolve()
			// sees the row as stale per the TTL check.
			expect(row?.pds_resolved_at).toBe("1970-01-01T00:00:00.000Z");
		});

		it("expire on an unknown DID is a no-op (no row appears)", async () => {
			const cache = createD1DidDocCache(testEnv.DB);
			await cache.expire(TEST_DID);
			const row = await testEnv.DB.prepare(`SELECT did FROM known_publishers WHERE did = ?`)
				.bind(TEST_DID)
				.first();
			expect(row).toBeNull();
		});
	});
});
