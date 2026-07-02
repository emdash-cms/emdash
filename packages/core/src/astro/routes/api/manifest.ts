/**
 * Admin manifest endpoint - injected by EmDash integration
 *
 * GET /_emdash/api/manifest
 *
 * Returns the admin manifest with collection definitions and plugin info.
 * The manifest is generated from live database schema plus runtime plugin state.
 */

import type { APIRoute } from "astro";

import { handleError } from "#api/error.js";
import { getAuthMode } from "#auth/mode.js";
import { OptionsRepository } from "#db/repositories/options.js";

import { COMMIT, VERSION } from "../../../version.js";
import type { EmDashManifest } from "../../types.js";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
	const { emdash } = locals;

	try {
		// Manifest is built fresh from the live database per admin request.
		// `requestCached` inside `getManifest` dedupes if multiple consumers
		// share the request. Wrapped in try/catch so any future DB-touching
		// additions to `getManifest()` (plugin manifest loading, marketplace
		// lookup, etc.) return the standard error envelope rather than an
		// unstructured 500 — matches the pattern used by the WP execute
		// routes.
		const emdashManifest = emdash ? await emdash.getManifest() : null;

		// Determine auth mode from config
		const authMode = getAuthMode(emdash?.config);

		// Read admin branding from the per-request config plumbed through middleware
		// (same source admin.astro reads from). Reading from a build-time global
		// here was unreliable -- the virtual config module exports the config but
		// doesn't assign it to globalThis, so getStoredConfig() always returned
		// null and the React SPA never received custom logo/siteName/favicon.
		// See issue #835.
		let adminBranding = emdash?.config?.admin;

		// When no build-time `admin.siteName` is configured, brand the admin with
		// the site's own title so multi-site operators can tell backends apart
		// (WordPress-style: wp-admin always shows the site name). Precedence:
		// explicit `admin.siteName` → Site Title (Settings → General) → the title
		// captured by the setup wizard → the bundled "EmDash" default in the SPA.
		if (!adminBranding?.siteName && emdash?.db) {
			try {
				const options = new OptionsRepository(emdash.db);
				const titles = await options.getMany<string>(["site:title", "emdash:site_title"]);
				const siteTitle = titles.get("site:title") || titles.get("emdash:site_title");
				if (siteTitle) {
					adminBranding = { ...adminBranding, siteName: siteTitle };
				}
			} catch {
				// options table may not exist yet (pre-setup) — keep the default.
			}
		}

		// Check if self-signup is enabled (any allowed domain with enabled = 1)
		// Only relevant for passkey auth — external auth providers handle their own signup
		let signupEnabled = false;
		if (emdash?.db && authMode.type === "passkey") {
			try {
				const { sql } = await import("kysely");
				const result = await sql<{ cnt: unknown }>`
					SELECT COUNT(*) as cnt FROM allowed_domains WHERE enabled = 1
				`.execute(emdash.db);
				signupEnabled = Number(result.rows[0]?.cnt ?? 0) > 0;
			} catch {
				// Table may not exist yet, that's fine
			}
		}

		const manifest: EmDashManifest = emdashManifest
			? {
					...emdashManifest,
					authMode: authMode.type === "external" ? authMode.providerType : "passkey",
					signupEnabled,
					admin: adminBranding,
				}
			: {
					version: VERSION,
					commit: COMMIT,
					hash: "default",
					collections: {},
					plugins: {},
					taxonomies: [],
					authMode: "passkey",
					signupEnabled,
					admin: adminBranding,
				};

		return Response.json(
			{ data: manifest },
			{
				headers: {
					"Cache-Control": "private, no-store",
				},
			},
		);
	} catch (error) {
		return handleError(error, "Failed to build manifest", "MANIFEST_BUILD_ERROR");
	}
};
