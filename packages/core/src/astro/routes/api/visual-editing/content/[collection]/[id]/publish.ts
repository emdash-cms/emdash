import type { APIRoute } from "astro";

import { apiError } from "#api/error.js";
import { resolveSecretsCached } from "#config/secrets.js";

import {
	VISUAL_ACTION_TOKEN_INVALID,
	verifyVisualEditingActionToken,
} from "../../../../../../../visual-editing/action-token.js";
import { publishContent } from "../../../../content/[collection]/[id]/publish.js";

export const prerender = false;

export const POST: APIRoute = async (context) => {
	const { emdash, user } = context.locals;
	if (!emdash?.db || !user) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	const token = context.request.headers.get("x-emdash-visual-action");
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
	return publishContent(context, "visual-editor");
};
