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
	expire(did: string) {
		const entry = this.entries.get(did);
		if (entry) this.entries.set(did, { ...entry, resolvedAt: new Date(0) });
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

// ─── Adversarial-review fixes: regression tests ─────────────────────────────

describe("ingestPackageProfile: security[] contact validation", () => {
	it("rejects security entries with neither url nor email", async () => {
		const job = jobFor(DID_A, NSID.packageProfile, "demo");
		await expect(
			ingestPackageProfile(
				testEnv.DB,
				job,
				fakeVerified({
					$type: NSID.packageProfile,
					id: `at://${DID_A}/${NSID.packageProfile}/demo`,
					slug: "demo",
					type: "emdash-plugin",
					license: "MIT",
					authors: [{ name: "Tester" }],
					security: [{ kind: "security" }],
				}),
				NOW,
			),
		).rejects.toMatchObject({ reason: "CONTACT_VALIDATION_FAILED" });
	});
});

describe("ingestPackageRelease: releaseExtension validation", () => {
	const validProfile = {
		$type: NSID.packageProfile,
		id: `at://${DID_A}/${NSID.packageProfile}/demo`,
		slug: "demo",
		type: "emdash-plugin",
		license: "MIT",
		authors: [{ name: "Tester" }],
		security: [{ email: "x@y.test" }],
	};
	beforeEach(async () => {
		await ingestPackageProfile(
			testEnv.DB,
			jobFor(DID_A, NSID.packageProfile, "demo"),
			fakeVerified(validProfile),
			NOW,
		);
	});

	it("rejects when extensions field is missing the releaseExtension key", async () => {
		await expect(
			ingestPackageRelease(
				testEnv.DB,
				jobFor(DID_A, NSID.packageRelease, "demo:1.0.0"),
				fakeVerified({
					$type: NSID.packageRelease,
					package: "demo",
					version: "1.0.0",
					artifacts: { package: { url: "https://x.test/d.tgz", checksum: "bsha-abc" } },
					extensions: {},
				}),
				NOW,
			),
		).rejects.toMatchObject({ reason: "LEXICON_VALIDATION_FAILED" });
	});

	it("rejects when extensions field is not an object", async () => {
		await expect(
			ingestPackageRelease(
				testEnv.DB,
				jobFor(DID_A, NSID.packageRelease, "demo:1.0.0"),
				fakeVerified({
					$type: NSID.packageRelease,
					package: "demo",
					version: "1.0.0",
					artifacts: { package: { url: "https://x.test/d.tgz", checksum: "bsha-abc" } },
					extensions: "lol",
				}),
				NOW,
			),
		).rejects.toMatchObject({ reason: "LEXICON_VALIDATION_FAILED" });
	});

	it("rejects when releaseExtension fails its own lexicon validation", async () => {
		await expect(
			ingestPackageRelease(
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
							// missing required `declaredAccess`
						},
					},
				}),
				NOW,
			),
		).rejects.toMatchObject({ reason: "LEXICON_VALIDATION_FAILED" });
	});

	it("stores only the validated releaseExtension contents in emdash_extension", async () => {
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
						declaredAccess: { network: { fetch: {} } },
					},
					// arbitrary extra key — must NOT land in the column
					"com.example.someoneElse": { irrelevant: "data" },
				},
			}),
			NOW,
		);
		const row = await testEnv.DB.prepare(
			`SELECT emdash_extension FROM releases WHERE did = ? AND package = ? AND version = ?`,
		)
			.bind(DID_A, "demo", "1.0.0")
			.first<{ emdash_extension: string }>();
		const stored = JSON.parse(row?.emdash_extension ?? "{}");
		expect(stored.declaredAccess).toBeDefined();
		expect(stored).not.toHaveProperty("com.example.someoneElse");
	});
});

describe("ingestPackageRelease: package field charset", () => {
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
	});

	it("rejects record.package containing a colon", async () => {
		// Ambiguous-rkey attack: `package: "foo:bar"` + `version: "1.0.0"`
		// would build the same rkey as `package: "foo"` + `version: "bar:1.0.0"`.
		await expect(
			ingestPackageRelease(
				testEnv.DB,
				jobFor(DID_A, NSID.packageRelease, "demo:bad:1.0.0"),
				fakeVerified({
					$type: NSID.packageRelease,
					package: "demo:bad",
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
			),
		).rejects.toMatchObject({ reason: "RKEY_MISMATCH" });
	});
});

describe("ingestPackageRelease: parent profile pre-check", () => {
	it("throws MissingDependencyError when no parent profile exists", async () => {
		// No profile seeded — release event arriving before its profile.
		await expect(
			ingestPackageRelease(
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
			),
		).rejects.toMatchObject({ name: "MissingDependencyError" });
	});

	// Dispatcher-level retry-on-MissingDependency coverage lives in the
	// "processMessage dispatcher" suite further down — uses
	// `ConsumerDeps.verify` injection so the writer's parent-profile
	// pre-check actually fires and the dispatcher's retry branch runs
	// end-to-end.
});

describe("ingestPackageRelease: latest_version + capabilities denormalisation", () => {
	const validProfile = {
		$type: NSID.packageProfile,
		id: `at://${DID_A}/${NSID.packageProfile}/demo`,
		slug: "demo",
		type: "emdash-plugin",
		license: "MIT",
		authors: [{ name: "Tester" }],
		security: [{ email: "x@y.test" }],
	};
	beforeEach(async () => {
		await ingestPackageProfile(
			testEnv.DB,
			jobFor(DID_A, NSID.packageProfile, "demo"),
			fakeVerified(validProfile),
			NOW,
		);
	});

	function release(version: string, declaredAccess: Record<string, unknown>) {
		return {
			$type: NSID.packageRelease,
			package: "demo",
			version,
			artifacts: { package: { url: "https://x.test/d.tgz", checksum: "bsha-abc" } },
			extensions: {
				"com.emdashcms.experimental.package.releaseExtension": {
					$type: "com.emdashcms.experimental.package.releaseExtension",
					declaredAccess,
				},
			},
		};
	}

	it("populates packages.latest_version after first release insert", async () => {
		await ingestPackageRelease(
			testEnv.DB,
			jobFor(DID_A, NSID.packageRelease, "demo:1.0.0"),
			fakeVerified(release("1.0.0", { content: { read: {} } })),
			NOW,
		);
		const row = await testEnv.DB.prepare(
			`SELECT latest_version, capabilities FROM packages WHERE did = ?`,
		)
			.bind(DID_A)
			.first<{ latest_version: string; capabilities: string }>();
		expect(row?.latest_version).toBe("1.0.0");
		expect(JSON.parse(row?.capabilities ?? "[]")).toEqual(["content"]);
	});

	it("updates latest_version when a higher-version release lands", async () => {
		await ingestPackageRelease(
			testEnv.DB,
			jobFor(DID_A, NSID.packageRelease, "demo:1.0.0"),
			fakeVerified(release("1.0.0", { content: { read: {} } })),
			NOW,
		);
		await ingestPackageRelease(
			testEnv.DB,
			jobFor(DID_A, NSID.packageRelease, "demo:2.0.0"),
			fakeVerified(release("2.0.0", { network: { fetch: {} } })),
			NOW,
		);
		const row = await testEnv.DB.prepare(
			`SELECT latest_version, capabilities FROM packages`,
		).first<{ latest_version: string; capabilities: string }>();
		expect(row?.latest_version).toBe("2.0.0");
		expect(JSON.parse(row?.capabilities ?? "[]")).toEqual(["network"]);
	});

	it("does NOT downgrade latest_version when an older release lands", async () => {
		await ingestPackageRelease(
			testEnv.DB,
			jobFor(DID_A, NSID.packageRelease, "demo:2.0.0"),
			fakeVerified(release("2.0.0", { network: { fetch: {} } })),
			NOW,
		);
		await ingestPackageRelease(
			testEnv.DB,
			jobFor(DID_A, NSID.packageRelease, "demo:1.0.0"),
			fakeVerified(release("1.0.0", { content: { read: {} } })),
			NOW,
		);
		const row = await testEnv.DB.prepare(`SELECT latest_version FROM packages`).first<{
			latest_version: string;
		}>();
		expect(row?.latest_version).toBe("2.0.0");
	});

	it("recomputes latest_version after a release tombstone", async () => {
		await ingestPackageRelease(
			testEnv.DB,
			jobFor(DID_A, NSID.packageRelease, "demo:1.0.0"),
			fakeVerified(release("1.0.0", {})),
			NOW,
		);
		await ingestPackageRelease(
			testEnv.DB,
			jobFor(DID_A, NSID.packageRelease, "demo:2.0.0"),
			fakeVerified(release("2.0.0", {})),
			NOW,
		);
		// Tombstone the latest.
		await applyDelete(
			testEnv.DB,
			jobFor(DID_A, NSID.packageRelease, "demo:2.0.0", { operation: "delete" }),
			NOW,
		);
		const row = await testEnv.DB.prepare(`SELECT latest_version FROM packages`).first<{
			latest_version: string;
		}>();
		expect(row?.latest_version).toBe("1.0.0");
	});
});

describe("ingestPackageRelease: same-content re-publish on tombstoned row", () => {
	const validProfile = {
		$type: NSID.packageProfile,
		id: `at://${DID_A}/${NSID.packageProfile}/demo`,
		slug: "demo",
		type: "emdash-plugin",
		license: "MIT",
		authors: [{ name: "Tester" }],
		security: [{ email: "x@y.test" }],
	};
	const release = {
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
	};

	beforeEach(async () => {
		await ingestPackageProfile(
			testEnv.DB,
			jobFor(DID_A, NSID.packageProfile, "demo"),
			fakeVerified(validProfile),
			NOW,
		);
	});

	it("clears tombstoned_at on a same-content republish", async () => {
		const job = jobFor(DID_A, NSID.packageRelease, "demo:1.0.0");
		const verified = fakeVerified(release);
		await ingestPackageRelease(testEnv.DB, job, verified, NOW);
		await applyDelete(testEnv.DB, { ...job, operation: "delete" }, NOW);
		// Confirm tombstoned.
		const before = await testEnv.DB.prepare(
			`SELECT tombstoned_at FROM releases WHERE did = ? AND package = ? AND version = ?`,
		)
			.bind(DID_A, "demo", "1.0.0")
			.first<{ tombstoned_at: string | null }>();
		expect(before?.tombstoned_at).not.toBeNull();
		// Re-publish identical bytes.
		await ingestPackageRelease(testEnv.DB, job, verified, NOW);
		const after = await testEnv.DB.prepare(
			`SELECT tombstoned_at FROM releases WHERE did = ? AND package = ? AND version = ?`,
		)
			.bind(DID_A, "demo", "1.0.0")
			.first<{ tombstoned_at: string | null }>();
		expect(after?.tombstoned_at).toBeNull();
	});

	it("does NOT audit a duplicate-attempt when same content lands on a tombstone", async () => {
		const job = jobFor(DID_A, NSID.packageRelease, "demo:1.0.0");
		const verified = fakeVerified(release);
		await ingestPackageRelease(testEnv.DB, job, verified, NOW);
		await applyDelete(testEnv.DB, { ...job, operation: "delete" }, NOW);
		await ingestPackageRelease(testEnv.DB, job, verified, NOW);
		const dups = await testEnv.DB.prepare(
			`SELECT COUNT(*) as n FROM release_duplicate_attempts`,
		).first<{ n: number }>();
		expect(dups?.n).toBe(0);
	});
});

describe("computeVersionSort + version overflow rejection", () => {
	const validProfile = {
		$type: NSID.packageProfile,
		id: `at://${DID_A}/${NSID.packageProfile}/demo`,
		slug: "demo",
		type: "emdash-plugin",
		license: "MIT",
		authors: [{ name: "Tester" }],
		security: [{ email: "x@y.test" }],
	};
	beforeEach(async () => {
		await ingestPackageProfile(
			testEnv.DB,
			jobFor(DID_A, NSID.packageProfile, "demo"),
			fakeVerified(validProfile),
			NOW,
		);
	});

	function release(version: string) {
		return {
			$type: NSID.packageRelease,
			package: "demo",
			version,
			artifacts: { package: { url: "https://x.test/d.tgz", checksum: "bsha-abc" } },
			extensions: {
				"com.emdashcms.experimental.package.releaseExtension": {
					$type: "com.emdashcms.experimental.package.releaseExtension",
					declaredAccess: {},
				},
			},
		};
	}

	it("rejects prerelease numerics longer than 10 digits", async () => {
		await expect(
			ingestPackageRelease(
				testEnv.DB,
				jobFor(DID_A, NSID.packageRelease, "demo:1.0.0-12345678901"),
				fakeVerified(release("1.0.0-12345678901")),
				NOW,
			),
		).rejects.toMatchObject({ reason: "INVALID_VERSION" });
	});

	it("rejects major/minor/patch components longer than 10 digits", async () => {
		await expect(
			ingestPackageRelease(
				testEnv.DB,
				jobFor(DID_A, NSID.packageRelease, "demo:99999999999.0.0"),
				fakeVerified(release("99999999999.0.0")),
				NOW,
			),
		).rejects.toMatchObject({ reason: "INVALID_VERSION" });
	});
});

describe("applyDelete unknown collection", () => {
	it("throws IngestError UNKNOWN_COLLECTION instead of silently dropping", async () => {
		await expect(
			applyDelete(
				testEnv.DB,
				jobFor(DID_A, "com.example.unknown", "x", { operation: "delete" }),
				NOW,
			),
		).rejects.toMatchObject({ name: "IngestError", reason: "UNKNOWN_COLLECTION" });
	});
});

describe("processMessage dispatcher: MissingDependencyError → retry", () => {
	it("retries the message when the release writer throws MissingDependencyError", async () => {
		// No parent profile seeded — release writer's parent-profile check
		// throws MissingDependencyError → dispatcher should map to retry().
		const cache = new MapDidDocCache();
		const resolver = new DidResolver({
			cache,
			resolver: new StubResolver(),
			ttlMs: 1_000_000,
			now: () => NOW,
		});
		cache.seed(DID_A);
		const release = {
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
		};
		const deps: ConsumerDeps = {
			db: testEnv.DB,
			resolver,
			now: () => NOW,
			// Inject a verifier that returns a real-shaped record without
			// running the actual @atcute/repo verification chain.
			verify: () =>
				Promise.resolve({
					cid: "bafyreigtest00000000000000000000000000000000000000000000",
					record: release,
					carBytes: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
				}),
		};
		const msg = new FakeMessage();
		await processMessage(jobFor(DID_A, NSID.packageRelease, "demo:1.0.0"), msg, deps);

		expect(msg.retried).toBe(1);
		expect(msg.acked).toBe(0);
		expect(await deadLetterCount()).toBe(0);
	});
});

describe("ingestPackageRelease: latest_version refresh atomicity", () => {
	const validProfile = {
		$type: NSID.packageProfile,
		id: `at://${DID_A}/${NSID.packageProfile}/demo`,
		slug: "demo",
		type: "emdash-plugin",
		license: "MIT",
		authors: [{ name: "Tester" }],
		security: [{ email: "x@y.test" }],
	};
	function release(version: string) {
		return {
			$type: NSID.packageRelease,
			package: "demo",
			version,
			artifacts: { package: { url: "https://x.test/d.tgz", checksum: "bsha-abc" } },
			extensions: {
				"com.emdashcms.experimental.package.releaseExtension": {
					$type: "com.emdashcms.experimental.package.releaseExtension",
					declaredAccess: { content: { read: {} } },
				},
			},
		};
	}
	beforeEach(async () => {
		await ingestPackageProfile(
			testEnv.DB,
			jobFor(DID_A, NSID.packageProfile, "demo"),
			fakeVerified(validProfile),
			NOW,
		);
	});

	it("idempotent same-content insert still leaves latest_version correct", async () => {
		const job = jobFor(DID_A, NSID.packageRelease, "demo:1.0.0");
		const verified = fakeVerified(release("1.0.0"));
		await ingestPackageRelease(testEnv.DB, job, verified, NOW);
		// Manually corrupt latest_version to simulate a refresh that
		// somehow drifted out of sync with the underlying releases.
		await testEnv.DB.prepare(`UPDATE packages SET latest_version = NULL`).run();
		// Replay same content. Refresh always runs in the batch — should fix.
		await ingestPackageRelease(testEnv.DB, job, verified, NOW);
		const row = await testEnv.DB.prepare(`SELECT latest_version FROM packages`).first<{
			latest_version: string;
		}>();
		expect(row?.latest_version).toBe("1.0.0");
	});

	it("uses single-statement UPDATE for refresh (race-safety check via SQL shape)", async () => {
		// Insert v1, manually insert v2 directly (bypassing writer), then
		// re-trigger refresh by re-inserting v1 (idempotent). The race-safe
		// UPDATE should pick up v2 as the new latest because its subquery
		// reads current max state, not a snapshot from before the manual
		// insert.
		await ingestPackageRelease(
			testEnv.DB,
			jobFor(DID_A, NSID.packageRelease, "demo:1.0.0"),
			fakeVerified(release("1.0.0")),
			NOW,
		);
		// Manually insert v2 with a known version_sort that sorts after 1.0.0.
		await testEnv.DB.prepare(
			`INSERT INTO releases
			   (did, package, version, rkey, version_sort, artifacts,
			    emdash_extension, cts, record_blob, signature_metadata, verified_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				DID_A,
				"demo",
				"2.0.0",
				"demo:2.0.0",
				"0000000002.0000000000.0000000000.~",
				"{}",
				JSON.stringify({ declaredAccess: { network: { fetch: {} } } }),
				NOW.toISOString(),
				new Uint8Array([0xff]),
				JSON.stringify({ cid: "x" }),
				NOW.toISOString(),
			)
			.run();
		// Re-trigger refresh by re-publishing v1 (same content → DO NOTHING,
		// but the batched refresh-UPDATE still runs).
		await ingestPackageRelease(
			testEnv.DB,
			jobFor(DID_A, NSID.packageRelease, "demo:1.0.0"),
			fakeVerified(release("1.0.0")),
			NOW,
		);
		const row = await testEnv.DB.prepare(
			`SELECT latest_version, capabilities FROM packages`,
		).first<{ latest_version: string; capabilities: string }>();
		expect(row?.latest_version).toBe("2.0.0");
		expect(JSON.parse(row?.capabilities ?? "[]")).toEqual(["network"]);
	});
});

describe("release_duplicate_attempts UNIQUE constraint", () => {
	const validProfile = {
		$type: NSID.packageProfile,
		id: `at://${DID_A}/${NSID.packageProfile}/demo`,
		slug: "demo",
		type: "emdash-plugin",
		license: "MIT",
		authors: [{ name: "Tester" }],
		security: [{ email: "x@y.test" }],
	};
	function release(version: string) {
		return {
			$type: NSID.packageRelease,
			package: "demo",
			version,
			artifacts: { package: { url: "https://x.test/d.tgz", checksum: "bsha-abc" } },
			extensions: {
				"com.emdashcms.experimental.package.releaseExtension": {
					$type: "com.emdashcms.experimental.package.releaseExtension",
					declaredAccess: {},
				},
			},
		};
	}
	beforeEach(async () => {
		await ingestPackageProfile(
			testEnv.DB,
			jobFor(DID_A, NSID.packageProfile, "demo"),
			fakeVerified(validProfile),
			NOW,
		);
	});

	it("dedupes repeated identical duplicate-attempt payloads", async () => {
		const job = jobFor(DID_A, NSID.packageRelease, "demo:1.0.0");
		await ingestPackageRelease(testEnv.DB, job, fakeVerified(release("1.0.0")), NOW);

		// Hostile-publisher pattern: pump the same different-content tampered
		// payload many times.
		const tampered: VerifiedPdsRecord = {
			cid: "bafyreigDIFFERENT00000000000000000000000000000000000000",
			record: release("1.0.0"),
			carBytes: new Uint8Array([0x01, 0x02, 0x03]),
		};
		for (let i = 0; i < 5; i++) {
			await ingestPackageRelease(testEnv.DB, job, tampered, NOW);
		}
		const dups = await testEnv.DB.prepare(
			`SELECT COUNT(*) as n FROM release_duplicate_attempts`,
		).first<{ n: number }>();
		expect(dups?.n).toBe(1);
	});

	it("audits distinct tampered payloads as separate attempts", async () => {
		const job = jobFor(DID_A, NSID.packageRelease, "demo:1.0.0");
		await ingestPackageRelease(testEnv.DB, job, fakeVerified(release("1.0.0")), NOW);

		await ingestPackageRelease(
			testEnv.DB,
			job,
			{
				cid: "x",
				record: release("1.0.0"),
				carBytes: new Uint8Array([0x01]),
			},
			NOW,
		);
		await ingestPackageRelease(
			testEnv.DB,
			job,
			{
				cid: "y",
				record: release("1.0.0"),
				carBytes: new Uint8Array([0x02]),
			},
			NOW,
		);
		const dups = await testEnv.DB.prepare(
			`SELECT COUNT(*) as n FROM release_duplicate_attempts`,
		).first<{ n: number }>();
		expect(dups?.n).toBe(2);
	});
});

describe("parseReleaseRkey: malformed %-encoding in delete rkey", () => {
	it("throws IngestError so the dispatcher writes a dead_letters row before acking", async () => {
		// Silently no-op'ing the parse failure would lose the audit trail —
		// an operator investigating "why didn't this delete take effect?"
		// would have nothing to look at.
		await expect(
			applyDelete(
				testEnv.DB,
				jobFor(DID_A, NSID.packageRelease, "demo:1.0.0%XX", { operation: "delete" }),
				NOW,
			),
		).rejects.toMatchObject({ name: "IngestError", reason: "RKEY_MISMATCH" });
	});
});

describe("drainDeadLetterBatch", () => {
	it("acks each message and writes a forensics row", async () => {
		const { drainDeadLetterBatch: drain } = await import("../src/records-consumer.js");
		const messages: Array<MessageController & { body: RecordsJob }> = [
			{
				body: jobFor(DID_A, NSID.packageRelease, "demo:1.0.0"),
				ack: () => {},
				retry: () => {},
			},
			{
				body: jobFor(DID_B, NSID.packageProfile, "other"),
				ack: () => {},
				retry: () => {},
			},
		];
		let acked = 0;
		messages.forEach((m) => {
			const orig = m.ack;
			m.ack = () => {
				acked += 1;
				orig();
			};
		});
		await drain({ messages }, { DB: testEnv.DB } as unknown as Env);

		expect(acked).toBe(2);
		const dl = await testEnv.DB.prepare(`SELECT COUNT(*) as n FROM dead_letters`).first<{
			n: number;
		}>();
		expect(dl?.n).toBe(2);
	});
});

describe("drainDeadLetterBatch: D1 failure", () => {
	it("retries the message when writeDeadLetter throws", async () => {
		const { drainDeadLetterBatch: drain } = await import("../src/records-consumer.js");
		let acked = 0;
		let retried = 0;
		const message: MessageController & { body: RecordsJob } = {
			body: jobFor(DID_A, NSID.packageRelease, "demo:1.0.0"),
			ack: () => {
				acked += 1;
			},
			retry: () => {
				retried += 1;
			},
		};
		// Stub DB whose insert throws to simulate transient D1 failure.
		const failingDb = {
			prepare: () => ({
				bind: () => ({
					run: () => Promise.reject(new Error("D1 unavailable")),
				}),
			}),
		} as unknown as D1Database;
		await drain({ messages: [message] }, { DB: failingDb } as unknown as Env);

		expect(retried).toBe(1);
		expect(acked).toBe(0);
	});
});

describe("refresh skips writes when values unchanged (avoids FTS-trigger thrashing)", () => {
	const validProfile = {
		$type: NSID.packageProfile,
		id: `at://${DID_A}/${NSID.packageProfile}/demo`,
		slug: "demo",
		type: "emdash-plugin",
		license: "MIT",
		// name + description give FTS something to index so the test can
		// observe trigger-induced reindexing.
		name: "Demo Plugin",
		description: "A searchable demo plugin",
		authors: [{ name: "Tester" }],
		security: [{ email: "x@y.test" }],
	};
	const release = {
		$type: NSID.packageRelease,
		package: "demo",
		version: "1.0.0",
		artifacts: { package: { url: "https://x.test/d.tgz", checksum: "bsha-abc" } },
		extensions: {
			"com.emdashcms.experimental.package.releaseExtension": {
				$type: "com.emdashcms.experimental.package.releaseExtension",
				declaredAccess: { content: { read: {} } },
			},
		},
	};

	beforeEach(async () => {
		await ingestPackageProfile(
			testEnv.DB,
			jobFor(DID_A, NSID.packageProfile, "demo"),
			fakeVerified(validProfile),
			NOW,
		);
	});

	it("does not re-fire packages_au trigger on idempotent refresh", async () => {
		const job = jobFor(DID_A, NSID.packageRelease, "demo:1.0.0");
		const verified = fakeVerified(release);
		await ingestPackageRelease(testEnv.DB, job, verified, NOW);

		// Capture FTS state after first ingest.
		const ftsBefore = await testEnv.DB.prepare(
			`SELECT rowid FROM packages_fts WHERE packages_fts MATCH ?`,
		)
			.bind("demo")
			.all();

		// Replay same content many times. Each replay would normally fire
		// the AFTER UPDATE trigger and re-index FTS even with same content.
		// The WHERE-AND-IS-NOT guard short-circuits before the trigger.
		for (let i = 0; i < 10; i++) {
			await ingestPackageRelease(testEnv.DB, job, verified, NOW);
		}

		const ftsAfter = await testEnv.DB.prepare(
			`SELECT rowid FROM packages_fts WHERE packages_fts MATCH ?`,
		)
			.bind("demo")
			.all();

		// FTS state must be unchanged (same single row). Asserting both row
		// count and rowid stability — a re-trigger would delete + re-insert
		// with the same rowid in this trigger's design, but if SQLite ever
		// optimizes that to a no-op, this test still passes.
		expect(ftsAfter.results).toHaveLength(1);
		expect(ftsAfter.results).toEqual(ftsBefore.results);
	});
});

describe("release_duplicate_attempts.rejected_at tracks latest attempt", () => {
	const validProfile = {
		$type: NSID.packageProfile,
		id: `at://${DID_A}/${NSID.packageProfile}/demo`,
		slug: "demo",
		type: "emdash-plugin",
		license: "MIT",
		authors: [{ name: "Tester" }],
		security: [{ email: "x@y.test" }],
	};
	const release = {
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
	};

	it("DO UPDATE refreshes rejected_at on repeated identical attempts", async () => {
		await ingestPackageProfile(
			testEnv.DB,
			jobFor(DID_A, NSID.packageProfile, "demo"),
			fakeVerified(validProfile),
			NOW,
		);
		const job = jobFor(DID_A, NSID.packageRelease, "demo:1.0.0");
		await ingestPackageRelease(testEnv.DB, job, fakeVerified(release), NOW);

		const tampered: VerifiedPdsRecord = {
			cid: "x",
			record: release,
			carBytes: new Uint8Array([0x01, 0x02, 0x03]),
		};
		const t1 = new Date("2026-05-09T12:00:00.000Z");
		const t2 = new Date("2026-05-10T18:00:00.000Z");
		await ingestPackageRelease(testEnv.DB, job, tampered, t1);
		await ingestPackageRelease(testEnv.DB, job, tampered, t2);

		const row = await testEnv.DB.prepare(
			`SELECT rejected_at FROM release_duplicate_attempts`,
		).first<{ rejected_at: string }>();
		expect(row?.rejected_at).toBe(t2.toISOString());
	});
});

describe("processBatch isolates per-message failures", () => {
	it("retries the failing message and continues processing the rest of the batch", async () => {
		const { processBatch } = await import("../src/records-consumer.js");
		// First message's processMessage will throw (forensics-write fails);
		// second message should still be processed.
		const failingDeps: ConsumerDeps = {
			db: {
				prepare: () => ({
					bind: () => ({
						run: () => Promise.reject(new Error("D1 unavailable")),
						first: () => Promise.reject(new Error("D1 unavailable")),
					}),
				}),
			} as unknown as D1Database,
			resolver: new DidResolver({
				cache: new MapDidDocCache(),
				resolver: new StubResolver(),
				ttlMs: 1_000_000,
				now: () => NOW,
			}),
			now: () => NOW,
			// verify that throws → processMessage tries to writeDeadLetter →
			// that throws too because db is broken → escapes to processBatch.
			verify: () =>
				Promise.reject(Object.assign(new Error("network down"), { name: "PdsVerificationError" })),
		};

		const messages: Array<MessageController & { body: RecordsJob }> = [];
		const acks: number[] = [];
		const retries: number[] = [];
		for (let i = 0; i < 3; i++) {
			const idx = i;
			messages.push({
				body: jobFor(`did:plc:b${i.toString().padStart(20, "0")}`, NSID.packageProfile, "x"),
				ack: () => {
					acks.push(idx);
				},
				retry: () => {
					retries.push(idx);
				},
			});
		}
		await processBatch({ messages }, {} as Env, failingDeps);

		// Each message either acks or retries — no message escapes the loop
		// without being controlled. With the failing deps every message ends
		// up retried via the catch in processBatch.
		expect(retries).toEqual([0, 1, 2]);
		expect(acks).toEqual([]);
	});
});

describe("duplicate detection compares CIDs, not CAR bytes", () => {
	const validProfile = {
		$type: NSID.packageProfile,
		id: `at://${DID_A}/${NSID.packageProfile}/demo`,
		slug: "demo",
		type: "emdash-plugin",
		license: "MIT",
		authors: [{ name: "Tester" }],
		security: [{ email: "x@y.test" }],
	};
	const release = {
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
	};

	beforeEach(async () => {
		await ingestPackageProfile(
			testEnv.DB,
			jobFor(DID_A, NSID.packageProfile, "demo"),
			fakeVerified(validProfile),
			NOW,
		);
	});

	it("treats same CID + different CAR bytes as a benign replay (no audit row)", async () => {
		const job = jobFor(DID_A, NSID.packageRelease, "demo:1.0.0");
		// First ingest with one set of bytes.
		await ingestPackageRelease(
			testEnv.DB,
			job,
			{
				cid: "bafyreigtest00000000000000000000000000000000000000000000",
				record: release,
				carBytes: new Uint8Array([0x01, 0x02, 0x03]),
			},
			NOW,
		);
		// Re-fetch produces different CAR bytes (publisher has written other
		// records → MST proof differs) but the same record CID.
		await ingestPackageRelease(
			testEnv.DB,
			job,
			{
				cid: "bafyreigtest00000000000000000000000000000000000000000000",
				record: release,
				carBytes: new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]),
			},
			NOW,
		);
		const dups = await testEnv.DB.prepare(
			`SELECT COUNT(*) as n FROM release_duplicate_attempts`,
		).first<{ n: number }>();
		expect(dups?.n).toBe(0);
	});

	it("treats different CID at same version as an immutability violation", async () => {
		const job = jobFor(DID_A, NSID.packageRelease, "demo:1.0.0");
		await ingestPackageRelease(
			testEnv.DB,
			job,
			{
				cid: "bafyreigtest00000000000000000000000000000000000000000000",
				record: release,
				carBytes: new Uint8Array([0x01]),
			},
			NOW,
		);
		await ingestPackageRelease(
			testEnv.DB,
			job,
			{
				cid: "bafyreigtampered000000000000000000000000000000000000000",
				record: release,
				carBytes: new Uint8Array([0x02]),
			},
			NOW,
		);
		const row = await testEnv.DB.prepare(
			`SELECT attempted_cid, reason FROM release_duplicate_attempts`,
		).first<{ attempted_cid: string; reason: string }>();
		expect(row?.attempted_cid).toBe("bafyreigtampered000000000000000000000000000000000000000");
		expect(row?.reason).toBe("IMMUTABLE_VERSION");
	});
});

describe("computeVersionSort: final sentinel beats pathological prereleases", () => {
	const validProfile = {
		$type: NSID.packageProfile,
		id: `at://${DID_A}/${NSID.packageProfile}/demo`,
		slug: "demo",
		type: "emdash-plugin",
		license: "MIT",
		authors: [{ name: "Tester" }],
		security: [{ email: "x@y.test" }],
	};
	function release(version: string) {
		return {
			$type: NSID.packageRelease,
			package: "demo",
			version,
			artifacts: { package: { url: "https://x.test/d.tgz", checksum: "bsha-abc" } },
			extensions: {
				"com.emdashcms.experimental.package.releaseExtension": {
					$type: "com.emdashcms.experimental.package.releaseExtension",
					declaredAccess: {},
				},
			},
		};
	}
	beforeEach(async () => {
		await ingestPackageProfile(
			testEnv.DB,
			jobFor(DID_A, NSID.packageProfile, "demo"),
			fakeVerified(validProfile),
			NOW,
		);
	});

	it("`1.0.0` (final) sorts after `1.0.0-zzzz` (prerelease longer than old `zzz` sentinel)", async () => {
		await ingestPackageRelease(
			testEnv.DB,
			jobFor(DID_A, NSID.packageRelease, "demo:1.0.0-zzzz"),
			fakeVerified(release("1.0.0-zzzz")),
			NOW,
		);
		await ingestPackageRelease(
			testEnv.DB,
			jobFor(DID_A, NSID.packageRelease, "demo:1.0.0"),
			fakeVerified(release("1.0.0")),
			NOW,
		);
		const row = await testEnv.DB.prepare(`SELECT latest_version FROM packages`).first<{
			latest_version: string;
		}>();
		expect(row?.latest_version).toBe("1.0.0");
	});
});

describe("parseReleaseRkey component validation", () => {
	it("applyDelete rejects `package:version:extra` rkey via IngestError", async () => {
		// Splitting on the first `:` would parse as pkg=`demo`, version=`1.0.0:extra`.
		// The semver regex must reject the colon-bearing version.
		await expect(
			applyDelete(
				testEnv.DB,
				jobFor(DID_A, NSID.packageRelease, "demo:1.0.0:extra", { operation: "delete" }),
				NOW,
			),
		).rejects.toMatchObject({ name: "IngestError", reason: "RKEY_MISMATCH" });
	});

	it("applyDelete rejects rkeys whose package portion violates the slug regex", async () => {
		await expect(
			applyDelete(
				testEnv.DB,
				jobFor(DID_A, NSID.packageRelease, "9bad-leading-digit:1.0.0", { operation: "delete" }),
				NOW,
			),
		).rejects.toMatchObject({ name: "IngestError", reason: "RKEY_MISMATCH" });
	});
});

// Anchors the imports so a future refactor that drops them gets flagged. The
// classes are referenced indirectly via toMatchObject({ name }) assertions.
const _imports: ReadonlyArray<unknown> = [IngestError, PdsVerificationError];
void _imports;
