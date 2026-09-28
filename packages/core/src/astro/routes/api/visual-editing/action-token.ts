import type { APIRoute } from "astro";

import { apiError, apiSuccess } from "#api/error.js";
import { resolveSecretsCached } from "#config/secrets.js";

import {
	generateVisualEditingActionToken,
	VISUAL_ACTION_TOKEN_INVALID,
	verifyVisualEditingActionToken,
} from "../../../../visual-editing/action-token.js";

export const prerender = false;

export const POST: APIRoute = async ({ locals, request }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	if (!user) return apiError("UNAUTHORIZED", "Authentication required", 401);

	const token = request.headers.get("x-emdash-visual-action");
	if (!token) {
		return apiError(VISUAL_ACTION_TOKEN_INVALID, "Visual editing action token is required", 403);
	}

	const { previewSecret } = await resolveSecretsCached(emdash.db);
	if (!(await verifyVisualEditingActionToken(token, previewSecret, user.id))) {
		return apiError(
			VISUAL_ACTION_TOKEN_INVALID,
			"Visual editing action token is invalid or expired",
			403,
		);
	}

	return apiSuccess({
		token: await generateVisualEditingActionToken(previewSecret, user.id),
	});
};
