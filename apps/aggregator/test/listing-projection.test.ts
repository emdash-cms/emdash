import { NSID } from "@emdash-cms/registry-lexicons";
import type { ListingModerationPolicy } from "@emdash-cms/registry-moderation";
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { RecordsJob } from "../src/env.js";
import { readLabelCursor } from "../src/label-ingestion.js";
import {
	enforceRequiredLabelSourceHealth,
	markLabelSourceHealthy,
	REQUIRED_LABEL_SOURCE_HEALTH_TIMEOUT_MS,
	stageLabelSourceReplay,
} from "../src/label-source-health.js";
import {
	activateLabelSourceAfterReplay,
	readLabelSourceTrust,
} from "../src/label-source-policy.js";
import { upsertHydratedLabelState } from "../src/label-state.js";
import { isCurrentSubject, listCurrentSubjects } from "../src/labeler-reconciliation-service.js";
import {
	getListingPolicy,
	packageProfileUri,
	type ListingPolicyMode,
} from "../src/listing-policy.js";
import type { VerifiedPdsRecord } from "../src/pds-verify.js";
import { enforcePublicProjectionPolicy } from "../src/projection-enforcement.js";
import { rebuildPublicProjection, StaleProjectionRebuildError } from "../src/public-projection.js";
import {
	applyDelete,
	ingestPackageProfile,
	ingestPackageRelease,
} from "../src/records-consumer.js";
import { handleXrpc } from "../src/routes/xrpc/router.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}
const testEnv = env as unknown as TestEnv;

const DID_A = "did:plc:projection000000000000aa";
const DID_B = "did:plc:projection000000000000bb";
const LABELER_DID = "did:plc:labeler000000000000000aa";
const PROFILE_CID_1 = "bafyreiabaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibae";
const PROFILE_CID_2 = "bafyreiadambqgaydambqgaydambqgaydambqgaydambqgaydambqgaydam";
const RELEASE_CID_1 = "bafyreiacaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcai";
const RELEASE_CID_2 = "bafyreigh2akiscaildc4mscz4uzpcbap5jxg26eecmrf6cmnvkzkjmoixe";
const PENDING_PROFILE_CID = "bafyreidjv6bgt6jlqsi2jl7ezijrkwfurtrsp6jtpm5nol4y7mtnpzjzr4";
const PENDING_RELEASE_CID = "bafyreigqlqgt5yvojkoox6shh33bcnbab2g6z6ygtbbl5es6eys5jlp6ae";
const NOW = new Date("2026-08-24T10:00:00.000Z");

const moderationPolicy: ListingModerationPolicy = {
	schemaVersion: 1,
	policyVersion: "listing-test-v1",
	effectiveAt: "2026-08-01T00:00:00.000Z",
	requiredPositiveSources: [LABELER_DID],
	acceptedStateSources: [LABELER_DID],
	redactionSources: [LABELER_DID],
	autoPass: "disabled",
	prohibitedCategories: [],
};

let upgradeEvidence: {
	revisionCount: number;
	currentCid: string | null;
	invalidExpiryEpoch: number | null;
};

beforeAll(async () => {
	const migrations = testEnv.TEST_MIGRATIONS;
	expect(migrations.map((migration) => migration.name)).toEqual([
		"0001_init.sql",
		"0002_indexed_at.sql",
		"0003_listing_projection.sql",
		"0004_signed_label_ingest.sql",
		"0005_restrictive_label_authority.sql",
	]);
	await applyD1Migrations(testEnv.DB, migrations.slice(0, 2));
	await testEnv.DB.prepare(
		`INSERT INTO packages
		   (did, slug, type, name, description, license, authors, security, keywords,
		    sections, last_updated, latest_version, capabilities, record_blob,
		    signature_metadata, verified_at, indexed_at)
		 VALUES (?, 'legacy', 'emdash-plugin', 'Legacy', NULL, 'MIT', '[]', '[]',
		         NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
	)
		.bind(
			DID_A,
			new Uint8Array([1, 2, 3]),
			JSON.stringify({ cid: PROFILE_CID_1 }),
			NOW.toISOString(),
			NOW.toISOString(),
		)
		.run();
	await testEnv.DB.prepare(
		`INSERT INTO label_state (src, uri, val, cid, neg, cts, exp, trusted)
		 VALUES (?, ?, 'listing-passed', ?, 0, ?, '2026-02-30T11:00:00Z', 1)`,
	)
		.bind(LABELER_DID, packageProfileUri(DID_A, "legacy"), PROFILE_CID_1, NOW.toISOString())
		.run();
	await applyD1Migrations(testEnv.DB, migrations.slice(2));

	const projectionMigration = migrations[2];
	if (!projectionMigration) throw new Error("projection migration fixture missing");
	await applyD1Migrations(testEnv.DB, [projectionMigration], "projection_restart_probe");

	const revision = await testEnv.DB.prepare(
		`SELECT COUNT(*) AS revision_count,
		        (SELECT current_cid FROM package_profile_heads
		         WHERE did = ? AND slug = 'legacy') AS current_cid
		 FROM package_profile_revisions
		 WHERE did = ? AND slug = 'legacy'`,
	)
		.bind(DID_A, DID_A)
		.first<{ revision_count: number; current_cid: string | null }>();
	upgradeEvidence = {
		revisionCount: revision?.revision_count ?? 0,
		currentCid: revision?.current_cid ?? null,
		invalidExpiryEpoch:
			(
				await testEnv.DB.prepare(
					`SELECT exp_epoch FROM listing_label_state_expiry
					 WHERE src = ? AND uri = ? AND val = 'listing-passed'`,
				)
					.bind(LABELER_DID, packageProfileUri(DID_A, "legacy"))
					.first<{ exp_epoch: number | null }>()
			)?.exp_epoch ?? null,
	};
});

beforeEach(async () => {
	await testEnv.DB.prepare(`UPDATE public_projection_state SET active_generation = NULL`).run();
	for (const table of [
		"listing_label_stream_coordinates",
		"listing_labels",
		"public_releases",
		"public_packages",
		"public_projection_generations",
		"label_state",
		"labellers",
		"labels",
		"release_duplicate_attempts",
		"releases",
		"packages",
		"package_profile_heads",
		"package_profile_revisions",
	]) {
		await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
	}
});

describe("revision migration and ingest", () => {
	it("backfills exactly once and is safe to replay", () => {
		expect(upgradeEvidence).toEqual({
			revisionCount: 1,
			currentCid: PROFILE_CID_1,
			invalidExpiryEpoch: null,
		});
	});

	it("retains each verified profile CID before moving the current pointer", async () => {
		await seedProfile({ cid: PROFILE_CID_1, name: "First", at: NOW });
		await seedProfile({
			cid: PROFILE_CID_2,
			name: "Second",
			at: new Date("2026-08-24T10:01:00.000Z"),
		});

		const rows = await testEnv.DB.prepare(
			`SELECT cid, name FROM package_profile_revisions
			 WHERE did = ? AND slug = 'demo' ORDER BY observed_at`,
		)
			.bind(DID_A)
			.all<{ cid: string; name: string }>();
		expect(rows.results).toEqual([
			{ cid: PROFILE_CID_1, name: "First" },
			{ cid: PROFILE_CID_2, name: "Second" },
		]);
		const head = await testEnv.DB.prepare(
			`SELECT current_cid FROM package_profile_heads WHERE did = ? AND slug = 'demo'`,
		)
			.bind(DID_A)
			.first<{ current_cid: string }>();
		expect(head?.current_cid).toBe(PROFILE_CID_2);
	});

	it("exposes authoritative URI and CID pairs without publisher metadata", async () => {
		await seedProfile({ cid: PROFILE_CID_1, name: "Private display name", at: NOW });
		await seedRelease({ cid: RELEASE_CID_1, version: "1.0.0", at: NOW });
		const page = await listCurrentSubjects(testEnv.DB);
		expect(page.items).toEqual([
			{ uri: packageProfileUri(DID_A, "demo"), cid: PROFILE_CID_1, kind: "profile" },
			{
				uri: releaseUri(DID_A, "demo", "1.0.0"),
				cid: RELEASE_CID_1,
				kind: "release",
			},
		]);
		expect(JSON.stringify(page)).not.toContain("Private display name");
		expect(
			await isCurrentSubject(testEnv.DB, packageProfileUri(DID_A, "demo"), PROFILE_CID_1),
		).toBe(true);
	});
});

describe("projection policy", () => {
	it("does not let the accepted-labelers header disable a required source", async () => {
		const optionalSource = "did:plc:labeler000000000000000bb";
		const policy: ListingModerationPolicy = {
			...moderationPolicy,
			acceptedStateSources: [LABELER_DID, optionalSource],
		};
		const rejected = await handleXrpc(
			configuredEnv("projection", [], testEnv.DB, policy),
			new Request(`https://test/xrpc/${NSID.aggregatorGetPackage}`, {
				headers: { "atproto-accept-labelers": optionalSource },
			}),
		);
		expect(rejected?.status).toBe(400);
		expect(await rejected?.json()).toMatchObject({
			error: "InvalidRequest",
			message: "accepted labelers header cannot disable a required listing labeler",
		});

		const accepted = `${LABELER_DID},${optionalSource}`;
		const allowed = await handleXrpc(
			configuredEnv("projection", [], testEnv.DB, policy),
			new Request(`https://test/xrpc/${NSID.aggregatorGetPackage}`, {
				headers: { "atproto-accept-labelers": accepted },
			}),
		);
		expect(allowed?.headers.get("atproto-accept-labelers")).toBe(accepted);
	});

	it("rejects accepted-labeler modifiers instead of silently ignoring them", async () => {
		const response = await handleXrpc(
			configuredEnv("projection", []),
			new Request(`https://test/xrpc/${NSID.aggregatorGetPackage}`, {
				headers: { "atproto-accept-labelers": `${LABELER_DID};redact` },
			}),
		);
		expect(response?.status).toBe(400);
		expect(await response?.json()).toMatchObject({
			error: "InvalidRequest",
			message: "accepted labelers header is invalid",
		});
	});

	it("prefers the current profile head over a later-observed historical revision", async () => {
		await seedProfile({
			cid: PROFILE_CID_2,
			name: "Historical",
			at: new Date("2026-08-24T10:02:00.000Z"),
		});
		await seedProfile({ cid: PROFILE_CID_1, name: "Current", at: NOW });
		await seedRelease({ cid: RELEASE_CID_1, version: "1.0.0", at: NOW });
		await rebuild("allowlist", [packageProfileUri(DID_A, "demo")]);
		const response = await xrpc(
			"allowlist",
			`${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
			[packageProfileUri(DID_A, "demo")],
		);
		expect(await response.json()).toMatchObject({
			cid: PROFILE_CID_1,
			profile: { name: "Current" },
		});
	});

	it("ignores takedowns from state-only sources during emergency allowlist reads", async () => {
		await seedProfile({ cid: PROFILE_CID_1, name: "Allowlisted", at: NOW });
		await seedRelease({ cid: RELEASE_CID_1, version: "1.0.0", at: NOW });
		await seedLabelerRoles({ acceptedState: true, redaction: false });
		await putLabel(packageProfileUri(DID_A, "demo"), PROFILE_CID_1, "!takedown");
		const allowlist = [packageProfileUri(DID_A, "demo")];

		const allowed = await xrpc(
			"allowlist",
			`${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
			allowlist,
		);
		expect(allowed.status).toBe(200);

		await testEnv.DB.prepare("UPDATE labellers SET redaction = 1 WHERE did = ?")
			.bind(LABELER_DID)
			.run();
		const redacted = await xrpc(
			"allowlist",
			`${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
			allowlist,
		);
		expect(redacted.status).toBe(404);
	});

	it("redacts a negative-first restrictive collision immediately and in fallback reads", async () => {
		await seedApprovedPackage({
			did: DID_A,
			slug: "demo",
			profileCid: PROFILE_CID_1,
			releaseCid: RELEASE_CID_1,
		});
		await rebuild("projection");
		await seedLabelerRoles({ acceptedState: true, redaction: true, requiredPositive: true });
		await seedRestrictiveCollision(packageProfileUri(DID_A, "demo"), PROFILE_CID_1, "!takedown");

		await expectUnavailable(DID_A, "demo");
		const allowlist = [packageProfileUri(DID_A, "demo")];
		const fallback = await xrpc(
			"allowlist",
			`${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
			allowlist,
		);
		expect(fallback.status).toBe(404);
	});

	it("redacts every later positive candidate added to an existing restrictive collision", async () => {
		await seedApprovedPackage({
			did: DID_A,
			slug: "demo",
			profileCid: PROFILE_CID_1,
			releaseCid: RELEASE_CID_1,
		});
		await rebuild("projection");
		await seedLabelerRoles({ acceptedState: true, redaction: true, requiredPositive: true });
		const uri = packageProfileUri(DID_A, "demo");
		await seedRestrictiveCollision(uri, PROFILE_CID_2, "listing-blocked");
		await expectVisible(DID_A, "demo");

		await testEnv.DB.prepare(
			`INSERT INTO listing_labels
			   (digest, state_digest, src, uri, cid, val, neg, cts, cts_epoch,
			    cts_fraction, exp, exp_epoch, sig, ver, received_at)
			 VALUES ('restrictive-current', 'restrictive-current', ?, ?, ?,
			         'listing-blocked', 0, ?, ?, ?, NULL, NULL, ?, 1, ?)`,
		)
			.bind(
				LABELER_DID,
				uri,
				PROFILE_CID_1,
				NOW.toISOString(),
				Math.floor(NOW.getTime() / 1_000),
				"0".repeat(32),
				new Uint8Array([1]),
				NOW.toISOString(),
			)
			.run();

		await expectUnavailable(DID_A, "demo");
	});

	it("empties an emergency allowlist when the moderation policy is invalid", async () => {
		await seedProfile({ cid: PROFILE_CID_1, name: "Must stay hidden", at: NOW });
		await seedRelease({ cid: RELEASE_CID_1, version: "1.0.0", at: NOW });
		const allowlist = [packageProfileUri(DID_A, "demo")];
		const runtimeEnv = {
			...configuredEnv("allowlist", allowlist),
			LISTING_MODERATION_POLICY: "{",
		} as unknown as Env;
		const policy = await getListingPolicy(runtimeEnv);
		expect([...policy.allowlist]).toEqual([]);

		const response = await handleXrpc(
			runtimeEnv,
			new Request(`https://test/xrpc/${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`),
		);
		expect(response?.status).toBe(404);
		expect(await response?.json()).toMatchObject({ error: "ListingUnavailable" });
	});

	it("does not grant release-withdrawal authority to a positive-only source", async () => {
		const redactionDid = "did:plc:redaction0000000000000001";
		const policy: ListingModerationPolicy = {
			...moderationPolicy,
			redactionSources: [redactionDid],
		};
		await seedApprovedPackage({
			did: DID_A,
			slug: "demo",
			profileCid: PROFILE_CID_1,
			releaseCid: RELEASE_CID_1,
		});
		await putLabel(releaseUri(DID_A, "demo", "1.0.0"), RELEASE_CID_1, "security:yanked");

		await rebuild("projection", [], policy);
		const response = await xrpc(
			"projection",
			`${NSID.aggregatorGetLatestRelease}?did=${DID_A}&package=demo`,
			[],
			policy,
		);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({ cid: RELEASE_CID_1 });
		expect(body).not.toMatchObject({
			labels: expect.arrayContaining([expect.objectContaining({ val: "security:yanked" })]),
		});
	});

	it("atomically stages explicit replay and hides stale approved rows before cursor reset", async () => {
		await seedApprovedPackage({
			did: DID_A,
			slug: "demo",
			profileCid: PROFILE_CID_1,
			releaseCid: RELEASE_CID_1,
		});
		await seedLabelerRoles({ acceptedState: true, redaction: true, requiredPositive: true });
		await markLabelSourceHealthy(testEnv.DB, LABELER_DID, NOW);
		await rebuild("projection");
		await testEnv.DB.prepare(
			`INSERT INTO ingest_state (source, cursor, updated_at)
			 VALUES (?, '12', ?) ON CONFLICT(source) DO UPDATE SET cursor = '12'`,
		)
			.bind(`labeler:${LABELER_DID}`, NOW.toISOString())
			.run();
		await expectVisible(DID_A, "demo");

		expect(await stageLabelSourceReplay(testEnv.DB, LABELER_DID, NOW)).toBe(true);
		const staged = await testEnv.DB.prepare(
			`SELECT trusted, replay_pending, replay_generation
			 FROM labellers WHERE did = ?`,
		)
			.bind(LABELER_DID)
			.first<{ trusted: number; replay_pending: number; replay_generation: number }>();
		expect(staged).toEqual({ trusted: 0, replay_pending: 1, replay_generation: 1 });
		expect(
			await testEnv.DB.prepare(
				"SELECT COUNT(*) AS count FROM label_state WHERE trusted <> 0",
			).first<{ count: number }>(),
		).toEqual({ count: 0 });
		expect(await readLabelCursor(testEnv.DB, LABELER_DID)).toBe(0);
		await expectUnavailable(DID_A, "demo");

		expect(await stageLabelSourceReplay(testEnv.DB, LABELER_DID, NOW)).toBe(true);
		expect(
			await testEnv.DB.prepare(
				"SELECT replay_pending, replay_generation FROM labellers WHERE did = ?",
			)
				.bind(LABELER_DID)
				.first(),
		).toEqual({ replay_pending: 1, replay_generation: 2 });
	});

	it("keeps later restrictive replay state effective when catch-up restores trust", async () => {
		await seedApprovedPackage({
			did: DID_A,
			slug: "demo",
			profileCid: PROFILE_CID_1,
			releaseCid: RELEASE_CID_1,
		});
		await seedLabelerRoles({ acceptedState: true, redaction: true, requiredPositive: true });
		await markLabelSourceHealthy(testEnv.DB, LABELER_DID, NOW);
		await rebuild("projection");
		await stageLabelSourceReplay(testEnv.DB, LABELER_DID, NOW);
		await upsertHydratedLabelState(
			testEnv.DB,
			{
				ver: 1,
				src: LABELER_DID,
				uri: packageProfileUri(DID_A, "demo"),
				cid: PROFILE_CID_1,
				val: "listing-blocked",
				cts: new Date(NOW.getTime() + 1_000).toISOString(),
			},
			false,
		);
		await activateLabelSourceAfterReplay(
			testEnv.DB,
			LABELER_DID,
			moderationPolicy.policyVersion,
			1,
			new Date(NOW.getTime() + 2_000),
		);
		await rebuild("projection");
		await expectUnavailable(DID_A, "demo");
	});

	it.each(["listing-blocked", "!takedown"])(
		"keeps an existing %s enforced in allowlist mode until replay catch-up completes",
		async (value) => {
			await seedProfile({ cid: PROFILE_CID_1, name: "Allowlisted", at: NOW });
			await seedRelease({ cid: RELEASE_CID_1, version: "1.0.0", at: NOW });
			await seedLabelerRoles({ acceptedState: true, redaction: true, requiredPositive: true });
			await putLabel(packageProfileUri(DID_A, "demo"), PROFILE_CID_1, value);
			const allowlist = [packageProfileUri(DID_A, "demo")];
			await stageLabelSourceReplay(testEnv.DB, LABELER_DID, NOW);

			const duringReplay = await xrpc(
				"allowlist",
				`${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
				allowlist,
			);
			expect(duringReplay.status).toBe(404);
			await upsertHydratedLabelState(
				testEnv.DB,
				{
					ver: 1,
					src: LABELER_DID,
					uri: packageProfileUri(DID_A, "demo"),
					cid: PROFILE_CID_1,
					val: value,
					neg: true,
					cts: new Date(NOW.getTime() + 1_000).toISOString(),
				},
				false,
			);
			const afterMidReplayNegation = await xrpc(
				"allowlist",
				`${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
				allowlist,
			);
			expect(afterMidReplayNegation.status).toBe(404);

			await activateLabelSourceAfterReplay(
				testEnv.DB,
				LABELER_DID,
				moderationPolicy.policyVersion,
				1,
				new Date(NOW.getTime() + 2_000),
			);
			const afterCatchUp = await xrpc(
				"allowlist",
				`${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
				allowlist,
			);
			expect(afterCatchUp.status).toBe(200);
		},
	);

	it.each(["security:yanked", "security-yanked"])(
		"keeps an existing %s withdrawal enforced throughout replay",
		async (value) => {
			await seedProfile({ cid: PROFILE_CID_1, name: "Allowlisted", at: NOW });
			await seedRelease({ cid: RELEASE_CID_1, version: "1.0.0", at: NOW });
			await seedLabelerRoles({ acceptedState: true, redaction: true, requiredPositive: true });
			const uri = releaseUri(DID_A, "demo", "1.0.0");
			await putLabel(uri, RELEASE_CID_1, value);
			const allowlist = [packageProfileUri(DID_A, "demo")];
			await stageLabelSourceReplay(testEnv.DB, LABELER_DID, NOW);

			const duringReplay = await xrpc(
				"allowlist",
				`${NSID.aggregatorGetLatestRelease}?did=${DID_A}&package=demo`,
				allowlist,
			);
			expect(duringReplay.status).toBe(404);
			await upsertHydratedLabelState(
				testEnv.DB,
				{
					ver: 1,
					src: LABELER_DID,
					uri,
					cid: RELEASE_CID_1,
					val: value,
					neg: true,
					cts: new Date(NOW.getTime() + 1_000).toISOString(),
				},
				false,
			);
			const afterMidReplayNegation = await xrpc(
				"allowlist",
				`${NSID.aggregatorGetLatestRelease}?did=${DID_A}&package=demo`,
				allowlist,
			);
			expect(afterMidReplayNegation.status).toBe(404);
		},
	);

	it("enforces a later restrictive label received while replay remains untrusted", async () => {
		await seedProfile({ cid: PROFILE_CID_1, name: "Allowlisted", at: NOW });
		await seedRelease({ cid: RELEASE_CID_1, version: "1.0.0", at: NOW });
		await seedLabelerRoles({ acceptedState: true, redaction: true, requiredPositive: true });
		await stageLabelSourceReplay(testEnv.DB, LABELER_DID, NOW);
		await upsertHydratedLabelState(
			testEnv.DB,
			{
				ver: 1,
				src: LABELER_DID,
				uri: packageProfileUri(DID_A, "demo"),
				cid: PROFILE_CID_1,
				val: "listing-blocked",
				cts: new Date(NOW.getTime() + 1_000).toISOString(),
			},
			false,
		);
		const response = await xrpc(
			"allowlist",
			`${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
			[packageProfileUri(DID_A, "demo")],
		);
		expect(response.status).toBe(404);
	});

	it("revokes replay-guard authority when the source becomes inactive", async () => {
		await seedProfile({ cid: PROFILE_CID_1, name: "Allowlisted", at: NOW });
		await seedRelease({ cid: RELEASE_CID_1, version: "1.0.0", at: NOW });
		await seedLabelerRoles({ acceptedState: true, redaction: true, requiredPositive: true });
		await putLabel(packageProfileUri(DID_A, "demo"), PROFILE_CID_1, "listing-blocked");
		await stageLabelSourceReplay(testEnv.DB, LABELER_DID, NOW);
		await testEnv.DB.prepare(
			`UPDATE labellers SET active = 0, trusted = 0, replay_pending = 0,
			 required_positive = 0, accepted_state = 0, redaction = 0
			 WHERE did = ?`,
		)
			.bind(LABELER_DID)
			.run();
		const response = await xrpc(
			"allowlist",
			`${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
			[packageProfileUri(DID_A, "demo")],
		);
		expect(response.status).toBe(200);
		expect(
			await testEnv.DB.prepare(
				"SELECT COUNT(*) AS count FROM listing_replay_restrictions WHERE src = ?",
			)
				.bind(LABELER_DID)
				.first(),
		).toEqual({ count: 0 });
	});

	it.each([
		["listing-blocked", "profile"],
		["!takedown", "profile"],
		["security:yanked", "release"],
		["security-yanked", "release"],
	] as const)("preserves %s during required-source health demotion", async (value, kind) => {
		await seedProfile({ cid: PROFILE_CID_1, name: "Allowlisted", at: NOW });
		await seedRelease({ cid: RELEASE_CID_1, version: "1.0.0", at: NOW });
		await seedLabelerRoles({ acceptedState: true, redaction: true, requiredPositive: true });
		const uri =
			kind === "profile" ? packageProfileUri(DID_A, "demo") : releaseUri(DID_A, "demo", "1.0.0");
		await putLabel(uri, kind === "profile" ? PROFILE_CID_1 : RELEASE_CID_1, value);
		await markLabelSourceHealthy(testEnv.DB, LABELER_DID, NOW);
		expect(
			await testEnv.DB.prepare(
				`SELECT active, trusted, required_positive, health_last_success_epoch
				 FROM labellers WHERE did = ?`,
			)
				.bind(LABELER_DID)
				.first(),
		).toEqual({
			active: 1,
			trusted: 1,
			required_positive: 1,
			health_last_success_epoch: NOW.getTime(),
		});
		const boundary = new Date(NOW.getTime() + REQUIRED_LABEL_SOURCE_HEALTH_TIMEOUT_MS);
		expect(await enforceRequiredLabelSourceHealth(testEnv.DB, boundary)).toEqual([LABELER_DID]);
		const method =
			kind === "profile"
				? `${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`
				: `${NSID.aggregatorGetLatestRelease}?did=${DID_A}&package=demo`;
		const response = await xrpc("allowlist", method, [packageProfileUri(DID_A, "demo")]);
		expect(response.status).toBe(404);
	});

	it("demotes required sources exactly at the persisted freshness boundary", async () => {
		await seedApprovedPackage({
			did: DID_A,
			slug: "demo",
			profileCid: PROFILE_CID_1,
			releaseCid: RELEASE_CID_1,
		});
		await seedLabelerRoles({ acceptedState: true, redaction: true, requiredPositive: true });
		await rebuild("projection");
		const healthTime = new Date();
		await markLabelSourceHealthy(testEnv.DB, LABELER_DID, healthTime);
		const beforeBoundary = new Date(
			healthTime.getTime() + REQUIRED_LABEL_SOURCE_HEALTH_TIMEOUT_MS - 1,
		);
		expect(await enforceRequiredLabelSourceHealth(testEnv.DB, beforeBoundary)).toEqual([]);
		await expectVisible(DID_A, "demo");

		const boundary = new Date(healthTime.getTime() + REQUIRED_LABEL_SOURCE_HEALTH_TIMEOUT_MS);
		expect(await enforceRequiredLabelSourceHealth(testEnv.DB, boundary)).toEqual([LABELER_DID]);
		await expectUnavailable(DID_A, "demo");
		await markLabelSourceHealthy(testEnv.DB, LABELER_DID, new Date(boundary.getTime() + 1));
		expect(await readLabelSourceTrust(testEnv.DB, LABELER_DID)).toBe(false);
	});

	it("does not health-demote sources without an authoritative policy role or inactive sources", async () => {
		await seedLabelerRoles({ acceptedState: false, redaction: false, requiredPositive: false });
		await markLabelSourceHealthy(testEnv.DB, LABELER_DID, NOW);
		const stale = new Date(NOW.getTime() + REQUIRED_LABEL_SOURCE_HEALTH_TIMEOUT_MS);
		expect(await enforceRequiredLabelSourceHealth(testEnv.DB, stale)).toEqual([]);
		expect(await readLabelSourceTrust(testEnv.DB, LABELER_DID)).toBe(true);

		await testEnv.DB.prepare("UPDATE labellers SET active = 0, trusted = 0 WHERE did = ?")
			.bind(LABELER_DID)
			.run();
		expect(await enforceRequiredLabelSourceHealth(testEnv.DB, stale)).toEqual([]);
	});

	it("fails projection reads when a redaction-only authoritative source becomes stale", async () => {
		const redactionDid = "did:plc:redactionhealth000000000001";
		const policy: ListingModerationPolicy = {
			...moderationPolicy,
			redactionSources: [redactionDid],
		};
		await seedApprovedPackage({
			did: DID_A,
			slug: "demo",
			profileCid: PROFILE_CID_1,
			releaseCid: RELEASE_CID_1,
		});
		await seedLabelerRoles({ acceptedState: true, redaction: false, requiredPositive: true });
		await seedLabelerRoles({
			did: redactionDid,
			acceptedState: false,
			redaction: true,
			requiredPositive: false,
		});
		await rebuild("projection", [], policy);
		const healthTime = new Date();
		await markLabelSourceHealthy(testEnv.DB, LABELER_DID, healthTime);
		await markLabelSourceHealthy(testEnv.DB, redactionDid, healthTime);
		const boundary = new Date(healthTime.getTime() + REQUIRED_LABEL_SOURCE_HEALTH_TIMEOUT_MS);
		await markLabelSourceHealthy(testEnv.DB, LABELER_DID, boundary);
		expect(await enforceRequiredLabelSourceHealth(testEnv.DB, boundary)).toEqual([redactionDid]);

		const response = await xrpc(
			"projection",
			`${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
			[],
			policy,
		);
		expect(await response.json()).toMatchObject({ error: "ListingUnavailable" });
	});

	it("fails projection reads from persisted source freshness without a demotion write", async () => {
		await seedApprovedPackage({
			did: DID_A,
			slug: "demo",
			profileCid: PROFILE_CID_1,
			releaseCid: RELEASE_CID_1,
		});
		await seedLabelerRoles({ acceptedState: true, redaction: true, requiredPositive: true });
		await rebuild("projection");

		const recent = new Date(Date.now() - REQUIRED_LABEL_SOURCE_HEALTH_TIMEOUT_MS + 60_000);
		await testEnv.DB.prepare(
			`UPDATE labellers
			 SET trusted = 1, health_last_success_at = ?, health_last_success_epoch = ?
			 WHERE did = ?`,
		)
			.bind(recent.toISOString(), recent.getTime(), LABELER_DID)
			.run();
		await expectVisible(DID_A, "demo");

		const boundary = new Date(Date.now() - REQUIRED_LABEL_SOURCE_HEALTH_TIMEOUT_MS);
		await testEnv.DB.prepare(
			`UPDATE labellers
			 SET trusted = 1, health_last_success_at = ?, health_last_success_epoch = ?
			 WHERE did = ?`,
		)
			.bind(boundary.toISOString(), boundary.getTime(), LABELER_DID)
			.run();
		await expectUnavailable(DID_A, "demo");

		await testEnv.DB.prepare(
			`UPDATE labellers
			 SET trusted = 1, health_last_success_at = NULL, health_last_success_epoch = NULL
			 WHERE did = ?`,
		)
			.bind(LABELER_DID)
			.run();
		await expectUnavailable(DID_A, "demo");
	});

	it("keeps both release-withdrawal spellings enforced during emergency allowlist", async () => {
		const allowlist = [packageProfileUri(DID_A, "demo")];
		for (const value of ["security:yanked", "security-yanked"]) {
			await seedProfile({ cid: PROFILE_CID_1, name: "Allowlisted", at: NOW });
			await seedRelease({ cid: RELEASE_CID_1, version: "1.0.0", at: NOW });
			await seedLabelerRoles({ acceptedState: false, redaction: true });
			await putLabel(releaseUri(DID_A, "demo", "1.0.0"), RELEASE_CID_1, value);

			const response = await xrpc(
				"allowlist",
				`${NSID.aggregatorGetLatestRelease}?did=${DID_A}&package=demo`,
				allowlist,
			);
			expect(response.status).toBe(404);
			await testEnv.DB.prepare("DELETE FROM label_state").run();
			await testEnv.DB.prepare("DELETE FROM labellers").run();
			await testEnv.DB.prepare("DELETE FROM releases").run();
			await testEnv.DB.prepare("DELETE FROM packages").run();
			await testEnv.DB.prepare("DELETE FROM package_profile_heads").run();
			await testEnv.DB.prepare("DELETE FROM package_profile_revisions").run();
		}
	});

	it("keeps equal-time restrictive label collisions fail closed during rebuild", async () => {
		await seedApprovedPackage({
			did: DID_A,
			slug: "demo",
			profileCid: PROFILE_CID_1,
			releaseCid: RELEASE_CID_1,
		});
		await testEnv.DB.prepare(
			`INSERT INTO labellers
			   (did, endpoint, signing_key, signing_key_id, trusted, added_at,
			    last_resolved_at, active, required_positive, accepted_state,
			    redaction, policy_version)
			 VALUES (?, 'https://labels.example', 'key', ?, 1, ?, ?, 1, 1, 1, 1, ?)`,
		)
			.bind(
				LABELER_DID,
				`${LABELER_DID}#atproto_label`,
				NOW.toISOString(),
				NOW.toISOString(),
				moderationPolicy.policyVersion,
			)
			.run();
		const uri = packageProfileUri(DID_A, "demo");
		for (const [digest, cid] of [
			["review-a", PROFILE_CID_1],
			["review-b", PROFILE_CID_2],
		] as const) {
			await testEnv.DB.prepare(
				`INSERT INTO listing_labels
				   (digest, state_digest, src, uri, cid, val, neg, cts, cts_epoch,
				    cts_fraction, exp, exp_epoch, sig, ver, received_at)
				 VALUES (?, ?, ?, ?, ?, 'listing-review', 0, ?, ?, ?, NULL, NULL, ?, 1, ?)`,
			)
				.bind(
					digest,
					digest,
					LABELER_DID,
					uri,
					cid,
					NOW.toISOString(),
					Math.floor(NOW.getTime() / 1000),
					"0".repeat(32),
					new Uint8Array([1]),
					NOW.toISOString(),
				)
				.run();
		}
		await rebuild("projection");
		await expectUnavailable(DID_A, "demo");
	});

	it("keeps the approved profile and release while newer CIDs are pending", async () => {
		await seedProfile({ cid: PROFILE_CID_1, name: "Approved name", at: NOW });
		await seedRelease({ cid: RELEASE_CID_1, version: "1.0.0", at: NOW });
		await putLabel(packageProfileUri(DID_A, "demo"), PROFILE_CID_1, "listing-passed");
		await putLabel(releaseUri(DID_A, "demo", "1.0.0"), RELEASE_CID_1, "listing-passed");
		await rebuild("projection");

		await seedProfile({
			cid: PROFILE_CID_2,
			name: "Pending hostile replacement",
			at: new Date("2026-08-24T10:01:00.000Z"),
		});
		await seedRelease({
			cid: PENDING_PROFILE_CID,
			version: "2.0.0",
			at: new Date("2026-08-24T10:02:00.000Z"),
		});
		await putLabel(packageProfileUri(DID_A, "demo"), PROFILE_CID_2, "listing-pending");
		await putLabel(releaseUri(DID_A, "demo", "2.0.0"), RELEASE_CID_2, "listing-pending");
		await rebuild("projection");

		const packageResponse = await xrpc(
			"projection",
			`${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
		);
		expect(packageResponse.status).toBe(200);
		const packageBody = (await packageResponse.json()) as {
			cid: string;
			latestVersion: string;
			profile: { name: string };
		};
		expect(packageBody).toMatchObject({
			cid: PROFILE_CID_1,
			latestVersion: "1.0.0",
			profile: { name: "Approved name" },
		});

		const releaseResponse = await xrpc(
			"projection",
			`${NSID.aggregatorGetLatestRelease}?did=${DID_A}&package=demo`,
		);
		expect(releaseResponse.status).toBe(200);
		expect(await releaseResponse.json()).toMatchObject({
			cid: RELEASE_CID_1,
			version: "1.0.0",
		});
	});

	it("never returns staged publisher content in public reads or direct errors", async () => {
		const hostile = "UNSAFE-PUBLISHER-TEXT https://credential-steal.example";
		await seedProfile({ cid: PROFILE_CID_1, name: hostile, at: NOW });
		await seedRelease({ cid: RELEASE_CID_1, version: "1.0.0", at: NOW });
		await rebuild("projection");

		const direct = await xrpc("projection", `${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`);
		expect(direct.status).toBe(404);
		const directText = await direct.text();
		expect(directText).toContain("ListingUnavailable");
		expect(directText).not.toContain(hostile);
		expect(directText).not.toContain("credential-steal.example");

		const search = await xrpc("projection", `${NSID.aggregatorSearchPackages}?q=UNSAFE`);
		expect(search.status).toBe(200);
		const searchText = await search.text();
		expect(searchText).not.toContain(hostile);
		expect(JSON.parse(searchText)).toEqual({ packages: [] });

		const record = await xrpc(
			"projection",
			`com.atproto.sync.getRecord?did=${DID_A}&collection=${NSID.packageProfile}&rkey=demo`,
		);
		expect(record.status).toBe(404);
		expect(await record.text()).not.toContain(hostile);
	});

	it("removes an approved package immediately when the publisher deletes it", async () => {
		await seedApprovedPackage({
			did: DID_A,
			slug: "demo",
			profileCid: PROFILE_CID_1,
			releaseCid: RELEASE_CID_1,
		});
		await rebuild("projection");
		await applyDelete(testEnv.DB, job(DID_A, NSID.packageProfile, "demo", "delete"), NOW);

		const response = await xrpc(
			"projection",
			`${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ error: "NotFound" });
		const retained = await testEnv.DB.prepare(
			`SELECT COUNT(*) AS count FROM package_profile_revisions WHERE did = ? AND slug = 'demo'`,
		)
			.bind(DID_A)
			.first<{ count: number }>();
		expect(retained?.count).toBe(1);
	});

	it("serves an exact allowlist and fails closed for every other staged package", async () => {
		await seedProfile({ cid: PROFILE_CID_1, name: "Allowed", at: NOW });
		await seedRelease({ cid: RELEASE_CID_1, version: "1.0.0", at: NOW });
		await seedProfile({
			cid: PENDING_RELEASE_CID,
			name: "Not allowed",
			at: NOW,
			did: DID_B,
			slug: "other",
		});
		await seedRelease({
			cid: RELEASE_CID_2,
			version: "1.0.0",
			at: NOW,
			did: DID_B,
			slug: "other",
		});
		const allowlist = [packageProfileUri(DID_A, "demo")];

		const search = await xrpc("allowlist", NSID.aggregatorSearchPackages, allowlist);
		const body = (await search.json()) as { packages: Array<{ did: string }> };
		expect(body.packages.map((pkg) => pkg.did)).toEqual([DID_A]);
		const direct = await xrpc(
			"allowlist",
			`${NSID.aggregatorGetPackage}?did=${DID_B}&slug=other`,
			allowlist,
		);
		expect(await direct.json()).toMatchObject({ error: "ListingUnavailable" });
	});

	it("searches any number of approved rows with one D1 statement", async () => {
		await seedApprovedPackage({
			did: DID_A,
			slug: "demo",
			profileCid: PROFILE_CID_1,
			releaseCid: RELEASE_CID_1,
		});
		await seedApprovedPackage({
			did: DID_B,
			slug: "other",
			profileCid: PROFILE_CID_2,
			releaseCid: RELEASE_CID_2,
		});
		await rebuild("projection");

		let prepares = 0;
		const countingDb = new Proxy(testEnv.DB, {
			get(target, property, receiver) {
				if (property === "withSession") {
					return (constraint?: D1SessionBookmark) => {
						const session = target.withSession(constraint);
						return new Proxy(session, {
							get(sessionTarget, sessionProperty, sessionReceiver) {
								if (sessionProperty === "prepare") {
									return (query: string) => {
										prepares += 1;
										return sessionTarget.prepare(query);
									};
								}
								const value = Reflect.get(sessionTarget, sessionProperty, sessionReceiver);
								return typeof value === "function" ? value.bind(sessionTarget) : value;
							},
						});
					};
				}
				const value = Reflect.get(target, property, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const response = await handleXrpc(
			configuredEnv("projection", [], countingDb),
			new Request(`https://test/xrpc/${NSID.aggregatorSearchPackages}`),
		);
		expect(response?.status).toBe(200);
		expect(prepares).toBe(1);
		const body = (await response?.json()) as { packages: unknown[] };
		expect(body.packages).toHaveLength(2);
	});

	it("keeps approved and unrelated listings visible during additive pending ingest", async () => {
		await seedApprovedPackage({
			did: DID_A,
			slug: "demo",
			profileCid: PROFILE_CID_1,
			releaseCid: RELEASE_CID_1,
		});
		await seedApprovedPackage({
			did: DID_B,
			slug: "other",
			profileCid: PROFILE_CID_2,
			releaseCid: RELEASE_CID_2,
		});
		await rebuild("projection");

		await seedProfile({
			cid: RELEASE_CID_2,
			name: "Pending replacement",
			at: new Date("2026-08-24T10:01:00.000Z"),
		});
		await seedRelease({
			cid: PROFILE_CID_2,
			version: "2.0.0",
			at: new Date("2026-08-24T10:02:00.000Z"),
		});
		await putLabel(packageProfileUri(DID_A, "demo"), PENDING_PROFILE_CID, "listing-pending");
		await putLabel(releaseUri(DID_A, "demo", "2.0.0"), PENDING_RELEASE_CID, "listing-pending");

		const approved = await xrpc(
			"projection",
			`${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
		);
		expect(await approved.json()).toMatchObject({
			cid: PROFILE_CID_1,
			latestVersion: "1.0.0",
			profile: { name: "demo" },
		});
		const unrelated = await xrpc(
			"projection",
			`${NSID.aggregatorGetPackage}?did=${DID_B}&slug=other`,
		);
		expect(unrelated.status).toBe(200);
		const search = await xrpc("projection", NSID.aggregatorSearchPackages);
		const searchBody = (await search.json()) as { packages: unknown[] };
		expect(searchBody.packages).toHaveLength(2);
	});

	it("transactionally demotes only subjects affected by blocks and takedowns", async () => {
		await seedApprovedPackage({
			did: DID_A,
			slug: "demo",
			profileCid: PROFILE_CID_1,
			releaseCid: RELEASE_CID_1,
		});
		await seedApprovedPackage({
			did: DID_B,
			slug: "other",
			profileCid: PROFILE_CID_2,
			releaseCid: RELEASE_CID_2,
		});
		await rebuild("projection");

		await putLabel(releaseUri(DID_A, "demo", "1.0.0"), RELEASE_CID_1, "listing-blocked");
		const blocked = await xrpc("projection", `${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`);
		expect(await blocked.json()).toMatchObject({ error: "ListingUnavailable" });
		const unaffected = await xrpc(
			"projection",
			`${NSID.aggregatorGetPackage}?did=${DID_B}&slug=other`,
		);
		expect(unaffected.status).toBe(200);

		await putLabel(DID_B, null, "!takedown");
		const takenDown = await xrpc(
			"projection",
			`${NSID.aggregatorGetPackage}?did=${DID_B}&slug=other`,
		);
		expect(await takenDown.json()).toMatchObject({ error: "ListingUnavailable" });
	});

	it.each(["security:yanked", "security-yanked"])(
		"removes a withdrawn release for %s and hydrates prior label state",
		async (withdrawalValue) => {
			await seedApprovedPairAndRebuild();
			await seedLabelerRoles({ acceptedState: true, redaction: true, requiredPositive: true });
			const before = await xrpc(
				"projection",
				`${NSID.aggregatorGetLatestRelease}?did=${DID_A}&package=demo`,
			);
			const beforeBody = (await before.json()) as { labels?: Array<{ val?: string }> };
			expect(beforeBody.labels?.some(({ val }) => val === "listing-passed")).toBe(true);

			await putLabel(releaseUri(DID_A, "demo", "1.0.0"), RELEASE_CID_1, withdrawalValue);
			const latest = await xrpc(
				"projection",
				`${NSID.aggregatorGetLatestRelease}?did=${DID_A}&package=demo`,
			);
			expect(await latest.json()).toMatchObject({ error: "ListingUnavailable" });
		},
	);

	it("discards a rebuild when its input epoch changes before activation", async () => {
		await seedApprovedPackage({
			did: DID_A,
			slug: "demo",
			profileCid: PROFILE_CID_1,
			releaseCid: RELEASE_CID_1,
		});
		await rebuild("projection");
		const listingPolicy = await getListingPolicy(configuredEnv("projection", []));

		await expect(
			rebuildPublicProjection(testEnv.DB, {
				listingPolicy,
				evaluatedAt: NOW,
				generation: "stale-input-generation",
				beforeActivate: () =>
					putLabel(packageProfileUri(DID_A, "demo"), PENDING_PROFILE_CID, "listing-review"),
			}),
		).rejects.toBeInstanceOf(StaleProjectionRebuildError);

		const stale = await testEnv.DB.prepare(
			`SELECT 1 AS hit FROM public_projection_generations WHERE generation = ?`,
		)
			.bind("stale-input-generation")
			.first();
		expect(stale).toBeNull();
		const response = await xrpc(
			"projection",
			`${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
		);
		expect(response.status).toBe(200);
	});

	it("never lets an older concurrent rebuild replace a newer generation", async () => {
		await seedApprovedPackage({
			did: DID_A,
			slug: "demo",
			profileCid: PROFILE_CID_1,
			releaseCid: RELEASE_CID_1,
		});
		await seedPolicySourcesReady(moderationPolicy);
		const listingPolicy = await getListingPolicy(configuredEnv("projection", []));
		await expect(
			rebuildPublicProjection(testEnv.DB, {
				listingPolicy,
				evaluatedAt: NOW,
				generation: "older-generation",
				beforeActivate: async () => {
					await rebuildPublicProjection(testEnv.DB, {
						listingPolicy,
						evaluatedAt: NOW,
						generation: "newer-generation",
					});
				},
			}),
		).rejects.toBeInstanceOf(StaleProjectionRebuildError);

		const state = await testEnv.DB.prepare(
			`SELECT active_generation FROM public_projection_state WHERE id = 1`,
		).first<{ active_generation: string }>();
		expect(state?.active_generation).toBe("newer-generation");
		const response = await xrpc(
			"projection",
			`${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
		);
		expect(response.status).toBe(200);
	});

	it("fails closed after policy version or hash changes until a matching rebuild", async () => {
		await seedApprovedPackage({
			did: DID_A,
			slug: "demo",
			profileCid: PROFILE_CID_1,
			releaseCid: RELEASE_CID_1,
		});
		await rebuild("projection");

		const changedHashPolicy: ListingModerationPolicy = {
			...moderationPolicy,
			prohibitedCategories: ["scam-or-spam"],
		};
		const hashMismatch = await xrpc(
			"projection",
			`${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
			[],
			changedHashPolicy,
		);
		expect(await hashMismatch.json()).toMatchObject({ error: "ListingUnavailable" });

		const changedVersionPolicy: ListingModerationPolicy = {
			...moderationPolicy,
			policyVersion: "listing-test-v2",
		};
		const versionMismatch = await xrpc(
			"projection",
			`${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
			[],
			changedVersionPolicy,
		);
		expect(await versionMismatch.json()).toMatchObject({ error: "ListingUnavailable" });

		await rebuild("projection", [], changedVersionPolicy);
		const promoted = await xrpc(
			"projection",
			`${NSID.aggregatorGetPackage}?did=${DID_A}&slug=demo`,
			[],
			changedVersionPolicy,
		);
		expect(promoted.status).toBe(200);
	});

	it("removes the public package in the same transaction as its final release", async () => {
		await seedApprovedPackage({
			did: DID_A,
			slug: "demo",
			profileCid: PROFILE_CID_1,
			releaseCid: RELEASE_CID_1,
		});
		await rebuild("projection");
		await applyDelete(testEnv.DB, job(DID_A, NSID.packageRelease, "demo:1.0.0", "delete"), NOW);

		const counts = await testEnv.DB.prepare(
			`SELECT
			   (SELECT COUNT(*) FROM public_releases WHERE did = ? AND package = 'demo') AS releases,
			   (SELECT COUNT(*) FROM public_packages WHERE did = ? AND slug = 'demo') AS packages`,
		)
			.bind(DID_A, DID_A)
			.first<{ releases: number; packages: number }>();
		expect(counts).toEqual({ releases: 0, packages: 0 });
	});

	it("uses primary sessions for guarded record reads and replicas only in open mode", async () => {
		await seedApprovedPackage({
			did: DID_A,
			slug: "demo",
			profileCid: PROFILE_CID_1,
			releaseCid: RELEASE_CID_1,
		});
		await rebuild("projection");
		const path = `com.atproto.sync.getRecord?did=${DID_A}&collection=${NSID.packageProfile}&rkey=demo`;

		for (const [mode, expected] of [
			["open", "first-unconstrained"],
			["allowlist", "first-primary"],
			["projection", "first-primary"],
		] as const) {
			let constraint: D1SessionBookmark | undefined;
			const observingDb = new Proxy(testEnv.DB, {
				get(target, property, receiver) {
					if (property === "withSession") {
						return (value?: D1SessionBookmark) => {
							constraint = value;
							return target.withSession(value);
						};
					}
					const value = Reflect.get(target, property, receiver);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const allowlist = mode === "allowlist" ? [packageProfileUri(DID_A, "demo")] : [];
			const response = await handleXrpc(
				configuredEnv(mode, allowlist, observingDb),
				new Request(`https://test/xrpc/${path}`),
			);
			expect(response?.status).toBe(200);
			expect(constraint).toBe(expected);
		}
	});

	it("demotes only the affected listing when its pass is negated", async () => {
		await seedApprovedPairAndRebuild();
		await testEnv.DB.prepare(
			`UPDATE label_state SET neg = 1
			 WHERE src = ? AND uri = ? AND val = 'listing-passed'`,
		)
			.bind(LABELER_DID, packageProfileUri(DID_A, "demo"))
			.run();
		await expectUnavailable(DID_A, "demo");
		await expectVisible(DID_B, "other");
	});

	it("demotes only the affected listing when its pass becomes distrusted", async () => {
		await seedApprovedPairAndRebuild();
		await testEnv.DB.prepare(
			`UPDATE label_state SET trusted = 0
			 WHERE src = ? AND uri = ? AND val = 'listing-passed'`,
		)
			.bind(LABELER_DID, packageProfileUri(DID_A, "demo"))
			.run();
		await expectUnavailable(DID_A, "demo");
		await expectVisible(DID_B, "other");
	});

	it("demotes only the old revision when its winning pass CID is superseded", async () => {
		await seedApprovedPairAndRebuild();
		await testEnv.DB.prepare(
			`UPDATE label_state SET cid = ?
			 WHERE src = ? AND uri = ? AND val = 'listing-passed'`,
		)
			.bind(PENDING_PROFILE_CID, LABELER_DID, packageProfileUri(DID_A, "demo"))
			.run();
		await expectUnavailable(DID_A, "demo");
		await expectVisible(DID_B, "other");
	});

	it.each(["listing-pending", "listing-review", "listing-error"])(
		"demotes an exact-CID pass on conflicting %s state",
		async (value) => {
			await seedApprovedPairAndRebuild();
			await putLabel(packageProfileUri(DID_A, "demo"), PROFILE_CID_1, value);
			await expectUnavailable(DID_A, "demo");
			await expectVisible(DID_B, "other");
		},
	);

	it("demotes only the affected listing when its positive source row is removed", async () => {
		await seedApprovedPairAndRebuild();
		await testEnv.DB.prepare(
			`DELETE FROM label_state
			 WHERE src = ? AND uri = ? AND val = 'listing-passed'`,
		)
			.bind(LABELER_DID, packageProfileUri(DID_A, "demo"))
			.run();
		await expectUnavailable(DID_A, "demo");
		await expectVisible(DID_B, "other");
	});

	it("rejects expired passes at query time and removes them during enforcement", async () => {
		await seedProfile({ cid: PROFILE_CID_1, name: "demo", at: NOW });
		await seedRelease({ cid: RELEASE_CID_1, version: "1.0.0", at: NOW });
		await putLabel(
			packageProfileUri(DID_A, "demo"),
			PROFILE_CID_1,
			"listing-passed",
			"2026-08-24T10:01:00.000Z",
		);
		await putLabel(releaseUri(DID_A, "demo", "1.0.0"), RELEASE_CID_1, "listing-passed");
		await seedApprovedPackage({
			did: DID_B,
			slug: "other",
			profileCid: PROFILE_CID_2,
			releaseCid: RELEASE_CID_2,
		});
		await rebuild("projection");

		await expectUnavailable(DID_A, "demo");
		await expectVisible(DID_B, "other");
		const policy = await getListingPolicy(configuredEnv("projection", []));
		await enforcePublicProjectionPolicy(testEnv.DB, policy);
		const row = await testEnv.DB.prepare(
			`SELECT 1 AS hit FROM public_packages WHERE did = ? AND slug = 'demo'`,
		)
			.bind(DID_A)
			.first();
		expect(row).toBeNull();
		await expectVisible(DID_B, "other");
	});

	it("normalizes offset expiries and treats the exact epoch boundary as expired", async () => {
		await seedApprovedPairAndRebuild();
		const offsetExpiry = "2026-08-24T11:00:00+02:00";
		await putLabel(packageProfileUri(DID_A, "demo"), PROFILE_CID_1, "listing-passed", offsetExpiry);
		const normalized = await testEnv.DB.prepare(
			`SELECT exp_epoch, unixepoch('2026-08-24T09:00:00Z') AS expected
			 FROM listing_label_state_expiry
			 WHERE src = ? AND uri = ? AND val = 'listing-passed'`,
		)
			.bind(LABELER_DID, packageProfileUri(DID_A, "demo"))
			.first<{ exp_epoch: number; expected: number }>();
		expect(normalized?.exp_epoch).toBe(normalized?.expected);
		await expectUnavailable(DID_A, "demo");
		await expectVisible(DID_B, "other");

		const boundary = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
		await putLabel(packageProfileUri(DID_B, "other"), PROFILE_CID_2, "listing-passed", boundary);
		await expectUnavailable(DID_B, "other");
	});

	it.each(["2026-08-24 11:00:00Z", "2026-02-30T11:00:00Z", "2026-08-24T11:00:00-00:00"])(
		"rejects non-RFC or impossible expiry %s before persistence",
		(exp) => {
			expect(() =>
				upsertHydratedLabelState(
					testEnv.DB,
					{
						ver: 1,
						src: LABELER_DID,
						uri: packageProfileUri(DID_A, "demo"),
						cid: PROFILE_CID_1,
						val: "listing-passed",
						cts: NOW.toISOString(),
						exp,
					},
					true,
				),
			).toThrow(/valid RFC 3339 timestamp/);
		},
	);

	it("fails closed when non-null expiry state has no matching validated epoch", async () => {
		await seedApprovedPairAndRebuild();
		await testEnv.DB.prepare(
			`UPDATE label_state SET exp = '2026-02-30T11:00:00Z'
			 WHERE src = ? AND uri = ? AND val = 'listing-passed'`,
		)
			.bind(LABELER_DID, packageProfileUri(DID_A, "demo"))
			.run();
		await expectUnavailable(DID_A, "demo");
		await expectVisible(DID_B, "other");
	});
});

interface SeedProfileOptions {
	cid: string;
	name: string;
	at: Date;
	did?: string;
	slug?: string;
}

async function seedProfile(options: SeedProfileOptions): Promise<void> {
	const did = options.did ?? DID_A;
	const slug = options.slug ?? "demo";
	await ingestPackageProfile(
		testEnv.DB,
		job(did, NSID.packageProfile, slug),
		verified(options.cid, {
			$type: NSID.packageProfile,
			id: packageProfileUri(did, slug),
			slug,
			type: "emdash-plugin",
			name: options.name,
			license: "MIT",
			authors: [{ name: "Publisher" }],
			security: [{ email: "security@example.test" }],
		}),
		options.at,
	);
}

interface SeedReleaseOptions {
	cid: string;
	version: string;
	at: Date;
	did?: string;
	slug?: string;
}

async function seedRelease(options: SeedReleaseOptions): Promise<void> {
	const did = options.did ?? DID_A;
	const slug = options.slug ?? "demo";
	await ingestPackageRelease(
		testEnv.DB,
		job(did, NSID.packageRelease, `${slug}:${options.version}`),
		verified(options.cid, {
			$type: NSID.packageRelease,
			package: slug,
			version: options.version,
			artifacts: {
				package: { url: "https://packages.example.test/plugin.tgz", checksum: "bsha256-test" },
			},
			extensions: {
				[NSID.packageReleaseExtension]: {
					$type: NSID.packageReleaseExtension,
					declaredAccess: {},
				},
			},
		}),
		options.at,
	);
}

async function seedApprovedPackage(options: {
	did: string;
	slug: string;
	profileCid: string;
	releaseCid: string;
}): Promise<void> {
	await seedProfile({
		did: options.did,
		slug: options.slug,
		cid: options.profileCid,
		name: options.slug,
		at: NOW,
	});
	await seedRelease({
		did: options.did,
		slug: options.slug,
		cid: options.releaseCid,
		version: "1.0.0",
		at: NOW,
	});
	await putLabel(
		packageProfileUri(options.did, options.slug),
		options.profileCid,
		"listing-passed",
	);
	await putLabel(
		releaseUri(options.did, options.slug, "1.0.0"),
		options.releaseCid,
		"listing-passed",
	);
}

async function putLabel(
	uri: string,
	cid: string | null,
	val: string,
	exp: string | null = null,
): Promise<void> {
	await upsertHydratedLabelState(
		testEnv.DB,
		{
			ver: 1,
			src: LABELER_DID,
			uri,
			...(cid === null ? {} : { cid }),
			val,
			cts: NOW.toISOString(),
			...(exp === null ? {} : { exp }),
		},
		true,
	);
}

async function seedLabelerRoles(options: {
	did?: string;
	acceptedState: boolean;
	redaction: boolean;
	requiredPositive?: boolean;
}): Promise<void> {
	await testEnv.DB.prepare(
		`INSERT INTO labellers
		   (did, endpoint, signing_key, signing_key_id, trusted, added_at,
		    last_resolved_at, active, required_positive, accepted_state,
		    redaction, policy_version)
		 VALUES (?, 'https://labels.example', 'key', ?, 1, ?, ?, 1, ?, ?, ?, ?)
		 ON CONFLICT(did) DO UPDATE SET
		   active = 1,
		   trusted = 1,
		   required_positive = excluded.required_positive,
		   accepted_state = excluded.accepted_state,
		   redaction = excluded.redaction,
		   policy_version = excluded.policy_version`,
	)
		.bind(
			options.did ?? LABELER_DID,
			`${options.did ?? LABELER_DID}#atproto_label`,
			NOW.toISOString(),
			NOW.toISOString(),
			options.requiredPositive ? 1 : 0,
			options.acceptedState ? 1 : 0,
			options.redaction ? 1 : 0,
			moderationPolicy.policyVersion,
		)
		.run();
}

async function seedRestrictiveCollision(uri: string, cid: string, val: string): Promise<void> {
	const epoch = Math.floor(NOW.getTime() / 1_000);
	const fraction = "0".repeat(32);
	for (const [digest, neg] of [
		["restrictive-negative", 1],
		["restrictive-positive", 0],
	] as const) {
		await testEnv.DB.prepare(
			`INSERT INTO listing_labels
			   (digest, state_digest, src, uri, cid, val, neg, cts, cts_epoch,
			    cts_fraction, exp, exp_epoch, sig, ver, received_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 1, ?)`,
		)
			.bind(
				digest,
				digest,
				LABELER_DID,
				uri,
				cid,
				val,
				neg,
				NOW.toISOString(),
				epoch,
				fraction,
				new Uint8Array([1]),
				NOW.toISOString(),
			)
			.run();
	}
	await testEnv.DB.prepare(
		`INSERT INTO label_state
		   (src, uri, val, cid, neg, cts, exp, trusted, cts_epoch, cts_fraction,
		    digest, source_sequence, frame_index, collision)
		 VALUES (?, ?, ?, ?, 1, ?, NULL, 1, ?, ?, 'restrictive-negative', 1, 0, 0)`,
	)
		.bind(LABELER_DID, uri, val, cid, NOW.toISOString(), epoch, fraction)
		.run();
	await testEnv.DB.prepare(
		"UPDATE label_state SET collision = 1 WHERE src = ? AND uri = ? AND val = ?",
	)
		.bind(LABELER_DID, uri, val)
		.run();
}

async function seedApprovedPairAndRebuild(): Promise<void> {
	await seedApprovedPackage({
		did: DID_A,
		slug: "demo",
		profileCid: PROFILE_CID_1,
		releaseCid: RELEASE_CID_1,
	});
	await seedApprovedPackage({
		did: DID_B,
		slug: "other",
		profileCid: PROFILE_CID_2,
		releaseCid: RELEASE_CID_2,
	});
	await rebuild("projection");
}

async function expectUnavailable(did: string, slug: string): Promise<void> {
	const response = await xrpc("projection", `${NSID.aggregatorGetPackage}?did=${did}&slug=${slug}`);
	expect(await response.json()).toMatchObject({ error: "ListingUnavailable" });
}

async function expectVisible(did: string, slug: string): Promise<void> {
	const response = await xrpc("projection", `${NSID.aggregatorGetPackage}?did=${did}&slug=${slug}`);
	expect(response.status).toBe(200);
}

async function rebuild(
	mode: ListingPolicyMode,
	allowlist: string[] = [],
	policy: ListingModerationPolicy = moderationPolicy,
): Promise<void> {
	if (mode === "projection") await seedPolicySourcesReady(policy);
	const runtimeEnv = configuredEnv(mode, allowlist, testEnv.DB, policy);
	await rebuildPublicProjection(testEnv.DB, {
		listingPolicy: await getListingPolicy(runtimeEnv),
		moderationPolicy: policy,
		evaluatedAt: NOW,
	});
}

async function seedPolicySourcesReady(policy: ListingModerationPolicy): Promise<void> {
	const healthTime = new Date();
	const sources = new Set([
		...policy.requiredPositiveSources,
		...policy.acceptedStateSources,
		...policy.redactionSources,
	]);
	for (const did of sources) {
		await testEnv.DB.prepare(
			`INSERT INTO labellers
			   (did, endpoint, signing_key, signing_key_id, trusted, added_at,
			    last_resolved_at, active, required_positive, accepted_state,
			    redaction, policy_version, health_last_success_at, health_last_success_epoch)
			 VALUES (?, 'https://labels.example', 'key', ?, 1, ?, ?, 1, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(did) DO UPDATE SET
			   active = 1,
			   trusted = 1,
			   required_positive = excluded.required_positive,
			   accepted_state = excluded.accepted_state,
			   redaction = excluded.redaction,
			   policy_version = excluded.policy_version,
			   health_last_success_at = excluded.health_last_success_at,
			   health_last_success_epoch = excluded.health_last_success_epoch`,
		)
			.bind(
				did,
				`${did}#atproto_label`,
				NOW.toISOString(),
				NOW.toISOString(),
				policy.requiredPositiveSources.includes(did) ? 1 : 0,
				policy.acceptedStateSources.includes(did) ? 1 : 0,
				policy.redactionSources.includes(did) ? 1 : 0,
				policy.policyVersion,
				healthTime.toISOString(),
				healthTime.getTime(),
			)
			.run();
	}
}

function xrpc(
	mode: ListingPolicyMode,
	method: string,
	allowlist: string[] = [],
	policy: ListingModerationPolicy = moderationPolicy,
): Promise<Response> {
	return handleXrpc(
		configuredEnv(mode, allowlist, testEnv.DB, policy),
		new Request(`https://test/xrpc/${method}`),
	).then((response) => {
		if (!response) throw new Error("XRPC route did not produce a response");
		return response;
	});
}

function configuredEnv(
	mode: ListingPolicyMode,
	allowlist: string[],
	db: D1Database = testEnv.DB,
	policy: ListingModerationPolicy = moderationPolicy,
): Env {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- tests override generated literal var bindings
	return {
		...env,
		DB: db,
		LISTING_POLICY_MODE: mode,
		LISTING_ALLOWLIST: JSON.stringify(allowlist),
		LISTING_MODERATION_POLICY: JSON.stringify(policy),
	} as Env;
}

function job(
	did: string,
	collection: string,
	rkey: string,
	operation: RecordsJob["operation"] = "create",
): RecordsJob {
	return { did, collection, rkey, operation, cid: "event-cid" };
}

function verified(cid: string, record: unknown): VerifiedPdsRecord {
	return { cid, record, carBytes: new TextEncoder().encode(cid) };
}

function releaseUri(did: string, slug: string, version: string): string {
	return `at://${did}/${NSID.packageRelease}/${slug}:${version}`;
}
