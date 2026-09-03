/**
 * Environment-compatibility gate wired through the real handler.
 *
 * `registry-env-compat.test.ts` exercises the gate's decision helper in
 * isolation. This file drives `handleRegistryUpdate` end-to-end with a mocked
 * `DiscoveryClient` so the wiring is covered: that `assertEnvCompatible` runs
 * after release selection, that `opts.hostEnv` reaches it, and that an
 * `ENV_INCOMPATIBLE` result aborts *before* any artifact fetch.
 */

import { inspectPackageReleaseRecords } from "@emdash-cms/registry-verification";
import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database as DbSchema } from "../../../src/database/types.js";
import type { SandboxRunner } from "../../../src/plugins/sandbox/types.js";
import { PluginStateRepository } from "../../../src/plugins/state.js";
import type { AuthoritativeRecordReader } from "../../../src/registry/authoritative-records.js";
import type { Storage } from "../../../src/storage/types.js";

/** A storage stub: present so the null-storage guard passes, never exercised. */
const stubStorage = {
	async download() {
		throw new Error("not implemented");
	},
} as unknown as Storage;

const getLatestRelease = vi.fn();
const listReleases = vi.fn();
const getPackage = vi.fn();

vi.mock("@emdash-cms/registry-client/discovery", () => ({
	DiscoveryClient: class {
		labelerPolicy = { enforcement: "required" as const };
		getLatestRelease = getLatestRelease;
		listReleases = listReleases;
		getPackage = getPackage;
	},
	registryLabelerPolicy: (acceptLabelers?: string) => ({
		enforcement: "required",
		acceptLabelers,
	}),
}));

const PUBLISHER = "did:plc:abc";
const SLUG = "gallery";

/**
 * A release view shaped enough to pass the update handler's identity
 * cross-check and reach the env gate, carrying a `requires` block.
 */

function releaseViewWithRequires(
	version: string,
	requires: Record<string, string>,
	labels: unknown[] = [],
) {
	const uri = `at://${PUBLISHER}/com.emdashcms.experimental.package.release/${SLUG}:${version}`;
	const cid = `bafyrei${"a".repeat(52)}`;
	return {
		uri,
		cid,
		did: PUBLISHER,
		package: SLUG,
		version,
		labels,
		artifactCaches: [],
		release: {
			package: SLUG,
			version,
			requires,
			// A real declared artifact URL: if the gate failed to abort, the
			// handler would proceed to fetch this, tripping the `fetch` spy.
			artifacts: {
				package: {
					url: "https://artifacts.test/gallery-2.0.0.tar.gz",
					checksum: "sha256-deadbeef",
				},
			},
		},
	};
}

function packageView(labels: unknown[] = []) {
	return {
		uri: `at://${PUBLISHER}/com.emdashcms.experimental.package.profile/${SLUG}`,
		cid: "bafy-profile",
		did: PUBLISHER,
		slug: SLUG,
		profile: {},
		labels,
	};
}

function authoritativeReader(requires: Record<string, string>): AuthoritativeRecordReader {
	return async (publisherDid, packageSlug, version) => {
		const profile = {
			$type: "com.emdashcms.experimental.package.profile",
			id: "at://" + publisherDid + "/com.emdashcms.experimental.package.profile/" + packageSlug,
			slug: packageSlug,
			type: "emdash-plugin",
			license: "MIT",
			authors: [{ name: "Publisher" }],
			security: [{ email: "security@example.test" }],
			extensions: {
				"com.emdashcms.experimental.package.profileExtension": {
					$type: "com.emdashcms.experimental.package.profileExtension",
					repository: "https://github.com/example/gallery",
				},
			},
		};
		const release = {
			$type: "com.emdashcms.experimental.package.release",
			package: packageSlug,
			version,
			requires,
			artifacts: {
				package: {
					url: "https://artifacts.test/gallery-2.0.0.tar.gz",
					checksum: "bciqexample",
				},
			},
			extensions: {
				"com.emdashcms.experimental.package.releaseExtension": {
					$type: "com.emdashcms.experimental.package.releaseExtension",
					declaredAccess: {},
				},
			},
		};
		const rkey = packageSlug + ":" + version;
		const inspection = await inspectPackageReleaseRecords({
			publisherDid,
			package: packageSlug,
			version,
			rkey,
			profile,
			release,
		});
		if (!inspection.success) throw new Error(inspection.reasons[0]?.message);
		return {
			success: true,
			value: {
				publisherDid,
				packageSlug,
				version,
				profile: {
					uri: profile.id,
					cid: "bafy-profile",
					rkey: packageSlug,
					value: profile,
				},
				release: {
					uri: "at://" + publisherDid + "/com.emdashcms.experimental.package.release/" + rkey,
					cid: `bafyrei${"a".repeat(52)}`,
					rkey,
					value: release,
				},
				inspection,
			},
		};
	};
}

describe("handleRegistryUpdate env gate", () => {
	let db: Kysely<DbSchema>;
	let handleRegistryInstall: typeof import("../../../src/api/handlers/registry.js").handleRegistryInstall;
	let handleRegistryUpdate: typeof import("../../../src/api/handlers/registry.js").handleRegistryUpdate;
	const stubSandbox = { isAvailable: () => true } as unknown as SandboxRunner;
	const config = { aggregatorUrl: "https://aggregator.test" };
	let fetchSpy: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		({ handleRegistryInstall, handleRegistryUpdate } =
			await import("../../../src/api/handlers/registry.js"));
		const sqlite = new BetterSqlite3(":memory:");
		db = new Kysely<DbSchema>({ dialect: new SqliteDialect({ database: sqlite }) });
		await runMigrations(db);

		const repo = new PluginStateRepository(db);
		await repo.upsert("r_gallery000000000", "1.0.0", "active", {
			source: "registry",
			registryPublisherDid: PUBLISHER,
			registrySlug: SLUG,
		});

		getLatestRelease.mockReset();
		listReleases.mockReset();
		getPackage.mockReset();
		getPackage.mockResolvedValue(packageView());
		fetchSpy = vi.fn(() => {
			throw new Error("artifact fetch must not run when the env gate rejects");
		});
		vi.stubGlobal("fetch", fetchSpy);
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		await db.destroy();
	});

	it("rejects with ENV_INCOMPATIBLE and fetches no artifact when the host fails `requires`", async () => {
		getLatestRelease.mockResolvedValue(
			releaseViewWithRequires("2.0.0", { "env:astro": ">=4.0.0" }),
		);

		const result = await handleRegistryUpdate(
			db,
			stubStorage,
			stubSandbox,
			config,
			"r_gallery000000000",
			{
				hostEnv: { "env:emdash": "1.2.0", "env:astro": "4.16.0" },
				readAuthoritativeRecords: authoritativeReader({ "env:astro": ">=5.0.0" }),
			},
		);

		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("ENV_INCOMPATIBLE");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("does not reject when the host satisfies `requires` (gate passes through)", async () => {
		getLatestRelease.mockResolvedValue(
			releaseViewWithRequires("2.0.0", { "env:astro": ">=999.0.0" }),
		);

		const result = await handleRegistryUpdate(
			db,
			stubStorage,
			stubSandbox,
			config,
			"r_gallery000000000",
			{
				hostEnv: { "env:emdash": "1.2.0", "env:astro": "4.16.0" },
				readAuthoritativeRecords: authoritativeReader({ "env:astro": ">=4.0.0" }),
			},
		);

		// The gate passes; the update proceeds past it. With null storage the
		// handler then fails downstream — but never with ENV_INCOMPATIBLE.
		expect(result.error?.code).not.toBe("ENV_INCOMPATIBLE");
	});

	it("rejects an invalid direct repository proof even when the aggregator record looks valid", async () => {
		getLatestRelease.mockResolvedValue(
			releaseViewWithRequires("2.0.0", { "env:astro": ">=4.0.0" }),
		);

		const result = await handleRegistryUpdate(
			db,
			stubStorage,
			stubSandbox,
			config,
			"r_gallery000000000",
			{
				readAuthoritativeRecords: async () => ({
					success: false,
					error: {
						code: "RECORD_PROOF_INVALID",
						message: "The publisher repository proof or commit signature is invalid.",
					},
				}),
			},
		);

		expect(result).toMatchObject({
			success: false,
			error: {
				code: "RECORD_VERIFICATION_FAILED",
				details: { verificationCode: "RECORD_PROOF_INVALID" },
			},
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("preserves release withdrawal independently from listing approval", async () => {
		const version = "2.0.0";
		const uri = `at://${PUBLISHER}/com.emdashcms.experimental.package.release/${SLUG}:${version}`;
		const cid = `bafyrei${"a".repeat(52)}`;
		getLatestRelease.mockResolvedValue(
			releaseViewWithRequires(version, {}, [
				{
					ver: 1,
					src: "did:plc:labeler",
					uri,
					cid,
					val: "security:yanked",
					cts: "2026-08-24T10:00:00.000Z",
				},
			]),
		);

		const result = await handleRegistryUpdate(
			db,
			stubStorage,
			stubSandbox,
			config,
			"r_gallery000000000",
		);

		expect(result).toMatchObject({ success: false, error: { code: "YANKED" } });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("preserves package withdrawal for updates", async () => {
		const version = "2.0.0";
		getLatestRelease.mockResolvedValue(releaseViewWithRequires(version, {}));
		getPackage.mockResolvedValue(
			packageView([
				{
					ver: 1,
					src: "did:plc:labeler",
					uri: `at://${PUBLISHER}/com.emdashcms.experimental.package.profile/${SLUG}`,
					cid: "bafy-profile",
					val: "security:yanked",
					cts: "2026-08-24T10:00:00.000Z",
				},
			]),
		);

		const result = await handleRegistryUpdate(
			db,
			stubStorage,
			stubSandbox,
			config,
			"r_gallery000000000",
			{ readAuthoritativeRecords: authoritativeReader({}) },
		);

		expect(result).toMatchObject({ success: false, error: { code: "YANKED" } });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("preserves the install handler's RELEASE_YANKED compatibility code", async () => {
		const version = "2.0.0";
		const uri = `at://${PUBLISHER}/com.emdashcms.experimental.package.release/${SLUG}:${version}`;
		const cid = `bafyrei${"a".repeat(52)}`;
		getPackage.mockResolvedValue({ did: PUBLISHER, slug: SLUG, profile: {} });
		getLatestRelease.mockResolvedValue(
			releaseViewWithRequires(version, {}, [
				{
					ver: 1,
					src: "did:plc:labeler",
					uri,
					cid,
					val: "security:yanked",
					cts: "2026-08-24T10:00:00.000Z",
				},
			]),
		);

		const result = await handleRegistryInstall(db, stubStorage, stubSandbox, config, {
			did: PUBLISHER,
			slug: SLUG,
		});

		expect(result).toMatchObject({ success: false, error: { code: "RELEASE_YANKED" } });
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
