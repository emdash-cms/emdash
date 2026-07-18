/**
 * Read API integration tests.
 *
 * Each test seeds D1 directly with the columns the handlers read, then
 * exercises the handler via `SELF.fetch` to a `/xrpc/...` URL — same path
 * a real client would take. Asserts on the envelope shape (uri, cid, did,
 * indexedAt, mirrors, labels) and on error mappings (404 NotFound, 400
 * InvalidRequest).
 *
 * `mirrors: []` and `labels: []` are the v1 contract; Slice 2 (labels)
 * and Slice 3 (mirrors) populate them, but the contract is locked now so
 * cached clients don't see a shape change later.
 */

import { NSID } from "@emdash-cms/registry-lexicons";
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}
const testEnv = env as unknown as TestEnv;

const DID_A = "did:plc:read000000000000000000aa";
const DID_B = "did:plc:read000000000000000000bb";
const NOW = new Date("2026-05-10T12:00:00.000Z");

/** Default-policy labeler: seeded `trusted = 1` so the missing-header
 * default (`SELECT did FROM labelers WHERE trusted = 1`) picks it up. */
const LABELER_DID = "did:web:labels.example";
/** Configured but untrusted — absent from the default policy, but
 * available (and echoed) when a request explicitly names it. */
const UNTRUSTED_LABELER_DID = "did:web:untrusted-labels.example";

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
	// Tables in dependency order: releases → packages (FK), then publishers
	// + verifications.
	await testEnv.DB.prepare("DELETE FROM releases").run();
	await testEnv.DB.prepare("DELETE FROM packages").run();
	await testEnv.DB.prepare("DELETE FROM publishers").run();
	await testEnv.DB.prepare("DELETE FROM publisher_verifications").run();
	await testEnv.DB.prepare("DELETE FROM label_state").run();
	await testEnv.DB.prepare("DELETE FROM labelers").run();
});

interface SeedPackageOpts {
	did?: string;
	slug?: string;
	type?: string;
	name?: string | null;
	description?: string | null;
	license?: string;
	keywords?: string[] | null;
	latestVersion?: string | null;
	cid?: string;
	indexedAt?: string;
	verifiedAt?: string;
	carBytes?: Uint8Array;
}

async function seedPackage(opts: SeedPackageOpts = {}): Promise<void> {
	const did = opts.did ?? DID_A;
	const slug = opts.slug ?? "demo";
	const indexedAt = opts.indexedAt ?? NOW.toISOString();
	await testEnv.DB.prepare(
		`INSERT INTO packages
		   (did, slug, type, name, description, license, authors, security, keywords,
		    sections, last_updated, latest_version, capabilities, record_blob,
		    signature_metadata, verified_at, indexed_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			did,
			slug,
			opts.type ?? "emdash-plugin",
			opts.name ?? "Demo Plugin",
			opts.description ?? "A demo plugin",
			opts.license ?? "MIT",
			JSON.stringify([{ name: "Tester" }]),
			JSON.stringify([{ email: "x@y.test" }]),
			opts.keywords === null ? null : JSON.stringify(opts.keywords ?? ["demo"]),
			null,
			NOW.toISOString(),
			opts.latestVersion ?? null,
			null,
			opts.carBytes ?? new Uint8Array([0xa1, 0xa2, 0xa3]),
			JSON.stringify({ cid: opts.cid ?? "bafyseed" }),
			opts.verifiedAt ?? NOW.toISOString(),
			indexedAt,
		)
		.run();
}

interface SeedReleaseOpts {
	did?: string;
	package?: string;
	version: string;
	versionSort?: string;
	tombstoned?: boolean;
	cid?: string;
	carBytes?: Uint8Array;
}

async function seedRelease(opts: SeedReleaseOpts): Promise<void> {
	const did = opts.did ?? DID_A;
	const pkg = opts.package ?? "demo";
	const rkey = `${pkg}:${opts.version}`;
	await testEnv.DB.prepare(
		`INSERT INTO releases
		   (did, package, version, rkey, version_sort, artifacts, requires, suggests,
		    emdash_extension, repo_url, cts, record_blob, signature_metadata,
		    verified_at, indexed_at, tombstoned_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			did,
			pkg,
			opts.version,
			rkey,
			opts.versionSort ?? defaultVersionSort(opts.version),
			JSON.stringify({ package: { url: "https://x.test/d.tgz", checksum: "bsha256-abc" } }),
			null,
			null,
			JSON.stringify({ declaredAccess: {} }),
			null,
			NOW.toISOString(),
			opts.carBytes ?? new Uint8Array([0xb1, 0xb2, 0xb3]),
			JSON.stringify({ cid: opts.cid ?? `bafrel-${opts.version}` }),
			NOW.toISOString(),
			NOW.toISOString(),
			opts.tombstoned ? NOW.toISOString() : null,
		)
		.run();
}

/** Naive 1.x.y zero-padded version_sort for the test fixtures. Real values
 * come from the consumer's `computeVersionSort`; tests just need the
 * relative ordering to be right. */
function defaultVersionSort(version: string): string {
	const [major = "0", minor = "0", patch = "0"] = version.split(".");
	const pad = (s: string) => s.padStart(10, "0");
	return `${pad(major)}.${pad(minor)}.${pad(patch)}.~`;
}

function packageUri(slug: string, did: string = DID_A): string {
	return `at://${did}/${NSID.packageProfile}/${slug}`;
}

function releaseUri(pkg: string, version: string, did: string = DID_A): string {
	return `at://${did}/${NSID.packageRelease}/${pkg}:${version}`;
}

function publisherUri(did: string = DID_A): string {
	return `at://${did}/${NSID.publisherProfile}/self`;
}

interface SeedPublisherOpts {
	did?: string;
	displayName?: string;
	description?: string | null;
	url?: string | null;
	contact?: unknown[] | null;
	updatedAt?: string | null;
	cid?: string;
	indexedAt?: string;
	verifiedAt?: string;
}

async function seedPublisher(opts: SeedPublisherOpts = {}): Promise<void> {
	const did = opts.did ?? DID_A;
	const indexedAt = opts.indexedAt ?? NOW.toISOString();
	await testEnv.DB.prepare(
		`INSERT INTO publishers
		   (did, display_name, description, url, contact, updated_at,
		    record_blob, signature_metadata, verified_at, indexed_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			did,
			opts.displayName ?? "Demo Publisher",
			opts.description ?? null,
			opts.url ?? null,
			opts.contact === null
				? null
				: JSON.stringify(opts.contact ?? [{ kind: "security", email: "sec@pub.test" }]),
			opts.updatedAt ?? null,
			new Uint8Array([0xb1, 0xb2, 0xb3]),
			JSON.stringify({ cid: opts.cid ?? "bafypub" }),
			opts.verifiedAt ?? NOW.toISOString(),
			indexedAt,
		)
		.run();
}

/** Seeds a `labelers` row so a DID is "available" per W4.4's resolution:
 * `trusted = 1` rows feed the missing-header default set; any row (trusted
 * or not) makes a DID acceptable when explicitly requested. */
async function seedLabeler(did: string, trusted: boolean): Promise<void> {
	await testEnv.DB.prepare(
		`INSERT INTO labelers (did, endpoint, signing_key, signing_key_id, trusted, added_at, last_resolved_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			did,
			"https://labeler.example",
			"unused-in-tests",
			`${did}#atproto_label`,
			trusted ? 1 : 0,
			NOW.toISOString(),
			NOW.toISOString(),
		)
		.run();
}

async function seedLabelState(opts: {
	uri: string;
	val: string;
	src?: string;
	cid?: string | null;
	neg?: boolean;
	exp?: string;
}): Promise<void> {
	const src = opts.src ?? LABELER_DID;
	await testEnv.DB.prepare(
		`INSERT INTO label_state
		   (src, uri, val, cid, neg, cts, cts_epoch_ms, exp, exp_epoch_ms,
		    digest, source_sequence, frame_index, trusted)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			src,
			opts.uri,
			opts.val,
			opts.cid ?? null,
			opts.neg ? 1 : 0,
			NOW.toISOString(),
			NOW.getTime(),
			opts.exp ?? null,
			opts.exp === undefined ? null : Date.parse(opts.exp),
			`digest-${src}-${opts.uri}-${opts.val}`,
			1,
			0,
			1,
		)
		.run();
}

interface SeedVerificationOpts {
	issuerDid?: string;
	rkey?: string;
	subjectDid?: string;
	handle?: string;
	displayName?: string;
	createdAt?: string;
	expiresAt?: string | null;
	indexedAt?: string;
	tombstoned?: boolean;
}

async function seedVerification(opts: SeedVerificationOpts = {}): Promise<void> {
	await testEnv.DB.prepare(
		`INSERT INTO publisher_verifications
		   (issuer_did, rkey, subject_did, subject_handle, subject_display_name,
		    created_at, expires_at, record_blob, signature_metadata, verified_at,
		    indexed_at, tombstoned_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			opts.issuerDid ?? DID_B,
			opts.rkey ?? "3kaverifyrkey000",
			opts.subjectDid ?? DID_A,
			opts.handle ?? "publisher.example",
			opts.displayName ?? "Publisher",
			opts.createdAt ?? NOW.toISOString(),
			opts.expiresAt === undefined ? null : opts.expiresAt,
			new Uint8Array([0xc1, 0xc2, 0xc3]),
			JSON.stringify({ cid: "bafyverif" }),
			NOW.toISOString(),
			opts.indexedAt ?? NOW.toISOString(),
			opts.tombstoned ? NOW.toISOString() : null,
		)
		.run();
}

/** An expiry that is an hour in the past as an instant, rendered with a
 * +14:00 offset so its raw string compares lexically AFTER the current UTC
 * timestamp — the case that text comparison gets wrong. */
function offsetExpiredExp(): string {
	const instant = Date.now() - 60 * 60 * 1000;
	const local = new Date(instant + 14 * 60 * 60 * 1000);
	return local.toISOString().replace(/\.\d{3}Z$/, "+14:00");
}

describe("getPackage", () => {
	it("returns the packageView envelope for an indexed package", async () => {
		await seedPackage({ slug: "demo", latestVersion: "1.0.0" });

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			uri: `at://${DID_A}/${NSID.packageProfile}/demo`,
			cid: "bafyseed",
			did: DID_A,
			slug: "demo",
			latestVersion: "1.0.0",
			indexedAt: NOW.toISOString(),
			labels: [],
		});
		// `mirrors` is on releaseView only — assert it's NOT on packageView.
		expect(body).not.toHaveProperty("mirrors");
		const profile = body["profile"] as Record<string, unknown>;
		expect(profile["$type"]).toBe(NSID.packageProfile);
		expect(profile["id"]).toBe(`at://${DID_A}/${NSID.packageProfile}/demo`);
		expect(profile["license"]).toBe("MIT");
		expect(profile["slug"]).toBe("demo");
	});

	it("returns 404 NotFound when no row matches", async () => {
		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetPackage}?did=${DID_A}&slug=missing`,
		);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("NotFound");
	});

	it("returns 400 InvalidRequest on missing required params", async () => {
		const res = await SELF.fetch(`https://test/xrpc/${NSID.aggregatorGetPackage}?did=${DID_A}`);
		expect(res.status).toBe(400);
	});

	it("sets Cache-Control: private, no-store on success", async () => {
		await seedPackage({ slug: "demo" });
		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
		);
		expect(res.headers.get("cache-control")).toBe("private, no-store");
	});

	it("omits latestVersion when no release has been written yet", async () => {
		await seedPackage({ slug: "fresh", latestVersion: null });
		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetPackage}?did=${DID_A}&slug=fresh`,
		);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).not.toHaveProperty("latestVersion");
	});

	it("404s (redacted) when a default-accepted source's !takedown is active", async () => {
		await seedLabeler(LABELER_DID, true);
		await seedPackage({ slug: "demo" });
		await seedLabelState({ uri: packageUri("demo"), val: "!takedown" });

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
		);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("NotFound");
	});

	it("redacts even when the takedown sits beyond the 64-label wire cap", async () => {
		await seedLabeler(LABELER_DID, true);
		await seedPackage({ slug: "demo" });
		for (let i = 0; i < 64; i++) {
			await seedLabelState({ uri: packageUri("demo"), val: `note-${i}` });
		}
		await seedLabelState({ uri: packageUri("demo"), val: "!takedown" });

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
		);
		expect(res.status).toBe(404);
	});

	it("caps wire labels at 64 without affecting the response status", async () => {
		await seedLabeler(LABELER_DID, true);
		await seedPackage({ slug: "demo" });
		for (let i = 0; i < 70; i++) {
			await seedLabelState({ uri: packageUri("demo"), val: `note-${i}` });
		}

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { labels: unknown[] };
		expect(body.labels).toHaveLength(64);
	});

	it("returns 200 with the label present when the same takedown comes from a non-redact accepted source", async () => {
		await seedLabeler(UNTRUSTED_LABELER_DID, false);
		await seedPackage({ slug: "demo" });
		await seedLabelState({ uri: packageUri("demo"), val: "!takedown", src: UNTRUSTED_LABELER_DID });

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
			{ headers: { "atproto-accept-labelers": UNTRUSTED_LABELER_DID } },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { labels: Array<{ src: string; val: string }> };
		expect(body.labels).toContainEqual(
			expect.objectContaining({ src: UNTRUSTED_LABELER_DID, val: "!takedown" }),
		);
	});

	it("hydrates publisher-DID labels alongside package-URI labels", async () => {
		await seedLabeler(LABELER_DID, true);
		await seedPackage({ slug: "demo" });
		await seedLabelState({ uri: DID_A, val: "low-quality" });

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { labels: Array<{ src: string; uri: string; val: string }> };
		expect(body.labels).toContainEqual(
			expect.objectContaining({ src: LABELER_DID, uri: DID_A, val: "low-quality" }),
		);
	});

	it("only hydrates unexpired, non-negated labels", async () => {
		await seedLabeler(LABELER_DID, true);
		await seedPackage({ slug: "demo" });
		await seedLabelState({ uri: packageUri("demo"), val: "low-quality" });
		await seedLabelState({
			uri: packageUri("demo"),
			val: "broken-release",
			exp: new Date(NOW.getTime() - 60_000).toISOString(),
		});
		await seedLabelState({ uri: packageUri("demo"), val: "obfuscated-code", neg: true });

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { labels: Array<{ val: string }> };
		expect(body.labels.map((l) => l.val)).toEqual(["low-quality"]);
	});

	it("sets atproto-content-labelers when the request used the default policy", async () => {
		await seedLabeler(LABELER_DID, true);
		await seedPackage({ slug: "demo" });

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
		);
		expect(res.headers.get("atproto-content-labelers")).toBe(`${LABELER_DID};redact`);
	});

	it("hydrated labels carry only the label spec's optional fields (no sig, no neg)", async () => {
		await seedLabeler(LABELER_DID, true);
		await seedPackage({ slug: "demo" });
		await seedLabelState({ uri: packageUri("demo"), val: "low-quality", cid: null });

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
		);
		const body = (await res.json()) as { labels: Array<Record<string, unknown>> };
		expect(body.labels).toHaveLength(1);
		const label = body.labels[0]!;
		expect(label).toMatchObject({ src: LABELER_DID, uri: packageUri("demo"), val: "low-quality" });
		expect(label).toHaveProperty("cts");
		expect(label).not.toHaveProperty("cid");
		expect(label).not.toHaveProperty("exp");
		expect(label).not.toHaveProperty("sig");
		expect(label).not.toHaveProperty("neg");
		expect(label).not.toHaveProperty("ver");
	});
});

describe("getPublisher", () => {
	it("returns the publisherView envelope for an indexed publisher", async () => {
		await seedPublisher({
			displayName: "Acme Plugin Co.",
			description: "We make plugins",
			url: "https://acme.test",
			contact: [{ kind: "security", email: "security@acme.test" }],
			updatedAt: NOW.toISOString(),
		});

		const res = await SELF.fetch(`https://test/xrpc/${NSID.aggregatorGetPublisher}?did=${DID_A}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			uri: publisherUri(),
			cid: "bafypub",
			did: DID_A,
			indexedAt: NOW.toISOString(),
			labels: [],
		});
		expect(body).not.toHaveProperty("slug");
		const profile = body["profile"] as Record<string, unknown>;
		expect(profile["$type"]).toBe(NSID.publisherProfile);
		expect(profile["displayName"]).toBe("Acme Plugin Co.");
		expect(profile["contact"]).toEqual([{ kind: "security", email: "security@acme.test" }]);
	});

	it("omits optional profile fields the publisher did not set", async () => {
		await seedPublisher({
			displayName: "Minimal",
			description: null,
			url: null,
			contact: null,
			updatedAt: null,
		});
		const res = await SELF.fetch(`https://test/xrpc/${NSID.aggregatorGetPublisher}?did=${DID_A}`);
		const body = (await res.json()) as { profile: Record<string, unknown> };
		expect(body.profile).not.toHaveProperty("description");
		expect(body.profile).not.toHaveProperty("url");
		expect(body.profile).not.toHaveProperty("contact");
		expect(body.profile).not.toHaveProperty("updatedAt");
	});

	it("returns 404 NotFound when no publisher is indexed", async () => {
		const res = await SELF.fetch(`https://test/xrpc/${NSID.aggregatorGetPublisher}?did=${DID_B}`);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("NotFound");
	});

	it("returns 400 InvalidRequest when did is missing", async () => {
		const res = await SELF.fetch(`https://test/xrpc/${NSID.aggregatorGetPublisher}`);
		expect(res.status).toBe(400);
	});

	it("sets Cache-Control: private, no-store on success", async () => {
		await seedPublisher();
		const res = await SELF.fetch(`https://test/xrpc/${NSID.aggregatorGetPublisher}?did=${DID_A}`);
		expect(res.headers.get("cache-control")).toBe("private, no-store");
	});

	it("404s (redacted) when a default-accepted source's !takedown is active on the publisher DID", async () => {
		await seedLabeler(LABELER_DID, true);
		await seedPublisher();
		await seedLabelState({ uri: DID_A, val: "!takedown" });

		const res = await SELF.fetch(`https://test/xrpc/${NSID.aggregatorGetPublisher}?did=${DID_A}`);
		expect(res.status).toBe(404);
	});

	it("404s (redacted) when the !takedown is active on the profile record URI, not the DID", async () => {
		await seedLabeler(LABELER_DID, true);
		await seedPublisher();
		await seedLabelState({ uri: publisherUri(), val: "!takedown" });

		const res = await SELF.fetch(`https://test/xrpc/${NSID.aggregatorGetPublisher}?did=${DID_A}`);
		expect(res.status).toBe(404);
	});

	it("hydrates labels on the publisher profile record URI", async () => {
		await seedLabeler(LABELER_DID, true);
		await seedPublisher();
		await seedLabelState({ uri: publisherUri(), val: "unverified-publisher" });

		const res = await SELF.fetch(`https://test/xrpc/${NSID.aggregatorGetPublisher}?did=${DID_A}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { labels: Array<{ src: string; uri: string; val: string }> };
		expect(body.labels).toContainEqual(
			expect.objectContaining({
				src: LABELER_DID,
				uri: publisherUri(),
				val: "unverified-publisher",
			}),
		);
	});
});

describe("listReleases", () => {
	it("returns releases ordered by descending semver", async () => {
		await seedPackage({ slug: "demo", latestVersion: "2.0.0" });
		await seedRelease({ version: "1.0.0" });
		await seedRelease({ version: "1.10.0" });
		await seedRelease({ version: "2.0.0" });

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorListReleases}?did=${DID_A}&package=demo`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { releases: Array<{ version: string }>; cursor?: string };
		expect(body.releases.map((r) => r.version)).toEqual(["2.0.0", "1.10.0", "1.0.0"]);
		expect(body).not.toHaveProperty("cursor");
	});

	it("filters tombstoned releases", async () => {
		await seedPackage({ slug: "demo" });
		await seedRelease({ version: "1.0.0" });
		await seedRelease({ version: "1.1.0", tombstoned: true });
		await seedRelease({ version: "1.2.0" });

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorListReleases}?did=${DID_A}&package=demo`,
		);
		const body = (await res.json()) as { releases: Array<{ version: string }> };
		expect(body.releases.map((r) => r.version)).toEqual(["1.2.0", "1.0.0"]);
	});

	it("paginates via cursor", async () => {
		await seedPackage({ slug: "demo" });
		for (let i = 1; i <= 5; i++) await seedRelease({ version: `1.${i}.0` });

		const first = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorListReleases}?did=${DID_A}&package=demo&limit=2`,
		);
		const firstBody = (await first.json()) as {
			releases: Array<{ version: string }>;
			cursor: string;
		};
		expect(firstBody.releases.map((r) => r.version)).toEqual(["1.5.0", "1.4.0"]);
		expect(firstBody.cursor).toBeTruthy();

		const second = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorListReleases}?did=${DID_A}&package=demo&limit=2&cursor=${encodeURIComponent(firstBody.cursor)}`,
		);
		const secondBody = (await second.json()) as {
			releases: Array<{ version: string }>;
			cursor?: string;
		};
		expect(secondBody.releases.map((r) => r.version)).toEqual(["1.3.0", "1.2.0"]);
		expect(secondBody.cursor).toBeTruthy();
	});

	it("returns 404 when the parent package is missing", async () => {
		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorListReleases}?did=${DID_A}&package=missing`,
		);
		expect(res.status).toBe(404);
	});

	it("400s on a provided-but-malformed cursor", async () => {
		await seedPackage({ slug: "demo" });
		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorListReleases}?did=${DID_A}&package=demo&cursor=garbage!!!`,
		);
		expect(res.status).toBe(400);
	});

	it("omits a release redacted by a default-accepted source's !takedown", async () => {
		await seedLabeler(LABELER_DID, true);
		await seedPackage({ slug: "demo" });
		await seedRelease({ version: "1.0.0" });
		await seedRelease({ version: "2.0.0" });
		await seedLabelState({ uri: releaseUri("demo", "2.0.0"), val: "!takedown" });

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorListReleases}?did=${DID_A}&package=demo`,
		);
		const body = (await res.json()) as { releases: Array<{ version: string }> };
		expect(body.releases.map((r) => r.version)).toEqual(["1.0.0"]);
	});

	it("returns a blocked-but-not-redacted release with its labels intact", async () => {
		await seedLabeler(UNTRUSTED_LABELER_DID, false);
		await seedPackage({ slug: "demo" });
		await seedRelease({ version: "1.0.0" });
		await seedLabelState({
			uri: releaseUri("demo", "1.0.0"),
			val: "malware",
			src: UNTRUSTED_LABELER_DID,
		});

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorListReleases}?did=${DID_A}&package=demo`,
			{ headers: { "atproto-accept-labelers": UNTRUSTED_LABELER_DID } },
		);
		const body = (await res.json()) as {
			releases: Array<{ version: string; labels: Array<{ val: string }> }>;
		};
		expect(body.releases.map((r) => r.version)).toEqual(["1.0.0"]);
		expect(body.releases[0]!.labels).toContainEqual(
			expect.objectContaining({ src: UNTRUSTED_LABELER_DID, val: "malware" }),
		);
	});

	it("404s when the parent package carries a redacted takedown, matching getPackage", async () => {
		await seedLabeler(LABELER_DID, true);
		await seedPackage({ slug: "demo" });
		await seedRelease({ version: "1.0.0" });
		await seedRelease({ version: "2.0.0" });
		await seedLabelState({ uri: packageUri("demo"), val: "!takedown" });

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorListReleases}?did=${DID_A}&package=demo`,
		);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("NotFound");
	});

	it("pages correctly when a page has redacted omissions", async () => {
		await seedLabeler(LABELER_DID, true);
		await seedPackage({ slug: "demo" });
		await seedRelease({ version: "1.1.0" });
		await seedRelease({ version: "1.2.0" });
		await seedRelease({ version: "1.3.0" });
		await seedRelease({ version: "1.4.0" });
		// Redact the last item of what would otherwise be the first raw page
		// ([1.4.0, 1.3.0] at limit=2) — the cursor must still derive from
		// 1.3.0 (the last row actually fetched), not 1.4.0 (the last row
		// that survived the redaction filter).
		await seedLabelState({ uri: releaseUri("demo", "1.3.0"), val: "!takedown" });

		const first = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorListReleases}?did=${DID_A}&package=demo&limit=2`,
		);
		const firstBody = (await first.json()) as {
			releases: Array<{ version: string }>;
			cursor: string;
		};
		expect(firstBody.releases.map((r) => r.version)).toEqual(["1.4.0"]);
		expect(firstBody.cursor).toBeTruthy();

		const second = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorListReleases}?did=${DID_A}&package=demo&limit=2&cursor=${encodeURIComponent(firstBody.cursor)}`,
		);
		const secondBody = (await second.json()) as { releases: Array<{ version: string }> };
		expect(secondBody.releases.map((r) => r.version)).toEqual(["1.2.0", "1.1.0"]);
	});
});

describe("getLatestRelease", () => {
	it("returns the release pointed to by packages.latest_version", async () => {
		await seedPackage({ slug: "demo", latestVersion: "2.0.0" });
		await seedRelease({ version: "1.0.0" });
		await seedRelease({ version: "2.0.0" });

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetLatestRelease}?did=${DID_A}&package=demo`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["version"]).toBe("2.0.0");
		expect(body["uri"]).toBe(`at://${DID_A}/${NSID.packageRelease}/demo:2.0.0`);
	});

	it("returns 404 when ALL releases are tombstoned (or none exist)", async () => {
		await seedPackage({ slug: "demo", latestVersion: "1.0.0" });
		await seedRelease({ version: "1.0.0", tombstoned: true });

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetLatestRelease}?did=${DID_A}&package=demo`,
		);
		expect(res.status).toBe(404);
	});

	it("falls back to the next-best release when latest_version points at a tombstoned one", async () => {
		// `latest_version` was set to 2.0.0, then 2.0.0 was tombstoned but
		// `refreshPackageLatestStmt` hasn't run yet (or failed). The fast-path
		// JOIN misses; the slow-path ORDER BY should still find 1.0.0 and
		// return it instead of 404ing.
		await seedPackage({ slug: "demo", latestVersion: "2.0.0" });
		await seedRelease({ version: "1.0.0" });
		await seedRelease({ version: "2.0.0", tombstoned: true });

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetLatestRelease}?did=${DID_A}&package=demo`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["version"]).toBe("1.0.0");
	});

	it("returns 404 when no package row exists", async () => {
		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetLatestRelease}?did=${DID_A}&package=missing`,
		);
		expect(res.status).toBe(404);
	});

	it("skips a hard-blocked highest release in favour of the next-best one", async () => {
		await seedLabeler(LABELER_DID, true);
		await seedPackage({ slug: "demo", latestVersion: "2.0.0" });
		await seedRelease({ version: "1.0.0" });
		await seedRelease({ version: "2.0.0" });
		await seedLabelState({ uri: releaseUri("demo", "2.0.0"), val: "malware" });

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetLatestRelease}?did=${DID_A}&package=demo`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["version"]).toBe("1.0.0");
	});

	it("returns 404 when every release is hard-blocked", async () => {
		await seedLabeler(LABELER_DID, true);
		await seedPackage({ slug: "demo", latestVersion: "1.0.0" });
		await seedRelease({ version: "1.0.0" });
		await seedLabelState({ uri: releaseUri("demo", "1.0.0"), val: "malware" });

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetLatestRelease}?did=${DID_A}&package=demo`,
		);
		expect(res.status).toBe(404);
	});

	it("respects packages.latest_version via the fast path when the accepted policy is empty, even with block labels elsewhere", async () => {
		await seedLabeler(LABELER_DID, true);
		await seedPackage({ slug: "demo", latestVersion: "1.0.0" });
		await seedRelease({ version: "1.0.0" });
		await seedRelease({ version: "2.0.0" });
		// A hard-block label exists, and would exclude 2.0.0 under the
		// authoritative path — but the empty explicit header disables
		// enforcement entirely, so this should never be consulted.
		await seedLabelState({ uri: releaseUri("demo", "2.0.0"), val: "malware" });

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetLatestRelease}?did=${DID_A}&package=demo`,
			{ headers: { "atproto-accept-labelers": "" } },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["version"]).toBe("1.0.0");
	});

	it("returns 404 on a package-cascade block even when the release itself carries no label", async () => {
		await seedLabeler(LABELER_DID, true);
		await seedPackage({ slug: "demo", latestVersion: "1.0.0" });
		await seedRelease({ version: "1.0.0" });
		await seedLabelState({ uri: packageUri("demo"), val: "!takedown" });

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetLatestRelease}?did=${DID_A}&package=demo`,
		);
		expect(res.status).toBe(404);
	});

	it("ignores a release-scope label whose CID no longer matches the current release", async () => {
		await seedLabeler(LABELER_DID, true);
		await seedPackage({ slug: "demo", latestVersion: "1.0.0" });
		await seedRelease({ version: "1.0.0", cid: "bafcurrent" });
		await seedLabelState({
			uri: releaseUri("demo", "1.0.0"),
			val: "malware",
			cid: "bafstale",
		});

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetLatestRelease}?did=${DID_A}&package=demo`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["version"]).toBe("1.0.0");
	});
});

describe("searchPackages", () => {
	it("returns FTS-matched packages", async () => {
		await seedPackage({ slug: "gallery", name: "Gallery Plugin", description: "image gallery" });
		await seedPackage({ slug: "form", name: "Form Plugin", description: "form builder" });

		const res = await SELF.fetch(`https://test/xrpc/${NSID.aggregatorSearchPackages}?q=gallery`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { packages: Array<{ slug: string }> };
		expect(body.packages.map((p) => p.slug)).toContain("gallery");
		expect(body.packages.map((p) => p.slug)).not.toContain("form");
	});

	it("returns all packages ordered by last_updated DESC when q is empty", async () => {
		await seedPackage({ slug: "alpha" });
		await seedPackage({ slug: "beta" });
		const res = await SELF.fetch(`https://test/xrpc/${NSID.aggregatorSearchPackages}`);
		const body = (await res.json()) as { packages: Array<{ slug: string }> };
		expect(body.packages.map((p) => p.slug).toSorted()).toEqual(["alpha", "beta"]);
	});

	it("paginates via offset cursor", async () => {
		for (let i = 0; i < 5; i++) await seedPackage({ slug: `pkg${i}` });

		const first = await SELF.fetch(`https://test/xrpc/${NSID.aggregatorSearchPackages}?limit=2`);
		const firstBody = (await first.json()) as {
			packages: Array<{ slug: string }>;
			cursor: string;
		};
		expect(firstBody.packages).toHaveLength(2);
		expect(firstBody.cursor).toBeTruthy();

		const second = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorSearchPackages}?limit=2&cursor=${encodeURIComponent(firstBody.cursor)}`,
		);
		const secondBody = (await second.json()) as { packages: Array<{ slug: string }> };
		expect(secondBody.packages).toHaveLength(2);
		// Distinct from page 1 — seeded slugs don't overlap.
		const overlap = firstBody.packages
			.map((p) => p.slug)
			.filter((s) => secondBody.packages.some((p) => p.slug === s));
		expect(overlap).toEqual([]);
	});

	it("hides a package with an active default-accepted !takedown label", async () => {
		await seedLabeler(LABELER_DID, true);
		await seedPackage({ slug: "risky" });
		await seedPackage({ slug: "safe" });
		await seedLabelState({ uri: packageUri("risky"), val: "!takedown" });

		const res = await SELF.fetch(`https://test/xrpc/${NSID.aggregatorSearchPackages}`);
		const body = (await res.json()) as { packages: Array<{ slug: string }> };
		expect(body.packages.map((p) => p.slug)).toEqual(["safe"]);
	});

	it("does not hide a package whose takedown expired, even when the raw exp string compares lexically after now", async () => {
		await seedLabeler(LABELER_DID, true);
		await seedPackage({ slug: "recovered" });
		await seedLabelState({
			uri: packageUri("recovered"),
			val: "!takedown",
			exp: offsetExpiredExp(),
		});

		const res = await SELF.fetch(`https://test/xrpc/${NSID.aggregatorSearchPackages}`);
		const body = (await res.json()) as { packages: Array<{ slug: string }> };
		expect(body.packages.map((p) => p.slug)).toEqual(["recovered"]);
	});

	it("ignores blocking labels from a source outside the accepted policy", async () => {
		// Configured but untrusted — the missing-header default only picks up
		// `trusted = 1` labelers, so this source's label doesn't enforce.
		await seedLabeler(LABELER_DID, false);
		await seedPackage({ slug: "demo" });
		await seedLabelState({ uri: packageUri("demo"), val: "!takedown" });

		const res = await SELF.fetch(`https://test/xrpc/${NSID.aggregatorSearchPackages}`);
		const body = (await res.json()) as { packages: Array<{ slug: string }> };
		expect(body.packages.map((p) => p.slug)).toEqual(["demo"]);
	});

	it("enforces a takedown from an explicitly accepted untrusted source", async () => {
		await seedLabeler(UNTRUSTED_LABELER_DID, false);
		await seedPackage({ slug: "demo" });
		await seedLabelState({
			uri: packageUri("demo"),
			val: "!takedown",
			src: UNTRUSTED_LABELER_DID,
		});

		const res = await SELF.fetch(`https://test/xrpc/${NSID.aggregatorSearchPackages}`, {
			headers: { "atproto-accept-labelers": UNTRUSTED_LABELER_DID },
		});
		const body = (await res.json()) as { packages: Array<{ slug: string }> };
		expect(body.packages.map((p) => p.slug)).toEqual([]);
	});

	it("disables enforcement and skips hydration with an explicit empty header", async () => {
		await seedLabeler(LABELER_DID, true);
		await seedPackage({ slug: "demo" });
		await seedLabelState({ uri: packageUri("demo"), val: "!takedown" });

		const res = await SELF.fetch(`https://test/xrpc/${NSID.aggregatorSearchPackages}`, {
			headers: { "atproto-accept-labelers": "" },
		});
		const body = (await res.json()) as { packages: Array<{ slug: string; labels: unknown[] }> };
		expect(body.packages.map((p) => p.slug)).toEqual(["demo"]);
		expect(body.packages[0]!.labels).toEqual([]);
	});

	it("does not hide a package whose label is CID-bound to a stale CID", async () => {
		await seedLabeler(LABELER_DID, true);
		await seedPackage({ slug: "demo", cid: "bafcurrent" });
		await seedLabelState({ uri: packageUri("demo"), val: "!takedown", cid: "bafstale" });

		const res = await SELF.fetch(`https://test/xrpc/${NSID.aggregatorSearchPackages}`);
		const body = (await res.json()) as { packages: Array<{ slug: string }> };
		expect(body.packages.map((p) => p.slug)).toEqual(["demo"]);
	});

	it("hides every package under a publisher DID with an active takedown", async () => {
		await seedLabeler(LABELER_DID, true);
		await seedPackage({ did: DID_A, slug: "a1" });
		await seedPackage({ did: DID_A, slug: "a2" });
		await seedPackage({ did: DID_B, slug: "b1" });
		await seedLabelState({ uri: DID_A, val: "!takedown" });

		const res = await SELF.fetch(`https://test/xrpc/${NSID.aggregatorSearchPackages}`);
		const body = (await res.json()) as { packages: Array<{ slug: string }> };
		expect(body.packages.map((p) => p.slug)).toEqual(["b1"]);
	});

	it("hides a package with an active publisher-compromised label", async () => {
		await seedLabeler(LABELER_DID, true);
		await seedPackage({ slug: "demo" });
		await seedLabelState({ uri: packageUri("demo"), val: "publisher-compromised" });

		const res = await SELF.fetch(`https://test/xrpc/${NSID.aggregatorSearchPackages}`);
		const body = (await res.json()) as { packages: Array<{ slug: string }> };
		expect(body.packages.map((p) => p.slug)).toEqual([]);
	});

	it("doesn't blow up on FTS-unsafe query chars (defensive quoting)", async () => {
		await seedPackage({ slug: "demo", name: "Demo" });
		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorSearchPackages}?q=${encodeURIComponent('demo "*"(')}`,
		);
		// Either matches nothing or matches normally — but doesn't 500.
		expect(res.status).toBe(200);
	});

	it("treats FTS operators as literal tokens (the escape actually works)", async () => {
		await seedPackage({ slug: "alpha", name: "Alpha" });
		await seedPackage({ slug: "beta", name: "Beta" });
		// `alpha OR beta` would match both packages if `OR` were interpreted
		// as the FTS5 operator. With proper escaping the whole string is one
		// literal phrase that can't possibly appear in either record's
		// indexed text → zero matches. A buggy escape that stripped the
		// quotes would return *both* packages.
		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorSearchPackages}?q=${encodeURIComponent("alpha OR beta")}`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { packages: Array<{ slug: string }> };
		expect(body.packages).toEqual([]);
	});

	it("400s on a provided-but-malformed cursor (no silent restart)", async () => {
		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorSearchPackages}?cursor=not-a-valid-cursor`,
		);
		expect(res.status).toBe(400);
	});

	it("400s on a forged cursor with an out-of-range offset", async () => {
		// Encode {offset: 1_000_000} → over MAX_OFFSET → 400.
		const forged = btoa(JSON.stringify({ offset: 1_000_000 }))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorSearchPackages}?cursor=${forged}`,
		);
		expect(res.status).toBe(400);
	});
});

describe("sync.getRecord", () => {
	const PATH = "/xrpc/com.atproto.sync.getRecord";

	it("returns CAR bytes for an indexed package profile", async () => {
		await seedPackage({ slug: "demo", carBytes: new Uint8Array([0x11, 0x22, 0x33]) });
		const res = await SELF.fetch(
			`https://test${PATH}?did=${DID_A}&collection=${NSID.packageProfile}&rkey=demo`,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/vnd.ipld.car");
		expect(res.headers.get("cache-control")).toBe("public, max-age=300");
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect([...bytes]).toEqual([0x11, 0x22, 0x33]);
	});

	it("returns CAR bytes for an indexed release", async () => {
		await seedPackage({ slug: "demo" });
		await seedRelease({ version: "1.0.0", carBytes: new Uint8Array([0x44, 0x55]) });
		const res = await SELF.fetch(
			`https://test${PATH}?did=${DID_A}&collection=${NSID.packageRelease}&rkey=demo:1.0.0`,
		);
		expect(res.status).toBe(200);
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect([...bytes]).toEqual([0x44, 0x55]);
	});

	it("returns 404 for a tombstoned release", async () => {
		await seedPackage({ slug: "demo" });
		await seedRelease({ version: "1.0.0", tombstoned: true });
		const res = await SELF.fetch(
			`https://test${PATH}?did=${DID_A}&collection=${NSID.packageRelease}&rkey=demo:1.0.0`,
		);
		expect(res.status).toBe(404);
	});

	it("returns 404 for an unknown rkey", async () => {
		const res = await SELF.fetch(
			`https://test${PATH}?did=${DID_A}&collection=${NSID.packageProfile}&rkey=does-not-exist`,
		);
		expect(res.status).toBe(404);
	});

	it("returns 400 InvalidRequest on missing query params", async () => {
		const res = await SELF.fetch(`https://test${PATH}?did=${DID_A}`);
		expect(res.status).toBe(400);
	});

	it("returns 400 on a malformed DID", async () => {
		const res = await SELF.fetch(
			`https://test${PATH}?did=not-a-did&collection=${NSID.packageProfile}&rkey=demo`,
		);
		expect(res.status).toBe(400);
	});

	it("returns HEAD with content-length but no body", async () => {
		await seedPackage({ slug: "demo", carBytes: new Uint8Array([0x11, 0x22, 0x33]) });
		const res = await SELF.fetch(
			`https://test${PATH}?did=${DID_A}&collection=${NSID.packageProfile}&rkey=demo`,
			{ method: "HEAD" },
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-length")).toBe("3");
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect(bytes.byteLength).toBe(0);
	});

	it("rejects non-GET/HEAD methods with 405", async () => {
		const res = await SELF.fetch(
			`https://test${PATH}?did=${DID_A}&collection=${NSID.packageProfile}&rkey=demo`,
			{ method: "POST" },
		);
		expect(res.status).toBe(405);
		expect(res.headers.get("allow")).toBe("GET, HEAD");
	});

	it("only matches publisher.profile when rkey='self'", async () => {
		// publisher.profile rkey is always 'self'; any other rkey returns 404
		// even if the (did) row exists.
		await testEnv.DB.prepare(
			`INSERT INTO publishers
			   (did, display_name, record_blob, verified_at, indexed_at)
			 VALUES (?, ?, ?, ?, ?)`,
		)
			.bind(DID_B, "Pub", new Uint8Array([0x99]), NOW.toISOString(), NOW.toISOString())
			.run();
		const wrongRkey = await SELF.fetch(
			`https://test${PATH}?did=${DID_B}&collection=${NSID.publisherProfile}&rkey=other`,
		);
		expect(wrongRkey.status).toBe(404);
		const correctRkey = await SELF.fetch(
			`https://test${PATH}?did=${DID_B}&collection=${NSID.publisherProfile}&rkey=self`,
		);
		expect(correctRkey.status).toBe(200);
	});
});

describe("XRPC dispatcher", () => {
	it("returns 404 on non-XRPC paths", async () => {
		const res = await SELF.fetch("https://test/some/random/path");
		expect(res.status).toBe(404);
	});

	it("returns 404 on unknown XRPC NSIDs", async () => {
		const res = await SELF.fetch("https://test/xrpc/com.example.notARealEndpoint");
		expect(res.status).toBe(404);
	});
});

describe("XRPC dispatcher — unexpected policy-resolution failure", () => {
	// A non-XRPC throw before dispatch (here: a D1 error because `labelers`
	// is gone) must still take the CORS + `no-store` wrapper, not escape to
	// workerd's bare 500. Capture the table's schema so the shared beforeEach
	// (`DELETE FROM labelers`) keeps working after a test drops it.
	let labelersSchema: string;
	beforeAll(async () => {
		const row = await testEnv.DB.prepare(
			"SELECT sql FROM sqlite_master WHERE type='table' AND name='labelers'",
		).first<{ sql: string }>();
		labelersSchema = row!.sql;
	});
	afterEach(async () => {
		const exists = await testEnv.DB.prepare(
			"SELECT 1 FROM sqlite_master WHERE type='table' AND name='labelers'",
		).first();
		if (!exists) await testEnv.DB.prepare(labelersSchema).run();
	});

	it("wraps a non-XRPC failure in a 500 carrying CORS + no-store and no leaked internals", async () => {
		await seedPackage({ slug: "demo" });
		// Resolving the default policy runs `SELECT did FROM labelers`; dropping
		// the table makes that throw a non-XRPC D1 error before dispatch.
		await testEnv.DB.prepare("DROP TABLE labelers").run();

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
		);
		expect(res.status).toBe(500);
		expect(res.headers.get("cache-control")).toBe("private, no-store");
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
		const body = (await res.json()) as { error: string; message?: string };
		expect(body.error).toBe("InternalServerError");
		// No internal detail (SQL text, table name, stack) leaks to the client.
		expect(JSON.stringify(body)).not.toMatch(/labelers|no such table|SQL|SELECT/i);
	});
});

describe("getPublisherVerification", () => {
	it("returns the verification claims naming a DID as subject, newest first", async () => {
		await seedVerification({
			issuerDid: DID_B,
			rkey: "3kolder000000000",
			createdAt: "2026-01-01T00:00:00.000Z",
			handle: "pub.example",
			displayName: "Pub",
		});
		await seedVerification({
			issuerDid: DID_B,
			rkey: "3knewer000000000",
			createdAt: "2026-03-01T00:00:00.000Z",
			handle: "pub.example",
			displayName: "Pub",
			expiresAt: "2027-01-01T00:00:00.000Z",
		});

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetPublisherVerification}?did=${DID_A}`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			did: string;
			labels: unknown[];
			verifications: Array<Record<string, unknown>>;
		};
		expect(body.did).toBe(DID_A);
		expect(body.labels).toEqual([]);
		expect(body.verifications).toHaveLength(2);
		// created_at DESC — the March claim comes first.
		expect(body.verifications[0]).toMatchObject({
			issuer: DID_B,
			handle: "pub.example",
			displayName: "Pub",
			createdAt: "2026-03-01T00:00:00.000Z",
			expiresAt: "2027-01-01T00:00:00.000Z",
			indexedAt: NOW.toISOString(),
		});
		// The older claim has no expiry — expiresAt is omitted, not null.
		expect(body.verifications[1]).not.toHaveProperty("expiresAt");
	});

	it("returns an empty verifications array for a DID with no claims (not a 404)", async () => {
		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetPublisherVerification}?did=${DID_A}`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { did: string; verifications: unknown[] };
		expect(body.verifications).toEqual([]);
	});

	it("excludes tombstoned claims", async () => {
		await seedVerification({ rkey: "3klive0000000000" });
		await seedVerification({ rkey: "3kdead0000000000", tombstoned: true });

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetPublisherVerification}?did=${DID_A}`,
		);
		const body = (await res.json()) as { verifications: unknown[] };
		expect(body.verifications).toHaveLength(1);
	});

	it("returns 400 InvalidRequest when the did param is missing", async () => {
		const res = await SELF.fetch(`https://test/xrpc/${NSID.aggregatorGetPublisherVerification}`);
		expect(res.status).toBe(400);
	});

	it("sets Cache-Control: private, no-store on success", async () => {
		await seedVerification();
		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetPublisherVerification}?did=${DID_A}`,
		);
		expect(res.headers.get("cache-control")).toBe("private, no-store");
	});

	it("404s (redacted) when a default-accepted source's !takedown covers the DID", async () => {
		await seedLabeler(LABELER_DID, true);
		await seedVerification();
		await seedLabelState({ uri: DID_A, val: "!takedown" });

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetPublisherVerification}?did=${DID_A}`,
		);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("NotFound");
	});

	it("serves the view unfiltered for a blank accept-labelers header despite an active takedown", async () => {
		await seedLabeler(LABELER_DID, true);
		await seedVerification();
		await seedLabelState({ uri: DID_A, val: "!takedown" });

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetPublisherVerification}?did=${DID_A}`,
			{ headers: { "atproto-accept-labelers": "" } },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { verifications: unknown[]; labels: unknown[] };
		expect(body.verifications).toHaveLength(1);
		expect(body.labels).toEqual([]);
	});

	it("drops a claim whose issuer is redacted for a default-policy caller, keeping the others", async () => {
		const redactedIssuer = "did:plc:issuertakedown00000000000";
		const okIssuer = "did:plc:issuerok0000000000000000";
		await seedLabeler(LABELER_DID, true);
		await seedVerification({ issuerDid: redactedIssuer, rkey: "3kredacted000000" });
		await seedVerification({ issuerDid: okIssuer, rkey: "3kok000000000000" });
		// Takedown is on the ISSUER's DID, not the subject's.
		await seedLabelState({ uri: redactedIssuer, val: "!takedown" });

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetPublisherVerification}?did=${DID_A}`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { verifications: Array<{ issuer: string }> };
		// The subject is not redacted, so the view is served; only the
		// redacted-issuer claim is filtered out.
		expect(body.verifications).toHaveLength(1);
		expect(body.verifications[0]?.issuer).toBe(okIssuer);
	});

	it("keeps a redacted-issuer claim for a blank accept-labelers caller (internal unfiltered read)", async () => {
		const redactedIssuer = "did:plc:issuertakedown00000000000";
		const okIssuer = "did:plc:issuerok0000000000000000";
		await seedLabeler(LABELER_DID, true);
		await seedVerification({ issuerDid: redactedIssuer, rkey: "3kredacted000000" });
		await seedVerification({ issuerDid: okIssuer, rkey: "3kok000000000000" });
		await seedLabelState({ uri: redactedIssuer, val: "!takedown" });

		const res = await SELF.fetch(
			`https://test/xrpc/${NSID.aggregatorGetPublisherVerification}?did=${DID_A}`,
			{ headers: { "atproto-accept-labelers": "" } },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { verifications: Array<{ issuer: string }> };
		// Empty accepted set → nothing redacted → the labeler sees both claims.
		expect(body.verifications).toHaveLength(2);
		expect(body.verifications.map((v) => v.issuer).toSorted()).toEqual(
			[okIssuer, redactedIssuer].toSorted(),
		);
	});
});
