import type { Kysely } from "kysely";
import { beforeEach, describe, it, expect, afterEach, vi } from "vitest";

vi.mock("astro:middleware", () => ({ defineMiddleware: (handler: unknown) => handler }));
vi.mock("virtual:emdash/config", () => ({ default: { objectCacheEnabled: false } }));

import onRequest from "../../src/astro/middleware/request-context.js";
import type { Database } from "../../src/database/types.js";
import { runWithContext } from "../../src/request-context.js";
import {
	getSiteSettings,
	setSiteSettings,
	__setSiteSettingsCacheForTests,
	invalidateSiteSettingsCache,
} from "../../src/settings/index.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../utils/test-db.js";

describe("site settings isolate cache", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		invalidateSiteSettingsCache();
	});

	it("renders current settings on an anonymous route-cache fill without an object cache", async () => {
		await setSiteSettings({ title: "Fresh" }, db);
		__setSiteSettingsCacheForTests({ title: "Stale" });
		const url = new URL("https://example.com/");
		const context = {
			url,
			request: new Request(url),
			cookies: { get: vi.fn() },
			locals: {},
			cache: { enabled: true, set: vi.fn() },
		} as unknown as Parameters<typeof onRequest>[0];

		const response = await runWithContext({ editMode: false, db }, () =>
			onRequest(context, async () => new Response((await getSiteSettings()).title)),
		);

		expect(await response.text()).toBe("Fresh");
	});

	it("uses the isolate cache outside of route-cache fills", async () => {
		await setSiteSettings({ title: "Fresh" }, db);
		__setSiteSettingsCacheForTests({ title: "Stale" });

		const settings = await runWithContext({ editMode: false, db }, () => getSiteSettings());

		expect(settings.title).toBe("Stale");
	});
});
