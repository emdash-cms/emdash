import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as installPlugin } from "../../../src/astro/routes/api/admin/plugins/marketplace/[id]/install.js";
import type { Database } from "../../../src/database/types.js";
import { PluginStateRepository } from "../../../src/plugins/state.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("marketplace install route", () => {
	let db: Kysely<Database>;
	let fetchSpy: ReturnType<typeof vi.fn>;
	let syncMarketplacePlugins: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		fetchSpy = vi.fn(async () => new Response("Not found", { status: 404 }));
		vi.stubGlobal("fetch", fetchSpy);
		syncMarketplacePlugins = vi.fn();
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		await teardownTestDatabase(db);
	});

	const makeContext = (
		id: string,
		plugins: { configuredPlugins?: { id: string }[]; sandboxedPluginEntries?: { id: string }[] },
	) =>
		({
			params: { id },
			request: new Request(`http://localhost/_emdash/api/admin/plugins/marketplace/${id}/install`, {
				method: "POST",
			}),
			locals: {
				emdash: {
					db,
					storage: {},
					config: { marketplace: "https://marketplace.example.com" },
					configuredPlugins: plugins.configuredPlugins ?? [],
					sandboxedPluginEntries: plugins.sandboxedPluginEntries ?? [],
					getSandboxRunner: () => ({ isAvailable: () => true }),
					isSandboxBypassed: () => false,
					syncMarketplacePlugins,
					runPluginInstallLifecycle: vi.fn(),
				},
				user: { id: "u1", role: Role.ADMIN },
			},
		}) as unknown as Parameters<typeof installPlugin>[0];

	it.each([
		["plugins: []", { configuredPlugins: [{ id: "newsletter" }] }],
		["sandboxed: []", { sandboxedPluginEntries: [{ id: "newsletter" }] }],
	])("rejects an ID used by a %s entry", async (_label, plugins) => {
		const response = await installPlugin(makeContext("newsletter", plugins));

		expect(response.status).toBe(409);
		const body = (await response.json()) as { error: { code: string } };
		expect(body.error.code).toBe("PLUGIN_ID_CONFLICT");
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(syncMarketplacePlugins).not.toHaveBeenCalled();
		expect(await new PluginStateRepository(db).get("newsletter")).toBeNull();
	});
});
