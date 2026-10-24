// POST /_emdash/api/setup stores the site title and tagline entered in the
// wizard on a site whose first request already auto-seeded the template's.

import type { APIContext } from "astro";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const templateSettings = vi.hoisted(() => ({
	title: "Acme",
	tagline: "Build products people actually want",
}));

vi.mock("virtual:emdash/seed", () => ({
	seed: { version: "1", settings: { ...templateSettings }, collections: [] },
	userSeed: null,
}));

import { POST as postSetup } from "../../../src/astro/routes/api/setup/index.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import { applySeed } from "../../../src/seed/apply.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const SITE_URL = "https://site.example";

const authConfigs = [
	{ mode: "passkey auth", config: { siteUrl: SITE_URL } },
	{
		mode: "external auth",
		config: {
			siteUrl: SITE_URL,
			auth: { type: "cloudflare-access", entrypoint: "@emdash-cms/cloudflare/auth" },
		},
	},
];

async function postWizard(
	ctx: DialectTestContext,
	config: object,
	body: { title: string; tagline?: string; includeContent: boolean },
): Promise<Response> {
	const request = new Request(`${SITE_URL}/_emdash/api/setup`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return postSetup({
		params: {},
		url: new URL(request.url),
		request,
		locals: { emdash: { db: ctx.db, config, storage: undefined } },
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub
	} as unknown as APIContext);
}

describeEachDialect("POST /setup site title and tagline", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		await applySeed(
			ctx.db,
			{ version: "1", settings: { ...templateSettings }, collections: [] },
			{ onConflict: "skip" },
		);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it.each(authConfigs)(
		"replaces the template's title and tagline with the wizard's ($mode)",
		async ({ config }) => {
			const response = await postWizard(ctx, config, {
				title: "Persistence Test 729",
				tagline: "Purple Otter 418",
				includeContent: false,
			});
			expect(response.status).toBe(200);

			const options = new OptionsRepository(ctx.db);
			expect(await options.get("site:title")).toBe("Persistence Test 729");
			expect(await options.get("site:tagline")).toBe("Purple Otter 418");
		},
	);

	it("clears the template's tagline when the wizard's tagline is empty", async () => {
		const response = await postWizard(ctx, authConfigs[0]!.config, {
			title: "Persistence Test 729",
			tagline: "",
			includeContent: false,
		});
		expect(response.status).toBe(200);

		const options = new OptionsRepository(ctx.db);
		expect(await options.get("site:tagline")).toBe("");
	});
});
