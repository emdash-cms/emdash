/**
 * Registry moderation eligibility gate wired through the real handlers.
 *
 * Drives `handleRegistryInstall`, `handleRegistryUpdate`, and
 * `handleRegistryUpdateCheck` end-to-end with a mocked `DiscoveryClient` so
 * the shared evaluator (release/package/publisher label cascade, CID-bound
 * labels) blocks install/update *before any artifact fetch*, and that an
 * eligibility of "blocked" driven solely by `missing-assessment-pass`
 * (today's default -- no labels flow in production yet) does NOT block.
 */

import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database as DbSchema } from "../../../src/database/types.js";
import type { SandboxRunner } from "../../../src/plugins/sandbox/types.js";
import { PluginStateRepository } from "../../../src/plugins/state.js";
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
		getLatestRelease = getLatestRelease;
		listReleases = listReleases;
		getPackage = getPackage;
	},
}));

const PUBLISHER = "did:plc:abc";
const SLUG = "gallery";
const LABELER = "did:plc:labeler-a";
const PACKAGE_URI = `at://${PUBLISHER}/com.emdashcms.experimental.package.profile/${SLUG}`;
// Real, decodable DASL CIDs -- the moderation evaluator structurally
// validates each label's `cid`.
const PACKAGE_CID = "bafyreiclpjmh2e5ug4oufdmfnz4r4a6o2lrfu5hzgopzjlb3u2v5il5z4a";
const RELEASE_VERSION = "2.0.0";
const RELEASE_URI = `at://${PUBLISHER}/com.emdashcms.experimental.package.release/${SLUG}:${RELEASE_VERSION}`;
const RELEASE_CID = "bafyreig5l2zfc7l5m4zq3r6v4s2wqkd3j7yq5x7x6n2j4h5r3p6s7t2w4e";
const STALE_RELEASE_CID = "bafyreigh2akiscaildc4mscz4uzpcbap5jxg26eecmrf6cmnvkzkjmoixa";

/** Config accepting `LABELER`'s labels -- without this, no label is ever considered (see decision 3). */
const CONFIG = { aggregatorUrl: "https://aggregator.test", acceptLabelers: LABELER };

function label(overrides: Record<string, unknown> = {}) {
	return {
		ver: 1,
		src: LABELER,
		uri: RELEASE_URI,
		cid: RELEASE_CID,
		cts: "2026-07-10T12:00:00.000Z",
		...overrides,
	};
}

function packageView(labels: unknown[] = []) {
	return {
		uri: PACKAGE_URI,
		cid: PACKAGE_CID,
		did: PUBLISHER,
		slug: SLUG,
		indexedAt: "2026-07-01T00:00:00.000Z",
		profile: {},
		labels,
	};
}

function releaseView(labels: unknown[] = []) {
	return {
		did: PUBLISHER,
		package: SLUG,
		version: RELEASE_VERSION,
		uri: RELEASE_URI,
		cid: RELEASE_CID,
		labels,
		mirrors: [],
		release: {
			package: SLUG,
			version: RELEASE_VERSION,
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

describe("registry moderation eligibility gate", () => {
	let db: Kysely<DbSchema>;
	let handleRegistryInstall: typeof import("../../../src/api/handlers/registry.js").handleRegistryInstall;
	let handleRegistryUpdate: typeof import("../../../src/api/handlers/registry.js").handleRegistryUpdate;
	let handleRegistryUpdateCheck: typeof import("../../../src/api/handlers/registry.js").handleRegistryUpdateCheck;
	const stubSandbox = { isAvailable: () => true } as unknown as SandboxRunner;
	let fetchSpy: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		({ handleRegistryInstall, handleRegistryUpdate, handleRegistryUpdateCheck } =
			await import("../../../src/api/handlers/registry.js"));
		const sqlite = new BetterSqlite3(":memory:");
		db = new Kysely<DbSchema>({ dialect: new SqliteDialect({ database: sqlite }) });
		await runMigrations(db);

		getLatestRelease.mockReset();
		listReleases.mockReset();
		getPackage.mockReset();
		fetchSpy = vi.fn(() => {
			throw new Error("artifact fetch must not run when the moderation gate rejects");
		});
		vi.stubGlobal("fetch", fetchSpy);
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		await db.destroy();
	});

	describe("handleRegistryInstall", () => {
		it("blocks with RELEASE_BLOCKED before any artifact fetch on an automated-block label", async () => {
			getPackage.mockResolvedValue(packageView());
			getLatestRelease.mockResolvedValue(releaseView([label({ val: "malware" })]));

			const result = await handleRegistryInstall(db, stubStorage, stubSandbox, CONFIG, {
				did: PUBLISHER,
				slug: SLUG,
			});

			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("RELEASE_BLOCKED");
			expect(result.error?.details).toMatchObject({ blockingLabels: ["malware"] });
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it("blocks with RELEASE_YANKED when security-yanked is among the blocking labels", async () => {
			getPackage.mockResolvedValue(packageView());
			getLatestRelease.mockResolvedValue(releaseView([label({ val: "security-yanked" })]));

			const result = await handleRegistryInstall(db, stubStorage, stubSandbox, CONFIG, {
				did: PUBLISHER,
				slug: SLUG,
			});

			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("RELEASE_YANKED");
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it("cascades a package-URI takedown label from the package view", async () => {
			getPackage.mockResolvedValue(
				packageView([label({ uri: PACKAGE_URI, cid: undefined, val: "!takedown" })]),
			);
			getLatestRelease.mockResolvedValue(releaseView());

			const result = await handleRegistryInstall(db, stubStorage, stubSandbox, CONFIG, {
				did: PUBLISHER,
				slug: SLUG,
			});

			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("RELEASE_BLOCKED");
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it("cascades a publisher-DID compromise label", async () => {
			getPackage.mockResolvedValue(
				packageView([label({ uri: PUBLISHER, cid: undefined, val: "publisher-compromised" })]),
			);
			getLatestRelease.mockResolvedValue(releaseView());

			const result = await handleRegistryInstall(db, stubStorage, stubSandbox, CONFIG, {
				did: PUBLISHER,
				slug: SLUG,
			});

			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("RELEASE_BLOCKED");
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it("does not block on a CID-stale label that no longer matches the release", async () => {
			getPackage.mockResolvedValue(packageView());
			getLatestRelease.mockResolvedValue(
				releaseView([label({ val: "malware", cid: STALE_RELEASE_CID })]),
			);

			const result = await handleRegistryInstall(db, stubStorage, stubSandbox, CONFIG, {
				did: PUBLISHER,
				slug: SLUG,
			});

			expect(result.error?.code).not.toBe("RELEASE_BLOCKED");
			expect(result.error?.code).not.toBe("RELEASE_YANKED");
		});

		it("does not block a warning-only release", async () => {
			getPackage.mockResolvedValue(packageView());
			getLatestRelease.mockResolvedValue(releaseView([label({ val: "suspicious-code" })]));

			const result = await handleRegistryInstall(db, stubStorage, stubSandbox, CONFIG, {
				did: PUBLISHER,
				slug: SLUG,
			});

			expect(result.error?.code).not.toBe("RELEASE_BLOCKED");
			expect(result.error?.code).not.toBe("RELEASE_YANKED");
		});

		it("does not block pending or error assessment labels", async () => {
			getPackage.mockResolvedValue(packageView());

			getLatestRelease.mockResolvedValue(releaseView([label({ val: "assessment-pending" })]));
			const pending = await handleRegistryInstall(db, stubStorage, stubSandbox, CONFIG, {
				did: PUBLISHER,
				slug: SLUG,
			});
			expect(pending.error?.code).not.toBe("RELEASE_BLOCKED");

			getLatestRelease.mockResolvedValue(releaseView([label({ val: "assessment-error" })]));
			const errored = await handleRegistryInstall(db, stubStorage, stubSandbox, CONFIG, {
				did: PUBLISHER,
				slug: SLUG,
			});
			expect(errored.error?.code).not.toBe("RELEASE_BLOCKED");
		});

		it("blocks a malware label even when a co-present pending or error label re-ranks eligibility", async () => {
			getPackage.mockResolvedValue(packageView());

			getLatestRelease.mockResolvedValue(
				releaseView([label({ val: "malware" }), label({ val: "assessment-pending" })]),
			);
			const pending = await handleRegistryInstall(db, stubStorage, stubSandbox, CONFIG, {
				did: PUBLISHER,
				slug: SLUG,
			});
			expect(pending.error?.code).toBe("RELEASE_BLOCKED");

			getLatestRelease.mockResolvedValue(
				releaseView([label({ val: "malware" }), label({ val: "assessment-error" })]),
			);
			const errored = await handleRegistryInstall(db, stubStorage, stubSandbox, CONFIG, {
				did: PUBLISHER,
				slug: SLUG,
			});
			expect(errored.error?.code).toBe("RELEASE_BLOCKED");
		});

		it("fails closed when a block label collides with a same-cts negation", async () => {
			getPackage.mockResolvedValue(packageView());
			getLatestRelease.mockResolvedValue(
				releaseView([label({ val: "malware" }), label({ val: "malware", neg: true })]),
			);

			const result = await handleRegistryInstall(db, stubStorage, stubSandbox, CONFIG, {
				did: PUBLISHER,
				slug: SLUG,
			});

			expect(result.error?.code).toBe("RELEASE_BLOCKED");
		});

		it("does not block when no acceptLabelers policy is configured (no client-side enforcement)", async () => {
			getPackage.mockResolvedValue(packageView());
			getLatestRelease.mockResolvedValue(releaseView([label({ val: "malware" })]));

			const result = await handleRegistryInstall(
				db,
				stubStorage,
				stubSandbox,
				{ aggregatorUrl: "https://aggregator.test" },
				{ did: PUBLISHER, slug: SLUG },
			);

			expect(result.error?.code).not.toBe("RELEASE_BLOCKED");
		});
	});

	describe("handleRegistryUpdate", () => {
		beforeEach(async () => {
			const repo = new PluginStateRepository(db);
			await repo.upsert("r_gallery000000000", "1.0.0", "active", {
				source: "registry",
				registryPublisherDid: PUBLISHER,
				registrySlug: SLUG,
			});
		});

		it("blocks with RELEASE_BLOCKED before any artifact fetch on an automated-block label", async () => {
			getPackage.mockResolvedValue(packageView());
			getLatestRelease.mockResolvedValue(releaseView([label({ val: "malware" })]));

			const result = await handleRegistryUpdate(
				db,
				stubStorage,
				stubSandbox,
				CONFIG,
				"r_gallery000000000",
			);

			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("RELEASE_BLOCKED");
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it("blocks with RELEASE_YANKED when security-yanked is among the blocking labels", async () => {
			getPackage.mockResolvedValue(packageView());
			getLatestRelease.mockResolvedValue(releaseView([label({ val: "security-yanked" })]));

			const result = await handleRegistryUpdate(
				db,
				stubStorage,
				stubSandbox,
				CONFIG,
				"r_gallery000000000",
			);

			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("RELEASE_YANKED");
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it("cascades a package/publisher-scope block that release-only checking used to miss", async () => {
			getPackage.mockResolvedValue(
				packageView([label({ uri: PACKAGE_URI, cid: undefined, val: "!takedown" })]),
			);
			getLatestRelease.mockResolvedValue(releaseView());

			const result = await handleRegistryUpdate(
				db,
				stubStorage,
				stubSandbox,
				CONFIG,
				"r_gallery000000000",
			);

			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("RELEASE_BLOCKED");
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it("does not block a warning-only release", async () => {
			getPackage.mockResolvedValue(packageView());
			getLatestRelease.mockResolvedValue(releaseView([label({ val: "suspicious-code" })]));

			const result = await handleRegistryUpdate(
				db,
				stubStorage,
				stubSandbox,
				CONFIG,
				"r_gallery000000000",
			);

			expect(result.error?.code).not.toBe("RELEASE_BLOCKED");
			expect(result.error?.code).not.toBe("RELEASE_YANKED");
		});

		it("does not block on a CID-stale label that no longer matches the release", async () => {
			getPackage.mockResolvedValue(packageView());
			getLatestRelease.mockResolvedValue(
				releaseView([label({ val: "malware", cid: STALE_RELEASE_CID })]),
			);

			const result = await handleRegistryUpdate(
				db,
				stubStorage,
				stubSandbox,
				CONFIG,
				"r_gallery000000000",
			);

			expect(result.error?.code).not.toBe("RELEASE_BLOCKED");
			expect(result.error?.code).not.toBe("RELEASE_YANKED");
		});
	});

	describe("handleRegistryUpdateCheck", () => {
		beforeEach(async () => {
			const repo = new PluginStateRepository(db);
			await repo.upsert("r_gallery000000000", "1.0.0", "active", {
				source: "registry",
				registryPublisherDid: PUBLISHER,
				registrySlug: SLUG,
			});
		});

		it("carries the moderation field for a blocked latest release, without an extra getPackage call", async () => {
			getLatestRelease.mockResolvedValue(releaseView([label({ val: "malware" })]));

			const result = await handleRegistryUpdateCheck(db, CONFIG);

			expect(result.success).toBe(true);
			if (!result.success) throw new Error("unreachable");
			expect(result.data.items).toHaveLength(1);
			expect(result.data.items[0]?.moderation?.eligibility).toBe("blocked");
			expect(result.data.items[0]?.moderation?.blockingLabels).toContain("malware");
			expect(getPackage).not.toHaveBeenCalled();
		});

		it("carries a defined moderation field for a clean release with no labels", async () => {
			getLatestRelease.mockResolvedValue(releaseView());

			const result = await handleRegistryUpdateCheck(db, CONFIG);

			expect(result.success).toBe(true);
			if (!result.success) throw new Error("unreachable");
			expect(result.data.items[0]?.moderation).toBeDefined();
			expect(result.data.items[0]?.moderation?.blockingLabels).toEqual([]);
		});
	});
});
