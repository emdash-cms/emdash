/**
 * POST /_emdash/api/setup/admin/verify
 *
 * Complete admin creation by verifying the passkey registration
 */

import type { APIRoute } from "astro";
import virtualConfig from "virtual:emdash/config";

export const prerender = false;

import { Role, secureCompare } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import { verifyRegistrationResponse, registerPasskey } from "@emdash-cms/auth/passkey";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { getPublicOrigin } from "#api/public-url.js";
import { setupAdminVerifyBody } from "#api/schemas.js";
import { getConfiguredAllowedOrigins, validateAllowedOrigins } from "#auth/allowed-origins.js";
import { createChallengeStore } from "#auth/challenge-store.js";
import { getPasskeyConfig } from "#auth/passkey-config.js";
import { SETUP_NONCE_COOKIE } from "#auth/setup-nonce.js";
import { OptionsRepository } from "#db/repositories/options.js";
import { getDb } from "../../../../loader.js";

export const POST: APIRoute = async ({ cookies, request, locals }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		const db = emdash?.db ?? (await getDb());
		const config = emdash?.config ?? virtualConfig;

		// Check if setup is already complete
		const options = new OptionsRepository(db);
		const setupComplete = await options.get("emdash:setup_complete");

		if (setupComplete === true || setupComplete === "true") {
			return apiError("SETUP_COMPLETE", "Setup already complete", 400);
		}

		// Check if any users exist
		const adapter = createKyselyAdapter(db);
		const userCount = await adapter.countUsers();

		if (userCount > 0) {
			return apiError("ADMIN_EXISTS", "Admin user already exists", 400);
		}

		// Get setup state
		const setupState = await options.get<{
			step?: string;
			email?: string;
			name?: string | null;
			nonce?: string;
		}>("emdash:setup_state");

		if (!setupState || setupState.step !== "admin") {
			return apiError("INVALID_STATE", "Invalid setup state. Please restart setup.", 400);
		}

		// Verify the session nonce. The cookie was minted by POST /setup/admin
		// and stored alongside setup_state; presenting a matching cookie is
		// proof that this verify call comes from the same browser that
		// started the admin step. Constant-time compare to avoid leaking the
		// stored value through timing.
		const cookieNonce = cookies.get(SETUP_NONCE_COOKIE)?.value;
		if (!setupState.nonce || !cookieNonce || !secureCompare(cookieNonce, setupState.nonce)) {
			return apiError(
				"INVALID_STATE",
				"Setup session expired or tampered with. Please restart the admin step.",
				400,
			);
		}

		if (!setupState.email) {
			return apiError("INVALID_STATE", "Invalid setup state. Please restart setup.", 400);
		}

		// Parse request body
		const body = await parseBody(request, setupAdminVerifyBody);
		if (isParseError(body)) return body;

		// Get passkey config
		const url = new URL(request.url);
		const siteName = (await options.get<string>("emdash:site_title")) ?? undefined;
		const siteUrl = getPublicOrigin(url, config);
		const allowedOrigins = validateAllowedOrigins(
			siteUrl,
			getConfiguredAllowedOrigins(config),
		);
		const passkeyConfig = getPasskeyConfig(url, siteName, siteUrl, allowedOrigins);

		// Verify the registration response
		const challengeStore = createChallengeStore(db);

		const verified = await verifyRegistrationResponse(
			passkeyConfig,
			body.credential,
			challengeStore,
		);

		// Create the admin user
		const user = await adapter.createUser({
			email: setupState.email,
			name: setupState.name ?? null,
			role: Role.ADMIN,
			emailVerified: false, // No email verification for first user
		});

		// Register the passkey
		await registerPasskey(adapter, user.id, verified, "Setup passkey");

		// Mark setup as complete
		await options.set("emdash:setup_complete", true);

		// Clean up setup state and the session nonce cookie
		await options.delete("emdash:setup_state");
		cookies.delete(SETUP_NONCE_COOKIE, { path: "/_emdash/" });

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
		return handleError(error, "Failed to verify admin setup", "SETUP_VERIFY_ERROR");
	}
};
