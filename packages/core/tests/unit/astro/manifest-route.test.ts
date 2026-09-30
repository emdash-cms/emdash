/**
 * Manifest route admin branding.
 *
 * The admin branding (logo, siteName, favicon) configured via the EmDash
 * integration must be reflected in `/_emdash/api/manifest` so the React SPA
 * can render the custom logo and site name. The route reads the branding
 * from the per-request config on `locals.emdash.config.admin` (the same
 * source `admin.astro` uses), not from a build-time global.
 *
 * Regression test for issue #835.
 */

import type { APIContext } from "astro";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as getManifest } from "../../../src/astro/routes/api/manifest.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import {
	describeEachDialect,
	setupForDialect,
	setupTestDatabase,
	teardownForDialect,
	teardownTestDatabase,
	type DialectTestContext,
} from "../../utils/test-db.js";

interface ManifestEnvelope {
	data: {
		admin?: {
			logo?: string;
			siteName?: string;
			footerLabel?: string | false;
			favicon?: string;
		};
		authMode: string;
		signupEnabled?: boolean;
		collections?: Record<string, unknown>;
		plugins?: Record<string, unknown>;
		taxonomies?: unknown[];
		version?: string;
		timezone?: string;
	};
}

function makeContext(
	adminBranding?: {
		logo?: string;
		siteName?: string;
		footerLabel?: string | false;
		favicon?: string;
	},
	manifest?: unknown,
): Parameters<typeof getManifest>[0] {
	const locals = {
		emdash: adminBranding
			? {
					// db is intentionally undefined so the signup-enabled query is skipped.
					config: { admin: adminBranding },
					getManifest: async () => manifest ?? null,
				}
			: undefined,
	};

	return { locals } as unknown as APIContext;
}

describe("manifest route admin branding", () => {
	it("returns admin branding from locals.emdash.config.admin", async () => {
		const branding = {
			logo: "/logo.png",
			siteName: "My Site",
			footerLabel: false,
			favicon: "/favicon.ico",
		};

		const response = await getManifest(makeContext(branding));
		expect(response.status).toBe(200);
		const body = (await response.json()) as ManifestEnvelope;
		expect(body.data.admin).toEqual(branding);
	});

	it("omits the admin field when no branding is configured", async () => {
		const response = await getManifest(makeContext());
		expect(response.status).toBe(200);
		const body = (await response.json()) as ManifestEnvelope;
		expect(body.data.admin).toBeUndefined();
	});

	it("returns admin branding even when getManifest() resolves to a built manifest", async () => {
		const branding = { logo: "/brand.svg", siteName: "Brandname" };
		const ctx = makeContext(branding, {
			version: "test",
			hash: "test",
			collections: {},
			plugins: {},
			taxonomies: [],
		});

		const response = await getManifest(ctx);
		const body = (await response.json()) as ManifestEnvelope;
		expect(body.data.admin).toEqual(branding);
	});

	it("includes the configured site timezone for datetime controls", async () => {
		const db = await setupTestDatabase();
		try {
			await new OptionsRepository(db).set("site:timezone", "Asia/Tokyo");
			const context = {
				locals: {
					emdash: {
						db,
						config: { admin: { siteName: "Configured name" } },
						getManifest: async () => ({
							version: "test",
							hash: "test",
							collections: {},
							plugins: {},
							taxonomies: [],
						}),
					},
				},
			} as unknown as APIContext;

			const response = await getManifest(context);
			const body = (await response.json()) as ManifestEnvelope;
			expect(body.data.timezone).toBe("Asia/Tokyo");
		} finally {
			await teardownTestDatabase(db);
		}
	});
});

describeEachDialect("manifest route saved site logo", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	function makeDatabaseContext(admin?: ManifestEnvelope["data"]["admin"]): APIContext {
		return {
			locals: {
				emdash: {
					db: ctx.db,
					config: { admin },
					getManifest: async () => ({
						version: "test",
						hash: "test",
						collections: {},
						plugins: {},
						taxonomies: [],
					}),
				},
			},
		} as unknown as APIContext;
	}

	it("shows the saved site logo and removes it when the setting is cleared", async () => {
		const media = await new MediaRepository(ctx.db).create({
			filename: "logo.svg",
			mimeType: "image/svg+xml",
			storageKey: "branding/site-logo.svg",
		});
		const options = new OptionsRepository(ctx.db);
		await options.set("site:title", "Saved Site");
		await options.set("site:logo", { mediaId: media.id, alt: "Site logo" });
		const branding = { footerLabel: false as const, favicon: "/favicon.ico" };

		const response = await getManifest(makeDatabaseContext(branding));
		expect(response.status).toBe(200);
		const body = (await response.json()) as ManifestEnvelope;
		expect(body.data.admin).toEqual({
			...branding,
			siteName: "Saved Site",
			logo: "/_emdash/api/media/file/branding/site-logo.svg",
		});

		await options.delete("site:logo");
		const clearedResponse = await getManifest(makeDatabaseContext(branding));
		const clearedBody = (await clearedResponse.json()) as ManifestEnvelope;
		expect(clearedBody.data.admin).toEqual({ ...branding, siteName: "Saved Site" });
	});

	it("keeps an explicitly configured admin logo over the saved site logo", async () => {
		const media = await new MediaRepository(ctx.db).create({
			filename: "logo.svg",
			mimeType: "image/svg+xml",
			storageKey: "site-logo.svg",
		});
		await new OptionsRepository(ctx.db).set("site:logo", { mediaId: media.id });
		const branding = { logo: "/admin-logo.svg", siteName: "Configured Site" };

		const response = await getManifest(makeDatabaseContext(branding));
		const body = (await response.json()) as ManifestEnvelope;
		expect(body.data.admin).toEqual(branding);
	});

	it("falls back to the default branding when the saved logo media is missing", async () => {
		await new OptionsRepository(ctx.db).set("site:logo", { mediaId: "missing-logo" });

		const response = await getManifest(makeDatabaseContext());
		expect(response.status).toBe(200);
		const body = (await response.json()) as ManifestEnvelope;
		expect(body.data.admin).toBeUndefined();
	});
});
