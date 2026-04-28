/**
 * Theme preview signing endpoint
 *
 * POST /_emdash/api/themes/preview
 *
 * Generates a signed preview URL for the "Try with my data" feature.
 *
 * Uses the resolved preview secret: env override (`EMDASH_PREVIEW_SECRET`)
 * wins, otherwise an auto-generated stable per-site value persisted in the
 * options table is used. If the verifying side runs in a separate process
 * (e.g. a remote preview Worker), set `EMDASH_PREVIEW_SECRET` in **both**
 * processes — the auto-generated value is per-deployment and won't match
 * across processes.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess } from "#api/error.js";
import { getPublicOrigin } from "#api/public-url.js";
import { resolveSecretsCached } from "#config/secrets.js";

export const prerender = false;

export const POST: APIRoute = async ({ request, url, locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "plugins:read");
	if (denied) return denied;

	// Always non-empty after resolution; env override wins, otherwise a
	// stable DB-stored value is used.
	const { previewSecret: secret } = await resolveSecretsCached(emdash.db);

	let body: { previewUrl: string };
	try {
		body = await request.json();
	} catch {
		return apiError("INVALID_REQUEST", "Invalid JSON body", 400);
	}

	if (!body.previewUrl || typeof body.previewUrl !== "string") {
		return apiError("INVALID_REQUEST", "previewUrl is required", 400);
	}

	// Validate previewUrl is a valid HTTPS URL
	let parsedPreviewUrl: URL;
	try {
		parsedPreviewUrl = new URL(body.previewUrl);
	} catch {
		return apiError("INVALID_REQUEST", "previewUrl must be a valid URL", 400);
	}

	if (parsedPreviewUrl.protocol !== "https:") {
		return apiError("INVALID_REQUEST", "previewUrl must use HTTPS", 400);
	}

	const source = getPublicOrigin(url, emdash?.config);
	const ttl = 3600; // 1 hour
	const exp = Math.floor(Date.now() / 1000) + ttl;

	// HMAC-SHA256 sign: message = "source:exp"
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const buffer = await crypto.subtle.sign("HMAC", key, encoder.encode(`${source}:${exp}`));
	const sig = Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");

	const previewUrl = new URL(body.previewUrl);
	previewUrl.searchParams.set("source", source);
	previewUrl.searchParams.set("exp", String(exp));
	previewUrl.searchParams.set("sig", sig);

	return apiSuccess({ url: previewUrl.toString() });
};
