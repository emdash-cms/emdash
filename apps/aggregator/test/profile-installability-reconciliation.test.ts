import type { PublicKey } from "@atcute/crypto";
import { NSID } from "@emdash-cms/registry-lexicons";
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { DidResolver } from "../src/did-resolver.js";
import type { RecordsJob } from "../src/env.js";
import { PdsVerificationError, type VerifiedPdsRecord } from "../src/pds-verify.js";
import { reconcileProfileInstallability } from "../src/profile-installability-reconciliation.js";
import { ingestPackageProfile } from "../src/records-consumer.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const DID = "did:plc:reconcile000000000000000";
const NOW = new Date("2026-09-21T18:00:00.000Z");

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
	await testEnv.DB.prepare("UPDATE public_projection_state SET active_generation = NULL").run();
	await testEnv.DB.prepare(
		"UPDATE profile_installability_reconciliation SET status = 'pending', completed_at = NULL WHERE id = 1",
	).run();
	for (const table of [
		"public_releases",
		"public_packages",
		"public_projection_generations",
		"releases",
		"package_release_history",
		"packages",
		"package_profile_heads",
		"package_profile_revisions",
	]) {
		await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
	}
});

describe("profile installability reconciliation route", () => {
	it.each([
		["missing", undefined],
		["incorrect", "Bearer wrong-token"],
	])("rejects a %s reconciliation token", async (_name, authorization) => {
		const headers = authorization === undefined ? undefined : { authorization };
		const response = await SELF.fetch("https://test/_internal/reconcile/profile-installability", {
			method: "POST",
			headers,
		});

		expect(response.status).toBe(401);
	});

	it("accepts the configured reconciliation token", async () => {
		const response = await SELF.fetch("https://test/_internal/reconcile/profile-installability", {
			method: "POST",
			headers: { authorization: "Bearer test-reconciliation-token" },
		});

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			status: "complete",
			pending: 0,
		});
	});
});

describe("profile installability reconciliation", () => {
	it("re-fetches a current package that has no retained profile head", async () => {
		await testEnv.DB.prepare(
			`INSERT INTO packages
			   (did, slug, type, license, authors, security, record_blob, verified_at, indexed_at)
			 VALUES (?, 'unpointed', 'emdash-plugin', 'MIT', '[]', '[]', ?, ?, ?)`,
		)
			.bind(DID, new Uint8Array([1]), NOW.toISOString(), NOW.toISOString())
			.run();
		const activateProjection = vi.fn(async () => ({
			generation: "unpointed-reconciled",
			packages: 1,
			releases: 0,
		}));

		const result = await reconcileProfileInstallability({
			db: testEnv.DB,
			resolver: resolverStub(),
			verify: async () => verifiedProfile("unpointed", "bafy-unpointed", true),
			now: () => NOW,
			activateProjection,
		});

		expect(result.status).toBe("complete");
		expect(
			await testEnv.DB.prepare(
				`SELECT p.installability_status, h.current_cid
				 FROM packages p
				 JOIN package_profile_heads h ON h.did = p.did AND h.slug = p.slug
				 WHERE p.did = ? AND p.slug = 'unpointed'`,
			)
				.bind(DID)
				.first(),
		).toEqual({ installability_status: "valid", current_cid: "bafy-unpointed" });
		expect(activateProjection).toHaveBeenCalledOnce();
	});

	it("retries transient profiles, completes a partial run, and becomes a no-op", async () => {
		await seedPendingProfile("valid", "bafy-valid");
		await seedPendingProfile("missing", "bafy-missing");
		await seedPendingProfile("retry", "bafy-retry");
		await testEnv.DB.prepare(
			`UPDATE packages
			 SET installability_status = 'invalid',
			     installability_error = 'PROFILE_EXTENSION_MISSING'
			 WHERE did = ? AND slug = 'valid'`,
		)
			.bind(DID)
			.run();

		let retryAvailable = false;
		const verify = vi.fn(async ({ rkey }: { rkey: string }) => {
			if (rkey === "retry" && !retryAvailable) {
				throw new PdsVerificationError("PDS_NETWORK_ERROR", "temporary outage");
			}
			return verifiedProfile(rkey, `bafy-${rkey}`, rkey !== "missing");
		});
		const activateProjection = vi.fn(async () => ({
			generation: "reconciled",
			packages: 2,
			releases: 0,
		}));
		const deps = {
			db: testEnv.DB,
			resolver: resolverStub(),
			verify,
			now: () => NOW,
			activateProjection,
			concurrency: 2,
		};

		const partial = await reconcileProfileInstallability(deps);
		expect(partial).toEqual({
			status: "retryable",
			processed: 3,
			valid: 1,
			invalid: 1,
			pending: 1,
			projection: null,
		});
		expect(activateProjection).not.toHaveBeenCalled();
		expect(await installabilityRows()).toEqual([
			{ slug: "missing", status: "invalid", error: "PROFILE_EXTENSION_MISSING" },
			{ slug: "retry", status: "pending", error: null },
			{ slug: "valid", status: "valid", error: null },
		]);

		retryAvailable = true;
		const completed = await reconcileProfileInstallability(deps);
		expect(completed).toEqual({
			status: "complete",
			processed: 1,
			valid: 1,
			invalid: 0,
			pending: 0,
			projection: { generation: "reconciled", packages: 2, releases: 0 },
		});
		expect(activateProjection).toHaveBeenCalledTimes(1);
		expect(await revisionCount()).toBe(3);

		const completeNoOp = await reconcileProfileInstallability(deps);
		expect(completeNoOp).toEqual({
			status: "complete",
			processed: 0,
			valid: 0,
			invalid: 0,
			pending: 0,
			projection: null,
		});
		expect(verify).toHaveBeenCalledTimes(4);
		expect(activateProjection).toHaveBeenCalledTimes(1);
	});
});

async function seedPendingProfile(slug: string, cid: string): Promise<void> {
	await ingestPackageProfile(
		testEnv.DB,
		profileJob(slug, cid),
		verifiedProfile(slug, cid, true),
		NOW,
	);
	await testEnv.DB.batch([
		testEnv.DB.prepare(
			`UPDATE packages
				 SET emdash_extension = NULL, installability_status = 'pending',
				     installability_error = NULL
				 WHERE did = ? AND slug = ?`,
		).bind(DID, slug),
		testEnv.DB.prepare(
			`UPDATE package_profile_revisions
				 SET emdash_extension = NULL, installability_status = 'pending',
				     installability_error = NULL
				 WHERE did = ? AND slug = ? AND cid = ?`,
		).bind(DID, slug, cid),
	]);
}

function profileJob(slug: string, cid: string): RecordsJob {
	return {
		did: DID,
		collection: NSID.packageProfile,
		rkey: slug,
		operation: "update",
		cid,
		source: "backfill",
	};
}

function verifiedProfile(slug: string, cid: string, installable: boolean): VerifiedPdsRecord {
	return {
		cid,
		record: {
			$type: NSID.packageProfile,
			id: `at://${DID}/${NSID.packageProfile}/${slug}`,
			slug,
			type: "emdash-plugin",
			license: "MIT",
			authors: [{ name: "Publisher" }],
			security: [{ email: "security@example.test" }],
			...(installable
				? {
						extensions: {
							[NSID.packageProfileExtension]: {
								$type: NSID.packageProfileExtension,
								repository: `https://github.com/example/${slug}`,
							},
						},
					}
				: {}),
		},
		carBytes: new Uint8Array([1, 2, 3]),
	};
}

function resolverStub(): Pick<DidResolver, "resolve"> {
	return {
		resolve: async () => ({
			pds: "https://pds.example.test/",
			publicKey: {} as PublicKey,
			signingKeyId: `${DID}#atproto`,
		}),
	};
}

async function installabilityRows(): Promise<
	Array<{ slug: string; status: string; error: string | null }>
> {
	const result = await testEnv.DB.prepare(
		`SELECT slug, installability_status AS status, installability_error AS error
		 FROM packages ORDER BY slug`,
	).all<{ slug: string; status: string; error: string | null }>();
	return result.results;
}

async function revisionCount(): Promise<number> {
	const row = await testEnv.DB.prepare(
		"SELECT COUNT(*) AS count FROM package_profile_revisions",
	).first<{ count: number }>();
	return row?.count ?? 0;
}
