/**
 * POST /_emdash/api/setup/admin/2fa/verify
 *
 * Complete setup by verifying the first TOTP code for the initial admin account.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { twoFactorCodeBody } from "#api/schemas.js";
import { enableTwoFactor, getTwoFactorState, verifyTwoFactorCode } from "#auth/two-factor.js";
import { OptionsRepository } from "#db/repositories/options.js";

interface SetupAdminTwoFactorState {
	step: "admin";
	authMethod: "2fa";
	userId: string;
	email: string;
	name?: string | null;
}

function isSetupAdminTwoFactorState(value: unknown): value is SetupAdminTwoFactorState {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- runtime guards above
	const record = value as Record<string, unknown>;
	if (record.step !== "admin") return false;
	if (record.authMethod !== "2fa") return false;
	if (typeof record.userId !== "string" || !record.userId) return false;
	if (typeof record.email !== "string" || !record.email) return false;
	if (record.name !== undefined && record.name !== null && typeof record.name !== "string") return false;
	return true;
}

export const POST: APIRoute = async ({ request, locals, session }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		const options = new OptionsRepository(emdash.db);
		const setupComplete = await options.get("emdash:setup_complete");

		if (setupComplete === true || setupComplete === "true") {
			return apiError("SETUP_COMPLETE", "Setup already complete", 400);
		}

		const setupState = await options.get("emdash:setup_state");
		if (!isSetupAdminTwoFactorState(setupState)) {
			return apiError("INVALID_STATE", "Invalid setup state. Please restart setup.", 400);
		}

		const body = await parseBody(request, twoFactorCodeBody);
		if (isParseError(body)) return body;

		const adapter = createKyselyAdapter(emdash.db);
		const user = await adapter.getUserById(setupState.userId);
		if (!user) {
			return apiError("NOT_FOUND", "Setup admin user not found", 404);
		}

		const twoFactor = getTwoFactorState(user);
		if (!twoFactor.pendingSecret) {
			return apiError(
				"TWO_FACTOR_NOT_SETUP",
				"No pending two-factor setup found. Restart setup and try again.",
				400,
			);
		}

		const valid = await verifyTwoFactorCode(twoFactor.pendingSecret, body.code);
		if (!valid) {
			return apiError("INVALID_TWO_FACTOR_CODE", "Invalid verification code", 400);
		}

		const nextData = enableTwoFactor(user.data, twoFactor.pendingSecret);
		await adapter.updateUser(user.id, { data: nextData });

		await options.set("emdash:setup_complete", true);
		await options.delete("emdash:setup_state");

		if (session) {
			session.set("user", { id: user.id });
		}

		return apiSuccess({
			success: true,
			user: {
				id: user.id,
				email: user.email,
				name: user.name,
				role: user.role,
			},
		});
	} catch (error) {
		return handleError(
			error,
			"Failed to verify setup two-factor code",
			"SETUP_ADMIN_2FA_VERIFY_ERROR",
		);
	}
};
