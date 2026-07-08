/**
 * Environment-compatibility gate wired through the real handler.
 *
 * `registry-env-compat.test.ts` exercises the gate's decision helper in
 * isolation. This file drives `handleRegistryUpdate` end-to-end with a mocked
 * `DiscoveryClient` so the wiring is covered: that `assertEnvCompatible` runs
 * after release selection, that `opts.hostEnv` reaches it, and that an
 * `ENV_INCOMPATIBLE` result aborts *before* any artifact fetch.
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

/**
 * A release view shaped enough to pass the update handler's identity
 * cross-check and reach the env gate, carrying a `requires` block.
 */
function releaseViewWithRequires(version: string, requires: Record<string, string>) {
	return {
		did: PUBLISHER,
		package: SLUG,
		version,
		labels: [],
		mirrors: [],
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

describe("handleRegistryUpdate env gate", () => {
	let db: Kysely<DbSchema>;
	let handleRegistryUpdate: typeof import("../../../src/api/handlers/registry.js").handleRegistryUpdate;
	const stubSandbox = { isAvailable: () => true } as unknown as SandboxRunner;
	const config = { aggregatorUrl: "https://aggregator.test" };
	let fetchSpy: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		({ handleRegistryUpdate } = await import("../../../src/api/handlers/registry.js"));
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
			releaseViewWithRequires("2.0.0", { "env:astro": ">=5.0.0" }),
		);

		const result = await handleRegistryUpdate(
			db,
			stubStorage,
			stubSandbox,
			config,
			"r_gallery000000000",
			{ hostEnv: { "env:emdash": "1.2.0", "env:astro": "4.16.0" } },
		);

		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("ENV_INCOMPATIBLE");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("does not reject when the host satisfies `requires` (gate passes through)", async () => {
		getLatestRelease.mockResolvedValue(
			releaseViewWithRequires("2.0.0", { "env:astro": ">=4.0.0" }),
		);

		const result = await handleRegistryUpdate(
			db,
			stubStorage,
			stubSandbox,
			config,
			"r_gallery000000000",
			{ hostEnv: { "env:emdash": "1.2.0", "env:astro": "4.16.0" } },
		);

		// The gate passes; the update proceeds past it. With null storage the
		// handler then fails downstream — but never with ENV_INCOMPATIBLE.
		expect(result.error?.code).not.toBe("ENV_INCOMPATIBLE");
	});
});
