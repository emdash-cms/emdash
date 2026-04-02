/**
 * POST /_emdash/api/setup/admin/2fa/start
 *
 * Alternative setup flow: create the first admin and initialize TOTP 2FA.
 * Requires magic-link email to be configured so the admin can sign in later.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { Role } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import {
	buildOtpAuthUrl,
	generateTwoFactorSecret,
	getTwoFactorState,
	setTwoFactorPendingSecret,
} from "#auth/two-factor.js";
import { OptionsRepository } from "#db/repositories/options.js";

interface SetupAdminState {
	step: "admin";
	email: string;
	name?: string | null;
	authMethod?: "passkey" | "2fa";
	userId?: string;
}

function isSetupAdminState(value: unknown): value is SetupAdminState {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- runtime guards above
	const record = value as Record<string, unknown>;
	if (record.step !== "admin") return false;
	if (typeof record.email !== "string" || !record.email) return false;
	if (record.name !== undefined && record.name !== null && typeof record.name !== "string") {
		return false;
	}
	if (record.authMethod !== undefined && record.authMethod !== "passkey" && record.authMethod !== "2fa") {
		return false;
	}
	if (record.userId !== undefined && typeof record.userId !== "string") return false;
	return true;
}

export const POST: APIRoute = async ({ locals }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	if (!emdash.email?.isAvailable()) {
		return apiError(
			"EMAIL_NOT_CONFIGURED",
			"2FA setup requires magic-link email to be configured.",
			400,
		);
	}

	try {
		const options = new OptionsRepository(emdash.db);
		const setupComplete = await options.get("emdash:setup_complete");

		if (setupComplete === true || setupComplete === "true") {
			return apiError("SETUP_COMPLETE", "Setup already complete", 400);
		}

		const setupState = await options.get("emdash:setup_state");
		if (!isSetupAdminState(setupState)) {
			return apiError("INVALID_STATE", "Invalid setup state. Please restart setup.", 400);
		}

		const adapter = createKyselyAdapter(emdash.db);

		if (setupState.authMethod === "2fa" && setupState.userId) {
			const existingUser = await adapter.getUserById(setupState.userId);
			if (existingUser) {
				const current2fa = getTwoFactorState(existingUser);
				if (current2fa.pendingSecret) {
					const siteName = (await options.get<string>("emdash:site_title")) ?? "EmDash";
					return apiSuccess({
						secret: current2fa.pendingSecret,
						otpAuthUrl: buildOtpAuthUrl(current2fa.pendingSecret, existingUser.email, siteName),
					});
				}
			}
		}

		const userCount = await adapter.countUsers();
		if (userCount > 0) {
			return apiError("ADMIN_EXISTS", "Admin user already exists", 400);
		}

		const user = await adapter.createUser({
			email: setupState.email,
			name: setupState.name ?? null,
			role: Role.ADMIN,
			emailVerified: false,
		});

		const secret = generateTwoFactorSecret();
		const nextData = setTwoFactorPendingSecret(user.data, secret);
		await adapter.updateUser(user.id, { data: nextData });

		await options.set("emdash:setup_state", {
			step: "admin",
			email: setupState.email,
			name: setupState.name ?? null,
			authMethod: "2fa",
			userId: user.id,
		});

		const siteName = (await options.get<string>("emdash:site_title")) ?? "EmDash";
		return apiSuccess({
			secret,
			otpAuthUrl: buildOtpAuthUrl(secret, user.email, siteName),
		});
	} catch (error) {
		return handleError(
			error,
			"Failed to initialize setup 2FA flow",
			"SETUP_ADMIN_2FA_START_ERROR",
		);
	}
};
