import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("virtual:emdash/seed", () => ({
	seed: {
		version: "1",
		settings: {},
		collections: [],
	},
	userSeed: null,
	mediaBasePath: undefined,
}));

import { POST as postSetup } from "../../../src/astro/routes/api/setup/index.js";
import { GET as getRobots } from "../../../src/astro/routes/robots.txt.js";
import { exportSeed } from "../../../src/cli/commands/export-seed.js";
import type { Database } from "../../../src/database/types.js";
import { getSiteSettingsWithDb, setSiteSettings } from "../../../src/settings/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

function buildContext(db: Kysely<Database>, request: Request): APIContext {
	return {
		params: {},
		url: new URL(request.url),
		request,
		locals: {
			emdash: {
				db,
				config: { siteUrl: "https://site.example" },
				storage: undefined,
			},
		},
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub
	} as unknown as APIContext;
}

function setupRequest(): Request {
	return new Request("https://site.example/_emdash/api/setup", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ title: "My Site", includeContent: false }),
	});
}

describe("site staging", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("starts a site created by the setup wizard in staging", async () => {
		const res = await postSetup(buildContext(db, setupRequest()));
		expect(res.status).toBe(200);

		expect((await getSiteSettingsWithDb(db)).staging).toBe(true);
	});

	it("does not put a site that went live back into staging when setup is posted again", async () => {
		await postSetup(buildContext(db, setupRequest()));
		await setSiteSettings({ staging: false }, db);

		await postSetup(buildContext(db, setupRequest()));

		expect((await getSiteSettingsWithDb(db)).staging).toBe(false);
	});

	it("treats a site without the setting as live", async () => {
		const res = await getRobots(buildContext(db, new Request("https://site.example/robots.txt")));
		expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
	});

	it("lets crawlers fetch pages while staging so they see noindex, without caching robots.txt", async () => {
		await setSiteSettings({ staging: true }, db);

		const res = await getRobots(buildContext(db, new Request("https://site.example/robots.txt")));
		const body = await res.text();
		expect(body).toContain("Allow: /");
		expect(body).not.toMatch(/^Disallow: \/$/m);
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	it("serves custom robots.txt content uncached while staging", async () => {
		await setSiteSettings({ staging: true, seo: { robotsTxt: "User-agent: *\nAllow: /" } }, db);

		const res = await getRobots(buildContext(db, new Request("https://site.example/robots.txt")));
		expect(await res.text()).toContain("User-agent: *\nAllow: /");
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	it("serves the regular robots.txt after going live", async () => {
		await setSiteSettings({ staging: true }, db);
		await setSiteSettings({ staging: false }, db);

		const res = await getRobots(buildContext(db, new Request("https://site.example/robots.txt")));
		expect(await res.text()).toContain("Sitemap: https://site.example/sitemap.xml");
		expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
	});

	it("keeps the staging status out of exported seeds", async () => {
		await setSiteSettings({ title: "Demo", staging: false }, db);

		const seed = await exportSeed(db);

		expect(seed.settings).toEqual({ title: "Demo" });
	});
});
