/**
 * POST /_emdash/api/auth/invite/register-options
 *
 * Generate WebAuthn registration options for an invited user.
 * Validates the invite token and creates a temporary user identity
 * for the passkey registration flow.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { validateInvite, InviteError } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import { generateRegistrationOptions } from "@emdash-cms/auth/passkey";
import { ulid } from "ulidx";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { inviteRegisterOptionsBody } from "#api/schemas.js";
import { createChallengeStore } from "#auth/challenge-store.js";
import { getPasskeyConfig } from "#auth/passkey-config.js";
import { OptionsRepository } from "#db/repositories/options.js";

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		const body = await parseBody(request, inviteRegisterOptionsBody);
		if (isParseError(body)) return body;

		// Validate the invite token to get the email
		const adapter = createKyselyAdapter(emdash.db);
		const invite = await validateInvite(adapter, body.token);

		// Get passkey config
		const url = new URL(request.url);
		const options = new OptionsRepository(emdash.db);
		const siteName = (await options.get<string>("emdash:site_title")) ?? undefined;
		const passkeyConfig = getPasskeyConfig(url, siteName);

		// Generate registration options with a temporary user identity
		const challengeStore = createChallengeStore(emdash.db);
		const tempUser = {
			id: ulid(),
			email: invite.email,
			name: body.name || null,
		};

		const registrationOptions = await generateRegistrationOptions(
			passkeyConfig,
			tempUser,
			[],
			challengeStore,
		);

		return apiSuccess({ options: registrationOptions });
	} catch (error) {
		if (error instanceof InviteError) {
			const statusMap: Record<string, number> = {
				invalid_token: 404,
				token_expired: 410,
				user_exists: 409,
			};
			return apiError(error.code.toUpperCase(), error.message, statusMap[error.code] ?? 400);
		}

		return handleError(
			error,
			"Failed to generate registration options",
			"INVITE_REGISTER_OPTIONS_ERROR",
		);
	}
};
