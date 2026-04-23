/**
 * Preview URL endpoint - generates a signed preview URL for content
 *
 * POST /_emdash/api/content/{collection}/{id}/preview-url
 *
 * Request body:
 * {
 *   expiresIn?: string | number;  // Default: "1h"
 *   pathPattern?: string;         // Default: "/{collection}/{id}"
 * }
 *
 * Response:
 * {
 *   url: string;      // The preview URL with token
 *   expiresAt: number; // Unix timestamp when token expires
 * }
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError, unwrapResult } from "#api/error.js";
import { parseOptionalBody, isParseError } from "#api/parse.js";
import { contentPreviewUrlBody } from "#api/schemas.js";
import { getPreviewUrl } from "#preview/index.js";

export const prerender = false;

const DURATION_PATTERN = /^(\d+)([smhdw])$/;

export const POST: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const denied = requirePerm(user, "content:read_drafts");
	if (denied) return denied;
	const collection = params.collection!;
	const id = params.id!;

	// Get the preview secret from environment
	const previewSecret = import.meta.env.EMDASH_PREVIEW_SECRET || import.meta.env.PREVIEW_SECRET;

	if (!previewSecret) {
		return apiError(
			"NOT_CONFIGURED",
			"Preview not configured. Set EMDASH_PREVIEW_SECRET environment variable.",
			500,
		);
	}

	// Verify the content exists (optional, but good for UX)
	if (emdash?.handleContentGet) {
		const result = await emdash.handleContentGet(collection, id);
		if (!result.success) return unwrapResult(result);
	}

	// Parse request body
	const body = await parseOptionalBody(request, contentPreviewUrlBody, {});
	if (isParseError(body)) return body;

	const expiresIn = body.expiresIn || "1h";
	const pathPattern = body.pathPattern;

	// Calculate expiry timestamp
	const expiresInSeconds = typeof expiresIn === "number" ? expiresIn : parseExpiresIn(expiresIn);
	const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;

	try {
		const url = await getPreviewUrl({
			collection,
			id,
			secret: previewSecret,
			expiresIn,
			pathPattern,
		});

		return apiSuccess({ url, expiresAt });
	} catch (error) {
		return handleError(error, "Failed to generate preview URL", "TOKEN_ERROR");
	}
};

/**
 * Parse duration string to seconds
 */
function parseExpiresIn(duration: string): number {
	const match = duration.match(DURATION_PATTERN);
	if (!match) {
		return 3600; // Default 1 hour
	}

	const value = parseInt(match[1], 10);
	const unit = match[2];

	switch (unit) {
		case "s":
			return value;
		case "m":
			return value * 60;
		case "h":
			return value * 60 * 60;
		case "d":
			return value * 60 * 60 * 24;
		case "w":
			return value * 60 * 60 * 24 * 7;
		default:
			return 3600;
	}
}
