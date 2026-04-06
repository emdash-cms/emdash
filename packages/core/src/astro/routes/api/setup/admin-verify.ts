/**
 * POST /_emdash/api/setup/admin/verify
 *
 * Complete admin creation by verifying the passkey registration
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { Role } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import { verifyRegistrationResponse, registerPasskey } from "@emdash-cms/auth/passkey";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { setupAdminVerifyBody } from "#api/schemas.js";
import { createChallengeStore } from "#auth/challenge-store.js";
import { getPasskeyConfig } from "#auth/passkey-config.js";
import { OptionsRepository } from "#db/repositories/options.js";

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash } = locals;
	const passkeyPublicOrigin = emdash?.config.passkeyPublicOrigin;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		// Check if setup is already complete
		const options = new OptionsRepository(emdash.db);
		const setupComplete = await options.get("emdash:setup_complete");

		if (setupComplete === true || setupComplete === "true") {
			return apiError("SETUP_COMPLETE", "Setup already complete", 400);
		}

		// Check if any users exist
		const adapter = createKyselyAdapter(emdash.db);
		const userCount = await adapter.countUsers();

		if (userCount > 0) {
			return apiError("ADMIN_EXISTS", "Admin user already exists", 400);
		}

		// Get setup state
		const setupState = await options.get("emdash:setup_state");

		if (!setupState || setupState.step !== "admin") {
			return apiError("INVALID_STATE", "Invalid setup state. Please restart setup.", 400);
		}

		// Parse request body
		const body = await parseBody(request, setupAdminVerifyBody);
		if (isParseError(body)) return body;

		// Get passkey config
		const url = new URL(request.url);
		const siteName = (await options.get<string>("emdash:site_title")) ?? undefined;
		const passkeyConfig = getPasskeyConfig(url, siteName, passkeyPublicOrigin);

		// Verify the registration response
		const challengeStore = createChallengeStore(emdash.db);

		const verified = await verifyRegistrationResponse(
			passkeyConfig,
			body.credential,
			challengeStore,
		);

		// Create the admin user
		const user = await adapter.createUser({
			email: setupState.email,
			name: setupState.name,
			role: Role.ADMIN,
			emailVerified: false, // No email verification for first user
		});

		// Register the passkey
		await registerPasskey(adapter, user.id, verified, "Setup passkey");

		// Mark setup as complete
		await options.set("emdash:setup_complete", true);

		// Clean up setup state
		await options.delete("emdash:setup_state");

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
