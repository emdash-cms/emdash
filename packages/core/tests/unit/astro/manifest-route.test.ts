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
import { describe, expect, it } from "vitest";

import { GET as getManifest } from "../../../src/astro/routes/api/manifest.js";

interface ManifestEnvelope {
	data: {
		admin?: { logo?: string; siteName?: string; favicon?: string };
		authMode: string;
		signupEnabled?: boolean;
		collections?: Record<string, unknown>;
		plugins?: Record<string, unknown>;
		taxonomies?: unknown[];
		version?: string;
	};
}

function makeContext(
	adminBranding?: { logo?: string; siteName?: string; favicon?: string },
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
});
