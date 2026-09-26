/** Pins what a refused install or update tells the operator about the sandbox runner. */

import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	handleMarketplaceInstall,
	handleMarketplaceUpdate,
} from "../../../src/api/handlers/marketplace.js";
import { handleRegistryInstall, handleRegistryUpdate } from "../../../src/api/handlers/registry.js";
import type { ApiResult } from "../../../src/api/types.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database as DbSchema } from "../../../src/database/types.js";
import type { SandboxRunner } from "../../../src/plugins/sandbox/types.js";
import type { Storage } from "../../../src/storage/types.js";

const REASON = "the worker has no worker_loaders binding named LOADER";
const MARKETPLACE_URL = "https://marketplace.example.com";
const REGISTRY = { aggregatorUrl: "https://aggregator.test" };

/** Present so the null-storage guard passes; the refusal comes before any storage call. */
const stubStorage = {} as unknown as Storage;

function unavailableRunner(reason?: string): SandboxRunner {
	return {
		isAvailable: () => false,
		isHealthy: () => false,
		...(reason === undefined ? {} : { unavailableReason: () => reason }),
		load: () => Promise.reject(new Error("load is not reached")),
		setEmailSend: () => {},
		terminateAll: async () => {},
	};
}

describe("install and update with an unavailable sandbox runner", () => {
	let db: Kysely<DbSchema>;
	let sqliteDb: BetterSqlite3.Database;

	beforeEach(async () => {
		sqliteDb = new BetterSqlite3(":memory:");
		db = new Kysely<DbSchema>({ dialect: new SqliteDialect({ database: sqliteDb }) });
		await runMigrations(db);
	});

	afterEach(async () => {
		await db.destroy();
		sqliteDb.close();
	});

	const refusals: Array<[string, (runner: SandboxRunner) => Promise<ApiResult<unknown>>]> = [
		[
			"marketplace install",
			(runner) => handleMarketplaceInstall(db, stubStorage, runner, MARKETPLACE_URL, "test-seo"),
		],
		[
			"marketplace update",
			(runner) => handleMarketplaceUpdate(db, stubStorage, runner, MARKETPLACE_URL, "test-seo"),
		],
		[
			"registry install",
			(runner) =>
				handleRegistryInstall(db, stubStorage, runner, REGISTRY, {
					did: "did:plc:abc",
					slug: "gallery",
				}),
		],
		[
			"registry update",
			(runner) => handleRegistryUpdate(db, stubStorage, runner, REGISTRY, "r_dddddddddddddddd"),
		],
	];

	it.each(refusals)("%s appends the reason the runner gives", async (_name, refuse) => {
		const result = await refuse(unavailableRunner(REASON));

		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("SANDBOX_NOT_AVAILABLE");
		expect(result.error?.message).toMatch(new RegExp(`: ${REASON}$`));
	});

	it("uses the plain message for a runner that gives no reason", async () => {
		const result = await handleMarketplaceInstall(
			db,
			stubStorage,
			unavailableRunner(),
			MARKETPLACE_URL,
			"test-seo",
		);

		expect(result.error?.message).toBe("Sandbox runner is required for marketplace plugins");
	});
});
