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
import { resolveSecretsCached } from "#config/secrets.js";

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
		// Resolves env override or DB-stored value. Always non-empty after
		// resolution, so the signature path is never silently disabled.
		// Note: if a separate process signs these (e.g. a preview Worker),
		// it must use the same `EMDASH_PREVIEW_SECRET` env var — the
		// auto-generated DB value is per-deployment.
		const { previewSecret: secret, previewSecretSource } = await resolveSecretsCached(emdash.db);
		const parsed = parsePreviewSignatureHeader(previewSig);
		if (!parsed) {
			console.warn("[snapshot] Failed to parse X-Preview-Signature header");
		} else {
			authorized = await verifyPreviewSignature(parsed.source, parsed.exp, parsed.sig, secret);
			if (!authorized) {
				const fields: Record<string, unknown> = {
					source: parsed.source,
					exp: parsed.exp,
					expired: parsed.exp < Date.now() / 1000,
					secretSource: previewSecretSource,
				};
				if (previewSecretSource === "db") {
					fields.hint =
						"Set EMDASH_PREVIEW_SECRET in both this process and the signing process to share secrets across deployments";
				}
				console.warn("[snapshot] Preview signature verification failed", fields);
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
