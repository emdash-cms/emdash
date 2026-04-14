/**
 * Snapshot endpoint — exports a portable database snapshot for preview mode.
 *
 * Security:
 * - Authenticated users: requires content:read + schema:read permissions
 * - Preview services: requires valid X-Preview-Signature header (HMAC-SHA256)
 * - Excludes auth/user/session/token tables
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import {
	generateSnapshot,
	parsePreviewSignatureHeader,
	verifyPreviewSignature,
} from "#api/handlers/snapshot.js";
import { getPublicOrigin } from "#api/public-url.js";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals, url }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	// Check for preview signature auth (used by DO preview services)
	const previewSig = request.headers.get("X-Preview-Signature");
	let authorized = false;

	if (previewSig) {
		const secret = import.meta.env.EMDASH_PREVIEW_SECRET || import.meta.env.PREVIEW_SECRET || "";
		if (!secret) {
			console.warn(
				"[snapshot] X-Preview-Signature header present but no PREVIEW_SECRET configured",
			);
		} else {
			const parsed = parsePreviewSignatureHeader(previewSig);
			if (!parsed) {
				console.warn("[snapshot] Failed to parse X-Preview-Signature header");
			} else {
				authorized = await verifyPreviewSignature(parsed.source, parsed.exp, parsed.sig, secret);
				if (!authorized) {
					console.warn("[snapshot] Preview signature verification failed", {
						source: parsed.source,
						exp: parsed.exp,
						expired: parsed.exp < Date.now() / 1000,
					});
				}
			}
		}
	}

	if (!authorized) {
		// Fall back to standard user auth
		const contentDenied = requirePerm(user, "content:read");
		if (contentDenied) return contentDenied;
		const schemaDenied = requirePerm(user, "schema:read");
		if (schemaDenied) return schemaDenied;
	}

	try {
		const includeDrafts = url.searchParams.get("drafts") === "true";
		const snapshot = await generateSnapshot(emdash.db, {
			includeDrafts,
			origin: getPublicOrigin(url, emdash.config),
		});

		return apiSuccess(snapshot);
	} catch (error) {
		return handleError(error, "Failed to generate snapshot", "SNAPSHOT_ERROR");
	}
};
