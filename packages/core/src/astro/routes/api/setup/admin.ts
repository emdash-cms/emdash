/**
 * POST /_emdash/api/setup/admin
 *
 * Step 3 of setup: Start admin creation by returning passkey registration options
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import { generateRegistrationOptions } from "@emdash-cms/auth/passkey";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { getPublicOrigin } from "#api/public-url.js";
import { setupAdminBody } from "#api/schemas.js";
import { createChallengeStore } from "#auth/challenge-store.js";
import { getPasskeyConfig } from "#auth/passkey-config.js";
import { OptionsRepository } from "#db/repositories/options.js";

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash } = locals;

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

		// Parse request body
		const body = await parseBody(request, setupAdminBody);
		if (isParseError(body)) return body;

		// Store admin info in setup state for later
		await options.set("emdash:setup_state", {
			step: "admin",
			email: body.email.toLowerCase(),
			name: body.name || null,
		});

		// Get passkey config
		const url = new URL(request.url);
		const siteName = (await options.get<string>("emdash:site_title")) ?? undefined;
		const siteUrl = getPublicOrigin(url, emdash?.config);
		const passkeyConfig = getPasskeyConfig(url, siteName, siteUrl);

		// Generate registration options
		const challengeStore = createChallengeStore(emdash.db);

		// Create a temporary user object for registration options
		// (not persisted until passkey is verified)
		const tempUser = {
			id: `setup-${Date.now()}`, // Temporary ID
			email: body.email.toLowerCase(),
			name: body.name || null,
		};

		const registrationOptions = await generateRegistrationOptions(
			passkeyConfig,
			tempUser,
			[], // No existing credentials
			challengeStore,
		);

		// Store the temp user ID with the setup state
		await options.set("emdash:setup_state", {
			step: "admin",
			email: body.email.toLowerCase(),
			name: body.name || null,
			tempUserId: tempUser.id,
		});

		return apiSuccess({
			success: true,
			options: registrationOptions,
		});
	} catch (error) {
		return handleError(error, "Failed to create admin", "SETUP_ADMIN_ERROR");
	}
};
