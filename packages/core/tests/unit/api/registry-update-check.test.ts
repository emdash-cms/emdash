/**
 * Env gate + annotation in the bulk registry update check
 * (`handleRegistryUpdateCheck`).
 *
 * The update-check endpoint must never present an update the update handler
 * would refuse with `ENV_INCOMPATIBLE`: when the latest release's `requires`
 * excludes the host, the item reports `hasUpdate: false` alongside
 * `envCompatible: false` and the structured mismatch list (same shape the
 * update handler's `ENV_INCOMPATIBLE.details` carries). Unparseable `requires`
 * keeps the documented fails-open behavior (`hasUpdate: true`), and one
 * plugin's aggregator failure still skips only that plugin.
 *
 * Uses a real in-memory SQLite database and a mocked `DiscoveryClient`.
 */

import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteCompatDatabase as BetterSqlite3 } from "#node-sqlite";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database as DbSchema } from "../../../src/database/types.js";
import { PluginStateRepository } from "../../../src/plugins/state.js";

const getLatestRelease = vi.fn();

vi.mock("@emdash-cms/registry-client/discovery", () => ({
	DiscoveryClient: class {
		labelerPolicy = { enforcement: "required" as const };
		getLatestRelease = getLatestRelease;
	},
	registryLabelerPolicy: (acceptLabelers?: string) => ({
		enforcement: "required",
		acceptLabelers,
	}),
}));

const PUBLISHER = "did:plc:abc";
const HOST_ENV = { "env:emdash": "1.0.1", "env:astro": "4.16.0" };
const CONFIG = { aggregatorUrl: "https://aggregator.test" };

function releaseView(version: string, requires: unknown) {
	return {
		uri: `at://${PUBLISHER}/com.emdashcms.experimental.package.release/gallery:${version}`,
		cid: `bafyrei${"a".repeat(52)}`,
		did: PUBLISHER,
		package: "gallery",
		version,
		labels: [],
		artifactCaches: [],
		release: {
			package: "gallery",
			version,
			requires,
			artifacts: {
				package: {
					url: `https://artifacts.test/gallery-${version}.tar.gz`,
					checksum: "sha256-deadbeef",
				},
			},
		},
	};
}

describe("handleRegistryUpdateCheck env gate", () => {
	let db: Kysely<DbSchema>;
	let handleRegistryUpdateCheck: typeof import("../../../src/api/handlers/registry.js").handleRegistryUpdateCheck;

	beforeEach(async () => {
		({ handleRegistryUpdateCheck } = await import("../../../src/api/handlers/registry.js"));
		const sqlite = new BetterSqlite3(":memory:");
		db = new Kysely<DbSchema>({ dialect: new SqliteDialect({ database: sqlite }) });
		await runMigrations(db);

		const repo = new PluginStateRepository(db);
		await repo.upsert("r_gallery000000000", "1.0.0", "active", {
			source: "registry",
			registryPublisherDid: PUBLISHER,
			registrySlug: "gallery",
		});
		await repo.upsert("r_forms0000000000a", "0.9.0", "active", {
			source: "registry",
			registryPublisherDid: PUBLISHER,
			registrySlug: "forms",
		});

		getLatestRelease.mockReset();
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await db.destroy();
	});

	it("reports hasUpdate false with the mismatch list when the latest release excludes the host", async () => {
		getLatestRelease.mockImplementation(({ package: slug }: { package: string }) => {
			if (slug === "gallery") {
				return Promise.resolve(releaseView("2.0.0", { "env:emdash": "^2.0.0" }));
			}
			return Promise.resolve(releaseView("1.0.0", {}));
		});

		const result = await handleRegistryUpdateCheck(db, CONFIG, { hostEnv: HOST_ENV });

		expect(result.success).toBe(true);
		const gallery = result.data?.items.find((item) => item.pluginId === "r_gallery000000000");
		expect(gallery).toMatchObject({
			installed: "1.0.0",
			latest: "2.0.0",
			hasUpdate: false,
			envCompatible: false,
			incompatibleConstraints: [{ key: "env:emdash", required: "^2.0.0", host: "1.0.1" }],
		});
	});

	it("reports hasUpdate true when the host satisfies the latest release's requires", async () => {
		getLatestRelease.mockImplementation(({ package: slug }: { package: string }) => {
			if (slug === "gallery") {
				return Promise.resolve(
					releaseView("2.0.0", { "env:emdash": "^1.0.0", "env:astro": ">=4.0.0" }),
				);
			}
			return Promise.resolve(releaseView("1.0.0", {}));
		});

		const result = await handleRegistryUpdateCheck(db, CONFIG, { hostEnv: HOST_ENV });

		expect(result.success).toBe(true);
		expect(result.data?.items.find((item) => item.pluginId === "r_gallery000000000")).toMatchObject(
			{
				latest: "2.0.0",
				hasUpdate: true,
				envCompatible: true,
				incompatibleConstraints: undefined,
			},
		);
	});

	it("fails open (hasUpdate true) when the latest release's requires is unparseable", async () => {
		getLatestRelease.mockImplementation(({ package: slug }: { package: string }) => {
			if (slug === "gallery") {
				return Promise.resolve(releaseView("2.0.0", "not-a-constraint-map"));
			}
			return Promise.resolve(releaseView("1.0.0", {}));
		});

		const result = await handleRegistryUpdateCheck(db, CONFIG, { hostEnv: HOST_ENV });

		expect(result.success).toBe(true);
		expect(result.data?.items.find((item) => item.pluginId === "r_gallery000000000")).toMatchObject(
			{
				latest: "2.0.0",
				hasUpdate: true,
				envCompatible: true,
			},
		);
	});

	it("still skips only the plugin whose aggregator lookup fails", async () => {
		getLatestRelease.mockImplementation(({ package: slug }: { package: string }) => {
			if (slug === "forms") return Promise.reject(new Error("aggregator unreachable"));
			return Promise.resolve(releaseView("2.0.0", { "env:emdash": "^2.0.0" }));
		});

		const result = await handleRegistryUpdateCheck(db, CONFIG, { hostEnv: HOST_ENV });

		expect(result.success).toBe(true);
		expect(result.data?.items.map((item) => item.pluginId)).toEqual(["r_gallery000000000"]);
		expect(result.data?.items[0]).toMatchObject({ hasUpdate: false, envCompatible: false });
	});
});
