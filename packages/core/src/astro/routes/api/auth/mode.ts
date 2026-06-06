/**
 * GET /_emdash/api/auth/mode
 *
 * Public endpoint that returns the active authentication mode.
 * Used by the login page to determine which login UI to render.
 *
 * Unlike the full manifest endpoint, this is intentionally public
 * and returns only the auth mode — no collection schemas, plugin
 * info, or other internal details.
 */

import type { APIRoute } from "astro";

import { getAuthMode } from "#auth/mode.js";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
	const { emdash } = locals;

	const authMode = getAuthMode(emdash?.config);

	// Only check signup for passkey auth (external providers handle their own)
	let signupEnabled = false;
	if (emdash?.db && authMode.type === "passkey") {
		try {
			const { sql } = await import("kysely");
			const result = await sql<{ cnt: unknown }>`
				SELECT COUNT(*) as cnt FROM allowed_domains WHERE enabled = 1
			`.execute(emdash.db);
			signupEnabled = Number(result.rows[0]?.cnt ?? 0) > 0;
		} catch {
			// Table may not exist yet
		}
	}

	// Collect pluggable auth providers (from authProviders config)
	const providers = (emdash?.config?.authProviders ?? []).map((p) => ({
		id: p.id,
		label: p.label,
	}));

	return Response.json(
		{
			data: {
				authMode: authMode.type === "external" ? authMode.providerType : "passkey",
				signupEnabled,
				providers,
			},
		},
		{
			headers: {
				"Cache-Control": "private, no-store",
			},
		},
	);
};
