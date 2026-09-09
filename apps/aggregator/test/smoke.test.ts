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
import { beforeAll, describe, expect, it, vi } from "vitest";

import { stageLabelSourceReplay } from "../src/label-source-health.js";
import { getListingPolicy } from "../src/listing-policy.js";
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
	it("reuses a recent readiness snapshot across repeated probes", async () => {
		let sessions = 0;
		const db = new Proxy(env.DB, {
			get(target, property, receiver) {
				if (property !== "withSession") return Reflect.get(target, property, receiver);
				return (...args: Parameters<D1Database["withSession"]>) => {
					sessions++;
					return target.withSession(...args);
				};
			},
		});
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests override generated literal var bindings
		const runtimeEnv = {
			...env,
			DB: db,
			LISTING_POLICY_MODE: "open",
			LISTING_ALLOWLIST: "[]",
			LISTING_MODERATION_POLICY: JSON.stringify(INITIAL_LISTING_POLICY_FIXTURE),
		} as unknown as Env;

		await publicHealth(new Request("https://test/health"), runtimeEnv);
		await publicHealth(new Request("https://test/health"), runtimeEnv);

		expect(sessions).toBe(1);
	});

	it("exposes public readiness without cacheable response headers", async () => {
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
		});
	});

	it("fails readiness while an authoritative label source needs replay", async () => {
		const observedAt = new Date();
		const now = observedAt.toISOString();
		const source = "did:web:labels.emdashcms.com";
		const moderationPolicy = {
			...INITIAL_LISTING_POLICY_FIXTURE,
			requiredPositiveSources: [source],
			acceptedStateSources: [source],
			redactionSources: [source],
		};
		await testEnv.DB.prepare(
			`INSERT INTO labellers
			   (did, endpoint, signing_key, signing_key_id, trusted, added_at, last_resolved_at,
			    active, required_positive, accepted_state, redaction, policy_version,
			    replay_pending, health_last_success_at, health_last_success_epoch)
			 VALUES (?, ?, '', '', 1, ?, ?, 1, 1, 1, 1, ?, 0, ?, ?)`,
		)
			.bind(
				source,
				"https://labels.emdashcms.com",
				now,
				now,
				INITIAL_LISTING_POLICY_FIXTURE.policyVersion,
				now,
				observedAt.getTime(),
			)
			.run();
		const runtimeEnv = {
			...env,
			DB: testEnv.DB,
			LISTING_POLICY_MODE: "projection",
			LISTING_ALLOWLIST: "[]",
			LISTING_MODERATION_POLICY: JSON.stringify(moderationPolicy),
		} as Env;
		const policy = await getListingPolicy(runtimeEnv);
		const control = await testEnv.DB.prepare(
			"SELECT source_epoch FROM listing_projection_control WHERE id = 1",
		).first<{ source_epoch: number }>();
		if (!control) throw new Error("listing projection control row is missing");
		const generation = "healthy-before-replay";
		await testEnv.DB.prepare(
			`INSERT INTO public_projection_generations
			   (generation, policy_mode, policy_version, policy_hash,
			    required_positive_sources, accepted_state_sources, redaction_sources,
			    source_epoch, rebuild_sequence, created_at, completed_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
		)
			.bind(
				generation,
				policy.mode,
				policy.moderationPolicyVersion,
				policy.moderationPolicyHash,
				policy.requiredPositiveSourcesJson,
				policy.acceptedStateSourcesJson,
				policy.redactionSourcesJson,
				control.source_epoch,
				now,
				now,
			)
			.run();
		await testEnv.DB.prepare(
			"UPDATE public_projection_state SET active_generation = ?, updated_at = ? WHERE id = 1",
		)
			.bind(generation, now)
			.run();
		const cacheTime = Date.now();
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(cacheTime);
		expect((await publicHealth(new Request("https://test/health"), runtimeEnv)).status).toBe(200);

		await stageLabelSourceReplay(testEnv.DB, source, observedAt);
		dateNow.mockReturnValue(cacheTime + 5_001);

		const response = await publicHealth(new Request("https://test/health"), runtimeEnv);
		dateNow.mockRestore();

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toMatchObject({
			status: "not-ready",
			policyMode: "projection",
			projection: { ready: false, packages: 0, releases: 0 },
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
