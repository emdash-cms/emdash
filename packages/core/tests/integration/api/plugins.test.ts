/**
 * Plugin admin list handler: a statically-sandboxed entry surfaces flagged
 * sandboxed, and a configured plugin shadows a sandboxed entry with the same id.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handlePluginGet, handlePluginList } from "../../../src/api/handlers/plugins.js";
import type { Database } from "../../../src/database/types.js";
import type { SandboxedPluginEntry } from "../../../src/emdash-runtime.js";
import { PluginStateRepository } from "../../../src/plugins/state.js";
import type { ResolvedPlugin } from "../../../src/plugins/types.js";
import { makeRegistryPluginId } from "../../../src/registry/plugin-id.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

function createTestPlugin(overrides: Partial<ResolvedPlugin> = {}): ResolvedPlugin {
	return {
		id: "trusted-plugin",
		version: "1.0.0",
		capabilities: [],
		allowedHosts: [],
		storage: {},
		admin: { pages: [], widgets: [], fieldWidgets: {} },
		hooks: {},
		routes: {},
		settings: undefined,
		...overrides,
	} as ResolvedPlugin;
}

function createSandboxedEntry(overrides: Partial<SandboxedPluginEntry> = {}): SandboxedPluginEntry {
	return {
		id: "sandboxed-plugin",
		version: "2.1.0",
		options: {},
		code: "",
		capabilities: ["read:content"],
		allowedHosts: [],
		storage: {},
		adminPages: [{ path: "settings" }],
		adminWidgets: [{ id: "status" }],
		...overrides,
	};
}

describe("plugin admin handlers: sandboxed plugins", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("surfaces a sandboxed entry, and a configured plugin shadows one with the same id", async () => {
		const result = await handlePluginList(
			db,
			[createTestPlugin({ id: "shared-id", version: "1.0.0" })],
			[createSandboxedEntry({ id: "sandboxed-only" }), createSandboxedEntry({ id: "shared-id" })],
		);

		expect(result.success).toBe(true);
		if (!result.success) return;

		// A sandboxed-only entry surfaces, flagged.
		const surfaced = result.data.items.filter((p) => p.id === "sandboxed-only");
		expect(surfaced).toHaveLength(1);
		expect(surfaced[0]).toMatchObject({ source: "config", sandboxed: true });

		// A configured plugin with the same id wins; the sandboxed entry is not listed twice.
		const shared = result.data.items.filter((p) => p.id === "shared-id");
		expect(shared).toHaveLength(1);
		expect(shared[0]?.version).toBe("1.0.0");
		expect(shared[0]?.sandboxed).toBeUndefined();
	});

	it("derives hasSettings for runtime-installed plugins from the schema lookup", async () => {
		const stateRepo = new PluginStateRepository(db);
		await stateRepo.upsert("mp-with-settings", "1.0.0", "active", { source: "marketplace" });
		await stateRepo.upsert("mp-without-settings", "1.0.0", "active", { source: "marketplace" });

		const result = await handlePluginList(db, [], [], undefined, (pluginId) =>
			pluginId === "mp-with-settings" ? { apiKey: { type: "secret", label: "API Key" } } : null,
		);

		expect(result.success).toBe(true);
		if (!result.success) return;

		const withSettings = result.data.items.find((p) => p.id === "mp-with-settings");
		const withoutSettings = result.data.items.find((p) => p.id === "mp-without-settings");
		expect(withSettings?.hasSettings).toBe(true);
		expect(withoutSettings?.hasSettings).toBe(false);
	});
});

describe("plugin admin handlers: runtime-installed plugins", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("gets a registry or marketplace install by id with the same info the list shows", async () => {
		const registryId = await makeRegistryPluginId("did:plc:abcdefghijklmnopqrstuvwx", "analytics");
		const stateRepo = new PluginStateRepository(db);
		await stateRepo.upsert(registryId, "0.2.4", "active", {
			source: "registry",
			displayName: "Analytics",
			registryPublisherDid: "did:plc:abcdefghijklmnopqrstuvwx",
			registrySlug: "analytics",
		});
		await stateRepo.upsert("mp-plugin", "1.0.0", "inactive", {
			source: "marketplace",
			marketplaceVersion: "1.0.0",
			displayName: "Marketplace Plugin",
		});
		const marketplaceUrl = "https://marketplace.example.com";
		const settingsSchemaLookup = (pluginId: string) =>
			pluginId === registryId ? { siteId: { type: "string", label: "Site ID" } } : null;

		const list = await handlePluginList(db, [], [], marketplaceUrl, settingsSchemaLookup);
		expect(list.success).toBe(true);
		if (!list.success) return;
		expect(list.data.items).toHaveLength(2);
		expect(list.data.items.find((item) => item.id === "mp-plugin")?.iconUrl).toBe(
			"https://marketplace.example.com/api/v1/plugins/mp-plugin/icon",
		);

		const registry = await handlePluginGet(
			db,
			[],
			[],
			registryId,
			marketplaceUrl,
			settingsSchemaLookup,
		);
		expect(registry).toMatchObject({
			success: true,
			data: { item: { name: "Analytics", hasSettings: true } },
		});

		for (const listed of list.data.items) {
			const result = await handlePluginGet(
				db,
				[],
				[],
				listed.id,
				marketplaceUrl,
				settingsSchemaLookup,
			);
			expect(result).toEqual({ success: true, data: { item: listed } });
		}
	});

	it("does not get a config-source state row whose plugin is no longer configured", async () => {
		await new PluginStateRepository(db).upsert("removed-plugin", "1.0.0", "active");

		const result = await handlePluginGet(db, [], [], "removed-plugin");

		expect(result).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
	});
});
