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

async function robotsTxt(db: Kysely<Database>): Promise<string> {
	const res = await getRobots(buildContext(db, new Request("https://site.example/robots.txt")));
	return res.text();
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
		expect(await robotsTxt(db)).toContain("Allow: /");
	});

	it("disallows all crawlers in robots.txt while staging, even with custom content", async () => {
		await setSiteSettings({ staging: true, seo: { robotsTxt: "User-agent: *\nAllow: /" } }, db);

		const res = await getRobots(buildContext(db, new Request("https://site.example/robots.txt")));
		expect(await res.text()).toBe("User-agent: *\nDisallow: /\n");
		expect(res.headers.get("cache-control")).toBeNull();
	});

	it("serves the regular robots.txt after going live", async () => {
		await setSiteSettings({ staging: true }, db);
		await setSiteSettings({ staging: false }, db);

		const body = await robotsTxt(db);
		expect(body).not.toContain("Disallow: /\n");
		expect(body).toContain("Sitemap: https://site.example/sitemap.xml");
	});

	it("keeps the staging status out of exported seeds", async () => {
		await setSiteSettings({ title: "Demo", staging: false }, db);

		const seed = await exportSeed(db);

		expect(seed.settings).toEqual({ title: "Demo" });
	});
});
