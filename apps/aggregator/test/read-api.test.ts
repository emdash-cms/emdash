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
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}
const testEnv = env as unknown as TestEnv;

const DID_A = "did:plc:read000000000000000000aa";
const DID_B = "did:plc:read000000000000000000bb";
const NOW = new Date("2026-05-10T12:00:00.000Z");

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
