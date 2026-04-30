/**
 * POST /_emdash/api/setup/admin
 *
 * Step 3 of setup: Start admin creation by returning passkey registration options
 */

import type { APIRoute } from "astro";
import virtualConfig from "virtual:emdash/config";

export const prerender = false;

import { generateToken } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import { generateRegistrationOptions } from "@emdash-cms/auth/passkey";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { getPublicOrigin } from "#api/public-url.js";
import { setupAdminBody } from "#api/schemas.js";
import { createChallengeStore } from "#auth/challenge-store.js";
import { getPasskeyConfig } from "#auth/passkey-config.js";
import { SETUP_NONCE_COOKIE, SETUP_NONCE_MAX_AGE_SECONDS } from "#auth/setup-nonce.js";
import { OptionsRepository } from "#db/repositories/options.js";

import { getDb } from "../../../../loader.js";

export const POST: APIRoute = async ({ cookies, request, locals }) => {
	const { emdash } = locals;

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

		// Parse request body
		const body = await parseBody(request, setupAdminBody);
		if (isParseError(body)) return body;

		// Preserve title/tagline from step 1 by reading existing setup state
		// before we overwrite it below.
		const existingState = await options.get<Record<string, unknown>>("emdash:setup_state");

		// Mint a fresh session nonce. This binds the follow-up
		// /setup/admin/verify call to the same browser that made this
		// request, so an unauthenticated attacker on another host cannot
		// substitute their own email into the setup state during the
		// setup window. Rotates on every call so a legitimate retry
		// always gets a working session.
		const nonce = generateToken();

		// Get passkey config
		const url = new URL(request.url);
		const siteName = (await options.get<string>("emdash:site_title")) ?? undefined;
		const siteUrl = getPublicOrigin(url, config);
		const passkeyConfig = getPasskeyConfig(url, siteName, siteUrl);

		// Generate registration options
		const challengeStore = createChallengeStore(db);

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

		// Store the nonce alongside the rest of the setup state, preserving
		// title/tagline from step 1. The verify endpoint will constant-time
		// compare the nonce with the incoming cookie.
		await options.set("emdash:setup_state", {
			...existingState,
			step: "admin",
			email: body.email.toLowerCase(),
			name: body.name || null,
			tempUserId: tempUser.id,
			nonce,
		});

		// HttpOnly + SameSite=Strict + path-scoped. The cookie must not be
		// accessible to JS (nothing in the admin UI needs to read it) and
		// must not be sent on cross-site navigations. The /_emdash/ path
		// scope keeps it away from user-authored frontend code.
		//
		// Derive `secure` from the public origin, not the internal request
		// URL. Behind a TLS-terminating reverse proxy the internal hop is
		// often `http:` while the browser-facing origin is `https:` —
		// using `url.protocol` there would drop the Secure flag on a
		// sensitive cookie over the public HTTPS connection.
		const publicOrigin = new URL(siteUrl);
		cookies.set(SETUP_NONCE_COOKIE, nonce, {
			path: "/_emdash/",
			httpOnly: true,
			sameSite: "strict",
			secure: publicOrigin.protocol === "https:",
			maxAge: SETUP_NONCE_MAX_AGE_SECONDS,
		});

		return apiSuccess({
			success: true,
			options: registrationOptions,
		});
	} catch (error) {
		return handleError(error, "Failed to create admin", "SETUP_ADMIN_ERROR");
	}
};
