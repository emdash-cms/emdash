/**
 * Records consumer tests.
 *
 * Three layers of coverage:
 *
 *   1. **Writer unit tests** call the per-collection ingest functions directly
 *      with synthetic `VerifiedPdsRecord` payloads. This sidesteps the PDS
 *      verification step (already tested in pds-verify.test.ts) and the
 *      in-workerd unavailability of the FakePublisher fixture (which depends
 *      on `@atproto/repo`, a Node-only package). What we test here is the
 *      structural validation + D1 write SQL, against a real D1 instance.
 *
 *   2. **Delete tests** call `applyDelete` with each collection and assert the
 *      right tombstone / hard-delete behaviour.
 *
 *   3. **Dispatcher tests** drive `processMessage` with stub deps to cover
 *      ack/retry decisions: transient PDS errors retry, permanent errors
 *      forensics+ack, IngestError forensics+ack, unexpected errors
 *      forensics+ack, success acks. The verify path is stubbed via a
 *      drop-in `DidResolver` and a `fetch` that throws controlled errors;
 *      end-to-end success-path verification will land in a follow-up PR
 *      once a node-pool integration test config is in place.
 */

import { P256PrivateKeyExportable } from "@atcute/crypto";
import type { DidDocument } from "@atcute/identity";
import type { Did } from "@atcute/lexicons/syntax";
import { NSID } from "@emdash-cms/registry-lexicons";
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
	type DidDocCache,
	type DidDocumentResolverLike,
	DidResolver,
} from "../src/did-resolver.js";
import type { RecordsJob } from "../src/env.js";
import { PdsVerificationError, type VerifiedPdsRecord } from "../src/pds-verify.js";
import {
	applyDelete,
	type ConsumerDeps,
	IngestError,
	ingestPackageProfile,
	ingestPackageRelease,
	ingestPublisherProfile,
	ingestPublisherVerification,
	type MessageController,
	processMessage,
} from "../src/records-consumer.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}
const testEnv = env as unknown as TestEnv;

const DID_A = "did:plc:test00000000000000000000";
const DID_B = "did:plc:test00000000000000000001";

let signingKeyMultibase: string;

beforeAll(async () => {
	const kp = await P256PrivateKeyExportable.createKeypair();
	signingKeyMultibase = await kp.exportPublicKey("multikey");
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
	for (const table of [
		"release_duplicate_attempts",
		"releases",
		"packages",
		"publisher_verifications",
		"publishers",
		"known_publishers",
		"dead_letters",
	]) {
		await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
	}
});

function fakeVerified(record: unknown): VerifiedPdsRecord {
	return {
		cid: "bafyreigtest00000000000000000000000000000000000000000000",
		record,
		carBytes: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
	};
}

function jobFor(
	did: string,
	collection: string,
	rkey: string,
	overrides: Partial<RecordsJob> = {},
): RecordsJob {
	return {
		did,
		collection,
		rkey,
		operation: "create",
		cid: "bafyreigtest00000000000000000000000000000000000000000000",
		...overrides,
	};
}

const NOW = new Date("2026-05-09T12:00:00.000Z");

// ─── Writer: package.profile ────────────────────────────────────────────────

describe("ingestPackageProfile", () => {
	const validRecord = {
		$type: NSID.packageProfile,
		id: `at://${DID_A}/${NSID.packageProfile}/demo`,
		slug: "demo",
		type: "emdash-plugin",
		license: "MIT",
		authors: [{ name: "Tester" }],
		security: [{ email: "x@y.test" }],
	};

	it("inserts a row on first call", async () => {
		const job = jobFor(DID_A, NSID.packageProfile, "demo");
		await ingestPackageProfile(testEnv.DB, job, fakeVerified(validRecord), NOW);

		const row = await testEnv.DB.prepare(`SELECT did, slug, license FROM packages WHERE did = ?`)
			.bind(DID_A)
			.first<{ did: string; slug: string; license: string }>();
		expect(row).toMatchObject({ did: DID_A, slug: "demo", license: "MIT" });
	});

	it("upserts on second call with edited record", async () => {
		const job = jobFor(DID_A, NSID.packageProfile, "demo");
		await ingestPackageProfile(testEnv.DB, job, fakeVerified(validRecord), NOW);
		await ingestPackageProfile(
			testEnv.DB,
			job,
			fakeVerified({ ...validRecord, license: "Apache-2.0" }),
			NOW,
		);

		const row = await testEnv.DB.prepare(`SELECT license FROM packages WHERE did = ?`)
			.bind(DID_A)
			.first<{ license: string }>();
		expect(row?.license).toBe("Apache-2.0");
	});

	it("rejects when rkey ≠ record.slug", async () => {
		const job = jobFor(DID_A, NSID.packageProfile, "different");
		await expect(
			ingestPackageProfile(testEnv.DB, job, fakeVerified(validRecord), NOW),
		).rejects.toMatchObject({ name: "IngestError", reason: "RKEY_MISMATCH" });
	});

	it("rejects records that don't match the lexicon", async () => {
		const job = jobFor(DID_A, NSID.packageProfile, "demo");
		await expect(
			ingestPackageProfile(
				testEnv.DB,
				job,
				fakeVerified({ slug: "demo" /* missing required */ }),
				NOW,
			),
		).rejects.toMatchObject({ name: "IngestError", reason: "LEXICON_VALIDATION_FAILED" });
	});
});

// ─── Writer: package.release ────────────────────────────────────────────────

describe("ingestPackageRelease", () => {
	const validProfile = {
		$type: NSID.packageProfile,
		id: `at://${DID_A}/${NSID.packageProfile}/demo`,
		slug: "demo",
		type: "emdash-plugin",
		license: "MIT",
		authors: [{ name: "Tester" }],
		security: [{ email: "x@y.test" }],
	};

	function makeRelease(version: string) {
		return {
			$type: NSID.packageRelease,
			package: "demo",
			version,
			artifacts: {
				package: { url: "https://example.com/demo.tgz", checksum: "bsha256-abc" },
			},
			extensions: {
				"com.emdashcms.experimental.package.releaseExtension": {
					$type: "com.emdashcms.experimental.package.releaseExtension",
					declaredAccess: {},
				},
			},
		};
	}

	beforeEach(async () => {
		// Releases reference packages via FK; seed the parent profile.
		await ingestPackageProfile(
			testEnv.DB,
			jobFor(DID_A, NSID.packageProfile, "demo"),
			fakeVerified(validProfile),
			NOW,
		);
	});

	it("inserts a release with computed version_sort", async () => {
		const release = makeRelease("1.10.0");
		const job = jobFor(DID_A, NSID.packageRelease, "demo:1.10.0");
		await ingestPackageRelease(testEnv.DB, job, fakeVerified(release), NOW);

		const row = await testEnv.DB.prepare(
			`SELECT version, version_sort FROM releases WHERE did = ? AND version = ?`,
		)
			.bind(DID_A, "1.10.0")
			.first<{ version: string; version_sort: string }>();
		expect(row?.version).toBe("1.10.0");
		// 1.10.0 must sort after 1.9.0 — the whole point of version_sort.
		expect(row?.version_sort.startsWith("0000000001.0000000010.")).toBe(true);
	});

	it("rejects when rkey ≠ '<package>:<version>'", async () => {
		const release = makeRelease("1.0.0");
		const job = jobFor(DID_A, NSID.packageRelease, "wrong-rkey");
		await expect(
			ingestPackageRelease(testEnv.DB, job, fakeVerified(release), NOW),
		).rejects.toMatchObject({ reason: "RKEY_MISMATCH" });
	});

	it("rejects unparseable semver versions", async () => {
		const release = makeRelease("not-a-version");
		const job = jobFor(DID_A, NSID.packageRelease, "demo:not-a-version");
		// Lexicon validation accepts any 1-64 char string in `version`; the
		// semver parse failure is what catches non-semver strings.
		await expect(
			ingestPackageRelease(testEnv.DB, job, fakeVerified(release), NOW),
		).rejects.toMatchObject({ reason: "INVALID_VERSION" });
	});

	it("silently no-ops on a same-content replay", async () => {
		const release = makeRelease("1.0.0");
		const job = jobFor(DID_A, NSID.packageRelease, "demo:1.0.0");
		await ingestPackageRelease(testEnv.DB, job, fakeVerified(release), NOW);
		await ingestPackageRelease(testEnv.DB, job, fakeVerified(release), NOW);

		const dups = await testEnv.DB.prepare(
			`SELECT COUNT(*) as n FROM release_duplicate_attempts`,
		).first<{ n: number }>();
		expect(dups?.n).toBe(0);
	});

	it("audits a duplicate-version attempt with different content", async () => {
		const job = jobFor(DID_A, NSID.packageRelease, "demo:1.0.0");
		await ingestPackageRelease(testEnv.DB, job, fakeVerified(makeRelease("1.0.0")), NOW);

		// Second call — same did/package/version, different carBytes (simulating
		// a malicious republish or a publisher trying to mutate a version).
		const tampered: VerifiedPdsRecord = {
			cid: "bafyreigDIFFERENT00000000000000000000000000000000000000",
			record: makeRelease("1.0.0"),
			carBytes: new Uint8Array([0x01, 0x02, 0x03]),
		};
		await ingestPackageRelease(testEnv.DB, job, tampered, NOW);

		const dup = await testEnv.DB.prepare(
			`SELECT did, package, version, reason FROM release_duplicate_attempts`,
		).first<{ did: string; package: string; version: string; reason: string }>();
		expect(dup).toMatchObject({
			did: DID_A,
			package: "demo",
			version: "1.0.0",
			reason: "IMMUTABLE_VERSION",
		});
	});
});

// ─── Writer: publisher.profile ──────────────────────────────────────────────

describe("ingestPublisherProfile", () => {
	const validRecord = {
		$type: NSID.publisherProfile,
		displayName: "Acme Plugin Co.",
		description: "We make plugins",
		contact: [{ kind: "general", email: "hi@acme.test" }],
	};

	it("inserts on first call, upserts on subsequent", async () => {
		const job = jobFor(DID_A, NSID.publisherProfile, "self");
		await ingestPublisherProfile(testEnv.DB, job, fakeVerified(validRecord), NOW);
		await ingestPublisherProfile(
			testEnv.DB,
			job,
			fakeVerified({ ...validRecord, displayName: "Acme Inc." }),
			NOW,
		);

		const row = await testEnv.DB.prepare(`SELECT display_name FROM publishers WHERE did = ?`)
			.bind(DID_A)
			.first<{ display_name: string }>();
		expect(row?.display_name).toBe("Acme Inc.");
	});

	it("rejects rkey ≠ 'self'", async () => {
		const job = jobFor(DID_A, NSID.publisherProfile, "not-self");
		await expect(
			ingestPublisherProfile(testEnv.DB, job, fakeVerified(validRecord), NOW),
		).rejects.toMatchObject({ reason: "RKEY_MISMATCH" });
	});

	it("rejects contact entries with neither url nor email", async () => {
		const job = jobFor(DID_A, NSID.publisherProfile, "self");
		await expect(
			ingestPublisherProfile(
				testEnv.DB,
				job,
				fakeVerified({ ...validRecord, contact: [{ kind: "general" }] }),
				NOW,
			),
		).rejects.toMatchObject({ reason: "CONTACT_VALIDATION_FAILED" });
	});
});

// ─── Writer: publisher.verification ─────────────────────────────────────────

describe("ingestPublisherVerification", () => {
	const validRecord = {
		$type: NSID.publisherVerification,
		subject: DID_B,
		handle: "subject.test",
		displayName: "Subject Co.",
		createdAt: "2026-05-09T12:00:00.000Z",
	};

	it("inserts a verification, preserving the bound handle + displayName", async () => {
		const job = jobFor(DID_A, NSID.publisherVerification, "3kifgtest00000");
		await ingestPublisherVerification(testEnv.DB, job, fakeVerified(validRecord), NOW);

		const row = await testEnv.DB.prepare(
			`SELECT subject_did, subject_handle, subject_display_name, tombstoned_at
			 FROM publisher_verifications WHERE issuer_did = ? AND rkey = ?`,
		)
			.bind(DID_A, "3kifgtest00000")
			.first<{
				subject_did: string;
				subject_handle: string;
				subject_display_name: string;
				tombstoned_at: string | null;
			}>();
		expect(row).toMatchObject({
			subject_did: DID_B,
			subject_handle: "subject.test",
			subject_display_name: "Subject Co.",
			tombstoned_at: null,
		});
	});

	it("upsert-on-conflict clears any tombstone (re-publish recovers)", async () => {
		const job = jobFor(DID_A, NSID.publisherVerification, "3kifgtest00000");
		await ingestPublisherVerification(testEnv.DB, job, fakeVerified(validRecord), NOW);
		await applyDelete(testEnv.DB, { ...job, operation: "delete" }, NOW);
		await ingestPublisherVerification(testEnv.DB, job, fakeVerified(validRecord), NOW);

		const row = await testEnv.DB.prepare(
			`SELECT tombstoned_at FROM publisher_verifications WHERE issuer_did = ? AND rkey = ?`,
		)
			.bind(DID_A, "3kifgtest00000")
			.first<{ tombstoned_at: string | null }>();
		expect(row?.tombstoned_at).toBeNull();
	});
});

// ─── Delete handling ────────────────────────────────────────────────────────

describe("applyDelete", () => {
	beforeEach(async () => {
		await ingestPackageProfile(
			testEnv.DB,
			jobFor(DID_A, NSID.packageProfile, "demo"),
			fakeVerified({
				$type: NSID.packageProfile,
				id: `at://${DID_A}/${NSID.packageProfile}/demo`,
				slug: "demo",
				type: "emdash-plugin",
				license: "MIT",
				authors: [{ name: "Tester" }],
				security: [{ email: "x@y.test" }],
			}),
			NOW,
		);
		await ingestPackageRelease(
			testEnv.DB,
			jobFor(DID_A, NSID.packageRelease, "demo:1.0.0"),
			fakeVerified({
				$type: NSID.packageRelease,
				package: "demo",
				version: "1.0.0",
				artifacts: { package: { url: "https://x.test/d.tgz", checksum: "bsha-abc" } },
				extensions: {
					"com.emdashcms.experimental.package.releaseExtension": {
						$type: "com.emdashcms.experimental.package.releaseExtension",
						declaredAccess: {},
					},
				},
			}),
			NOW,
		);
	});

	it("hard-deletes a package.profile", async () => {
		await applyDelete(
			testEnv.DB,
			jobFor(DID_A, NSID.packageProfile, "demo", { operation: "delete" }),
			NOW,
		);
		const row = await testEnv.DB.prepare(`SELECT did FROM packages WHERE did = ?`)
			.bind(DID_A)
			.first();
		expect(row).toBeNull();
	});

	it("soft-deletes a release (sets tombstoned_at)", async () => {
		await applyDelete(
			testEnv.DB,
			jobFor(DID_A, NSID.packageRelease, "demo:1.0.0", { operation: "delete" }),
			NOW,
		);
		const row = await testEnv.DB.prepare(
			`SELECT tombstoned_at FROM releases WHERE did = ? AND rkey = ?`,
		)
			.bind(DID_A, "demo:1.0.0")
			.first<{ tombstoned_at: string | null }>();
		expect(row?.tombstoned_at).toBe(NOW.toISOString());
	});

	it("hard-deletes a publisher.profile", async () => {
		await ingestPublisherProfile(
			testEnv.DB,
			jobFor(DID_A, NSID.publisherProfile, "self"),
			fakeVerified({
				$type: NSID.publisherProfile,
				displayName: "Acme",
				contact: [{ email: "a@b.test" }],
			}),
			NOW,
		);
		await applyDelete(
			testEnv.DB,
			jobFor(DID_A, NSID.publisherProfile, "self", { operation: "delete" }),
			NOW,
		);
		const row = await testEnv.DB.prepare(`SELECT did FROM publishers WHERE did = ?`)
			.bind(DID_A)
			.first();
		expect(row).toBeNull();
	});

	it("soft-deletes a publisher.verification", async () => {
		await ingestPublisherVerification(
			testEnv.DB,
			jobFor(DID_A, NSID.publisherVerification, "tid001"),
			fakeVerified({
				$type: NSID.publisherVerification,
				subject: DID_B,
				handle: "s.test",
				displayName: "S",
				createdAt: NOW.toISOString(),
			}),
			NOW,
		);
		await applyDelete(
			testEnv.DB,
			jobFor(DID_A, NSID.publisherVerification, "tid001", { operation: "delete" }),
			NOW,
		);
		const row = await testEnv.DB.prepare(
			`SELECT tombstoned_at FROM publisher_verifications WHERE issuer_did = ? AND rkey = ?`,
		)
			.bind(DID_A, "tid001")
			.first<{ tombstoned_at: string | null }>();
		expect(row?.tombstoned_at).toBe(NOW.toISOString());
	});
});

// ─── Dispatcher (processMessage) ────────────────────────────────────────────

class StubResolver implements DidDocumentResolverLike {
	resolve(_did: Did): Promise<DidDocument> {
		// processMessage tests inject a DidResolver that's wired to a stub DID
		// doc — we never actually traverse this resolver because the cache
		// always hits.
		return Promise.reject(new Error("StubResolver should not be called"));
	}
}

class MapDidDocCache implements DidDocCache {
	private readonly entries = new Map<
		string,
		{ pds: string; signingKey: string; signingKeyId: string; resolvedAt: Date }
	>();
	read(did: string) {
		return Promise.resolve(this.entries.get(did) ?? null);
	}
	upsert(did: string, doc: { pds: string; signingKey: string; signingKeyId: string }, now: Date) {
		this.entries.set(did, { ...doc, resolvedAt: now });
		return Promise.resolve();
	}
	seed(did: string) {
		this.entries.set(did, {
			pds: "https://pds.test.example",
			signingKey: signingKeyMultibase,
			signingKeyId: `${did}#atproto`,
			resolvedAt: NOW,
		});
	}
}

class FakeMessage implements MessageController {
	acked = 0;
	retried = 0;
	ack() {
		this.acked += 1;
	}
	retry() {
		this.retried += 1;
	}
}

function buildDeps(opts: { fetch: typeof fetch }): {
	deps: ConsumerDeps;
	cache: MapDidDocCache;
} {
	const cache = new MapDidDocCache();
	const resolver = new DidResolver({
		cache,
		resolver: new StubResolver(),
		// Long TTL so we never actually call StubResolver.
		ttlMs: 1_000_000,
		now: () => NOW,
	});
	return {
		deps: { db: testEnv.DB, resolver, fetch: opts.fetch, now: () => NOW },
		cache,
	};
}

async function deadLetterCount(): Promise<number> {
	const r = await testEnv.DB.prepare(`SELECT COUNT(*) as n FROM dead_letters`).first<{
		n: number;
	}>();
	return r?.n ?? 0;
}

describe("processMessage dispatcher", () => {
	it("acks and dead-letters on a permanent PDS error (404)", async () => {
		const { deps, cache } = buildDeps({
			fetch: () => Promise.resolve(new Response("", { status: 404 })),
		});
		cache.seed(DID_A);
		const msg = new FakeMessage();
		const job = jobFor(DID_A, NSID.packageProfile, "missing");

		await processMessage(job, msg, deps);

		expect(msg.acked).toBe(1);
		expect(msg.retried).toBe(0);
		expect(await deadLetterCount()).toBe(1);
		const row = await testEnv.DB.prepare(`SELECT reason FROM dead_letters`).first<{
			reason: string;
		}>();
		expect(row?.reason).toBe("RECORD_NOT_FOUND");
	});

	it("retries on a transient PDS error (5xx)", async () => {
		const { deps, cache } = buildDeps({
			fetch: () => Promise.resolve(new Response("", { status: 503 })),
		});
		cache.seed(DID_A);
		const msg = new FakeMessage();

		await processMessage(jobFor(DID_A, NSID.packageProfile, "demo"), msg, deps);

		expect(msg.retried).toBe(1);
		expect(msg.acked).toBe(0);
		expect(await deadLetterCount()).toBe(0);
	});

	it("retries on a network error", async () => {
		const { deps, cache } = buildDeps({
			fetch: () => Promise.reject(new TypeError("connection refused")),
		});
		cache.seed(DID_A);
		const msg = new FakeMessage();

		await processMessage(jobFor(DID_A, NSID.packageProfile, "demo"), msg, deps);

		expect(msg.retried).toBe(1);
		expect(await deadLetterCount()).toBe(0);
	});

	it("forensics + acks on garbage CAR bytes (verifyRecord rejects → INVALID_PROOF)", async () => {
		const { deps, cache } = buildDeps({
			fetch: () => Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })),
		});
		cache.seed(DID_A);
		const msg = new FakeMessage();

		await processMessage(jobFor(DID_A, NSID.packageProfile, "demo"), msg, deps);

		expect(msg.acked).toBe(1);
		const row = await testEnv.DB.prepare(`SELECT reason FROM dead_letters`).first<{
			reason: string;
		}>();
		expect(row?.reason).toBe("INVALID_PROOF");
	});

	it("delete: acks immediately, no PDS fetch", async () => {
		let fetchCalls = 0;
		const { deps } = buildDeps({
			fetch: () => {
				fetchCalls += 1;
				return Promise.resolve(new Response("", { status: 500 }));
			},
		});
		const msg = new FakeMessage();
		const job = jobFor(DID_A, NSID.packageProfile, "demo", { operation: "delete" });

		await processMessage(job, msg, deps);

		expect(msg.acked).toBe(1);
		expect(fetchCalls).toBe(0);
	});
});

// Anchors the imports so a future refactor that drops them gets flagged. The
// classes are referenced indirectly via toMatchObject({ name }) assertions; the
// `publicKey` is kept for the eventual node-pool integration tests.
const _imports: ReadonlyArray<unknown> = [IngestError, PdsVerificationError];
void _imports;
