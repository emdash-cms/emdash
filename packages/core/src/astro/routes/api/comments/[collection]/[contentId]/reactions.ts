/**
 * Public comment reaction endpoints (Tier 1 of the best-in-class comments RFC).
 *
 * GET  /_emdash/api/comments/:collection/:contentId/reactions
 *   - Aggregate reaction counts for the content's approved comments, plus the
 *     current visitor's active reactions.
 * POST /_emdash/api/comments/:collection/:contentId/reactions
 *   - Toggle a reaction on a comment. Public, honeypot- and rate-limit-gated.
 *
 * Inherits the `/_emdash/api/comments/` public prefix (no auth); the POST still
 * requires the `X-EmDash-Request: 1` CSRF header like the comment POST.
 */

import type { APIRoute } from "astro";

import { apiError, apiSuccess, handleError, requireDb, unwrapResult } from "#api/error.js";
import { handleReactionCounts, handleReactionToggle } from "#api/handlers/comment-reactions.js";
import { hashIp } from "#api/handlers/comments.js";
import { isParseError, parseBody } from "#api/parse.js";
import { createReactionBody } from "#api/schemas.js";
import { resolveSecretsCached } from "#config/secrets.js";
import { extractRequestMeta } from "#plugins/request-meta.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, request, locals }) => {
	const { emdash } = locals;
	const { collection, contentId } = params;

	if (!collection || !contentId) {
		return apiError("VALIDATION_ERROR", "Collection and content ID required", 400);
	}

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	try {
		// Salted voter hash from request IP (same primitive as comment ip_hash);
		// shared "unknown" bucket when no trusted IP is available.
		const meta = extractRequestMeta(request, emdash.config);
		let voterHash = "unknown";
		if (meta.ip) {
			const { ipSalt } = await resolveSecretsCached(emdash.db);
			voterHash = await hashIp(meta.ip, ipSalt);
		}

		const result = await handleReactionCounts(emdash.db, collection, contentId, voterHash);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to read reactions", "REACTION_COUNTS_ERROR");
	}
};

export const POST: APIRoute = async ({ params, request, locals }) => {
	const { emdash } = locals;
	const { collection, contentId } = params;

	if (!collection || !contentId) {
		return apiError("VALIDATION_ERROR", "Collection and content ID required", 400);
	}

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	try {
		const body = await parseBody(request, createReactionBody);
		if (isParseError(body)) return body;

		// Anti-spam: honeypot — hidden field filled only by bots. Silently accept.
		if (body.website_url) {
			return apiSuccess({ reacted: false, counts: {} });
		}

		const meta = extractRequestMeta(request, emdash.config);
		let voterHash = "unknown";
		if (meta.ip) {
			const { ipSalt } = await resolveSecretsCached(emdash.db);
			voterHash = await hashIp(meta.ip, ipSalt);
		}

		const result = await handleReactionToggle(emdash.db, {
			collection,
			contentId,
			commentId: body.commentId,
			reaction: body.reaction,
			voterHash,
		});

		return unwrapResult(result, 200);
	} catch (error) {
		return handleError(error, "Failed to toggle reaction", "REACTION_TOGGLE_ERROR");
	}
};
