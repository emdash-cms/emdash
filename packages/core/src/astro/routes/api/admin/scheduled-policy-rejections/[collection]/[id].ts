import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { OptionsRepository } from "#db/repositories/options.js";
import { scheduledPolicyRejectionKey } from "#plugins/content-policy.js";

export const prerender = false;

export const DELETE: APIRoute = async ({ params, locals, url }) => {
	const { emdash, user } = locals;
	const denied = requirePerm(user, "content:publish_any");
	if (denied) return denied;
	if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);

	try {
		const revision = url.searchParams.get("rev");
		if (!revision) return apiError("INVALID_INPUT", "Rejection revision is required", 400);
		const result = await new OptionsRepository(emdash.db).compareAndDelete(
			scheduledPolicyRejectionKey(params.collection!, params.id!),
			revision,
		);
		if (!result.applied) {
			return apiError("CONFLICT", "Scheduled publication rejection has changed", 409);
		}
		return apiSuccess({ dismissed: true });
	} catch (error) {
		return handleError(
			error,
			"Failed to dismiss scheduled publication rejection",
			"POLICY_REJECTION_DISMISS_ERROR",
		);
	}
};
