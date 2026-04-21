import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("virtual:emdash/config", () => ({
	default: {
		auth: { mode: "passkey" },
	},
}));

import type { Database as DbSchema } from "../../../src/database/types.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { EmDashManifest } from "../../../src/astro/types.js";
import type { SandboxedPluginEntry } from "../../../src/emdash-runtime.js";
import { createTestRuntime } from "../../utils/test-runtime.js";

const PLUGIN_ID = "emdash-plugin-slack";

const CACHED_MANIFEST_ENTRY = {
	key: "test-manifest-cache-key",
	manifest: {
		version: "0.6.0",
		hash: "stale-hash",
		collections: {},
		plugins: {
			[PLUGIN_ID]: {
				version: "0.1.0",
				enabled: true,
				adminMode: "blocks",
				adminPages: [{ path: "/settings", label: "Settings", icon: "settings" }],
				dashboardWidgets: [],
			},
		},
		authMode: "passkey",
		taxonomies: [],
	} satisfies Partial<EmDashManifest>,
};

function makePluginEntry(label: string): SandboxedPluginEntry {
	return {
		id: PLUGIN_ID,
		version: "0.1.0",
		options: {},
		code: "",
		capabilities: [],
		allowedHosts: [],
		storage: {},
		adminPages: [{ path: "/settings", label, icon: "settings" }],
		adminWidgets: [],
	};
}

describe("manifest cache in dev mode", () => {
	let sqliteDb: Database.Database;
	let db: Kysely<DbSchema>;

	beforeEach(async () => {
		sqliteDb = new Database(":memory:");
		db = new Kysely<DbSchema>({
			dialect: new SqliteDialect({ database: sqliteDb }),
		});
		await runMigrations(db);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await db.destroy();
		sqliteDb.close();
	});

	it("bypasses valid DB cache in dev mode", async () => {
		vi.stubEnv("DEV", true);

		const options = new OptionsRepository(db);
		await options.set("emdash:manifest_cache", CACHED_MANIFEST_ENTRY);

		const runtime = createTestRuntime(db, {
			sandboxedPluginEntries: [makePluginEntry("Slack Notifications")],
		});

		const manifest = await runtime.getManifest();

		expect(manifest.plugins[PLUGIN_ID]?.adminPages?.[0]?.label).toBe("Slack Notifications");
	});

	it("does not persist manifest cache in dev mode", async () => {
		vi.stubEnv("DEV", true);

		const runtime = createTestRuntime(db, {
			sandboxedPluginEntries: [makePluginEntry("Slack Notifications")],
		});

		await runtime.getManifest();

		const options = new OptionsRepository(db);
		const cached = await options.get("emdash:manifest_cache");

		expect(cached).toBeNull();
	});

	it("uses persisted manifest cache outside dev mode", async () => {
		vi.stubEnv("DEV", false);

		const options = new OptionsRepository(db);
		await options.set("emdash:manifest_cache", CACHED_MANIFEST_ENTRY);

		const runtime = createTestRuntime(db, {
			sandboxedPluginEntries: [makePluginEntry("Slack Notifications")],
		});

		const manifest = await runtime.getManifest();

		expect(manifest.plugins[PLUGIN_ID]?.adminPages?.[0]?.label).toBe("Settings");
	});
});
