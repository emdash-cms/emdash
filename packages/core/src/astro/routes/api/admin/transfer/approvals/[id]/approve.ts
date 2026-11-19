/**
 * POST /_emdash/api/admin/transfer/approvals/:id/approve
 *
 * Approves a pending transfer grant. Signed-in sessions only: bearer tokens
 * (including the MCP caller that requested the grant) are refused.
 */

import type { APIRoute } from "astro";

import { requireAnyPerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { handleApprovalDecide } from "#api/handlers/transfer.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	if (!user) return apiError("UNAUTHORIZED", "Authentication required", 401);
	const denied = requireAnyPerm(user, ["transfer:export", "transfer:import"]);
	if (denied) return denied;
	if (locals.tokenScopes !== undefined) {
		return apiError("FORBIDDEN", "Transfer approvals require a signed-in session", 403);
	}

	return unwrapResult(
		await handleApprovalDecide(emdash.db, {
			approvalId: params.id ?? "",
			decision: "approve",
			user,
		}),
	);
};
