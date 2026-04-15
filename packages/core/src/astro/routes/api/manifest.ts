/**
 * Admin manifest endpoint - injected by EmDash integration
 *
 * GET /_emdash/api/manifest
 *
 * Returns the admin manifest with collection definitions and plugin info.
 * The manifest is generated from the user's live.config.ts at runtime.
 */

import type { APIRoute } from "astro";

import { getAuthMode } from "#auth/mode.js";

import { COMMIT, VERSION } from "../../../version.js";
import type { EmDashManifest } from "../../types.js";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
	const { emdashManifest, emdash } = locals;

	// Determine auth mode from config
	const authMode = getAuthMode(emdash?.config);

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

	const config = emdash?.config;
	const extensions: EmDashManifest["extensions"] =
		config && "extensions" in config
			? (config.extensions as EmDashManifest["extensions"])
			: undefined;

	const manifest: EmDashManifest = emdashManifest
		? {
				...emdashManifest,
				authMode: authMode.type === "external" ? authMode.providerType : "passkey",
				signupEnabled,
				extensions,
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
				extensions,
			};

	return Response.json(
		{ data: manifest },
		{
			headers: {
				"Cache-Control": "private, no-store",
			},
		},
	);
};
