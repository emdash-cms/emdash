/**
 * Smoke test for the aggregator's test infrastructure.
 *
 * Proves the workers-pool wiring is healthy: migrations apply into the test
 * D1 instance, the schema accepts a write, and the worker module loads. No
 * business logic is exercised — the actual ingest and read paths are tested
 * in their own files as later PRs land them.
 *
 * If this test fails after a migration change, fix the migration; the rest
 * of the suite assumes this passes.
 */

import { INITIAL_LISTING_POLICY_FIXTURE } from "@emdash-cms/registry-moderation/fixtures";
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { publicHealth } from "../src/public-health.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("aggregator scaffold smoke test", () => {
	it("exposes public readiness without caching the result", async () => {
		const response = await SELF.fetch("https://test/health");

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		await expect(response.json()).resolves.toEqual({
			service: "emdash-aggregator",
			status: "ok",
			policyMode: "open",
			projection: {
				ready: true,
				packages: 0,
				releases: 0,
			},
			labelSources: {
				replayPending: 0,
			},
		});
	});

	it("fails readiness while an authoritative label source needs replay", async () => {
		const now = new Date().toISOString();
		await testEnv.DB.prepare(
			`INSERT INTO labellers
			   (did, endpoint, signing_key, signing_key_id, trusted, added_at, last_resolved_at,
			    active, required_positive, accepted_state, redaction, policy_version,
			    replay_pending)
			 VALUES (?, ?, '', '', 0, ?, ?, 1, 1, 1, 1, ?, 1)`,
		)
			.bind(
				"did:web:labels.emdashcms.com",
				"https://labels.emdashcms.com",
				now,
				now,
				INITIAL_LISTING_POLICY_FIXTURE.policyVersion,
			)
			.run();
		const runtimeEnv = {
			...env,
			DB: testEnv.DB,
			LISTING_POLICY_MODE: "projection",
			LISTING_ALLOWLIST: "[]",
			LISTING_MODERATION_POLICY: JSON.stringify(INITIAL_LISTING_POLICY_FIXTURE),
		} as Env;

		const response = await publicHealth(new Request("https://test/health"), runtimeEnv);

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toMatchObject({
			status: "not-ready",
			policyMode: "projection",
			projection: { ready: false, packages: 0, releases: 0 },
			labelSources: { replayPending: 1 },
		});
	});

	it("applies the initial migration and round-trips a packages row", async () => {
		const now = new Date().toISOString();
		await testEnv.DB.prepare(
			`INSERT INTO packages (
				did, slug, type, license, authors, security, record_blob, verified_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				"did:plc:test",
				"smoke",
				"emdash-plugin",
				"MIT",
				JSON.stringify([{ name: "Tester" }]),
				JSON.stringify([{ email: "x@y.test" }]),
				new Uint8Array([0x00]),
				now,
			)
			.run();

		const row = await testEnv.DB.prepare(
			"SELECT did, slug, license FROM packages WHERE did = ? AND slug = ?",
		)
			.bind("did:plc:test", "smoke")
			.first<{ did: string; slug: string; license: string }>();

		expect(row).not.toBeNull();
		expect(row?.license).toBe("MIT");
	});

	it("populates packages_fts on insert via trigger", async () => {
		const now = new Date().toISOString();
		await testEnv.DB.prepare(
			`INSERT INTO packages (
				did, slug, type, name, description, license, authors, security, record_blob, verified_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				"did:plc:fts",
				"searchable",
				"emdash-plugin",
				"A Searchable Plugin",
				"Does something searchable",
				"MIT",
				JSON.stringify([{ name: "Tester" }]),
				JSON.stringify([{ email: "x@y.test" }]),
				new Uint8Array([0x00]),
				now,
			)
			.run();

		const result = await testEnv.DB.prepare(
			"SELECT p.slug FROM packages_fts JOIN packages p ON p.rowid = packages_fts.rowid WHERE packages_fts MATCH ?",
		)
			.bind("searchable")
			.first<{ slug: string }>();

		expect(result?.slug).toBe("searchable");
	});

	it("rejects a release whose did/package does not match an existing profile (FK)", async () => {
		// Releases reference packages via composite FK; SQLite enforces this when
		// FK checks are enabled. workers-pool's miniflare D1 has FK checks on by
		// default per Cloudflare's runtime configuration.
		const now = new Date().toISOString();
		const insertOrphan = testEnv.DB.prepare(
			`INSERT INTO releases (
				did, package, version, rkey, version_sort, artifacts, emdash_extension, cts, record_blob, verified_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				"did:plc:orphan",
				"nonexistent",
				"1.0.0",
				"nonexistent:1.0.0",
				"00000000001.00000000000.00000000000.zzz",
				"{}",
				"{}",
				now,
				new Uint8Array([0x00]),
				now,
			)
			.run();

		await expect(insertOrphan).rejects.toThrow();
	});
});
