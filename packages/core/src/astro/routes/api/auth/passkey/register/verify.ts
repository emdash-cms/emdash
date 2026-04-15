/**
 * POST /_emdash/api/auth/passkey/register/verify
 *
 * Verify and store a new passkey credential (authenticated user)
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import { verifyRegistrationResponse, registerPasskey } from "@emdash-cms/auth/passkey";

import { apiError, apiSuccess } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { getPublicOrigin } from "#api/public-url.js";
import { passkeyRegisterVerifyBody } from "#api/schemas.js";
import { createChallengeStore } from "#auth/challenge-store.js";
import { getPasskeyConfig } from "#auth/passkey-config.js";
import { OptionsRepository } from "#db/repositories/options.js";

const MAX_PASSKEYS = 10;

interface PasskeyResponse {
	id: string;
	name: string | null;
	deviceType: "singleDevice" | "multiDevice";
	backedUp: boolean;
	createdAt: string;
	lastUsedAt: string;
}

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	// Require authentication
	if (!user) {
		return apiError("NOT_AUTHENTICATED", "Not authenticated", 401);
	}

	try {
		const adapter = createKyselyAdapter(emdash.db);

		// Check passkey limit again (in case of concurrent requests)
		const count = await adapter.countCredentialsByUserId(user.id);
		if (count >= MAX_PASSKEYS) {
			return apiError("PASSKEY_LIMIT", `Maximum of ${MAX_PASSKEYS} passkeys allowed`, 400);
		}

		// Parse request body
		const body = await parseBody(request, passkeyRegisterVerifyBody);
		if (isParseError(body)) return body;

		// Get passkey config
		const url = new URL(request.url);
		const optionsRepo = new OptionsRepository(emdash.db);
		const siteName = (await optionsRepo.get<string>("emdash:site_title")) ?? undefined;
		const siteUrl = getPublicOrigin(url, emdash?.config);
		const passkeyConfig = getPasskeyConfig(url, siteName, siteUrl);

		// Verify the registration response
		const challengeStore = createChallengeStore(emdash.db);
		const verified = await verifyRegistrationResponse(
			passkeyConfig,
			body.credential,
			challengeStore,
		);

		// Get passkey name - prefer body.name, then check stored pending name
		let passKeyName: string | undefined = body.name ?? undefined;
		if (!passKeyName) {
			const pending = await optionsRepo.get<{ name?: string }>(`emdash:passkey_pending:${user.id}`);
			if (pending?.name) {
				passKeyName = pending.name;
			}
		}

		// Clean up pending state
		await optionsRepo.delete(`emdash:passkey_pending:${user.id}`);

		// Register the passkey
		const credential = await registerPasskey(adapter, user.id, verified, passKeyName);

		// Return the new passkey info
		const passkey: PasskeyResponse = {
			id: credential.id,
			name: credential.name,
			deviceType: credential.deviceType,
			backedUp: credential.backedUp,
			createdAt: credential.createdAt.toISOString(),
			lastUsedAt: credential.lastUsedAt.toISOString(),
		};

		return apiSuccess({ passkey });
	} catch (error) {
		console.error("Passkey registration verify error:", error);

		// Handle specific errors
		const message = error instanceof Error ? error.message : "";

		// Check for duplicate credential error
		if (message.includes("credential_exists") || message.includes("already")) {
			return apiError("CREDENTIAL_EXISTS", "This passkey is already registered", 400);
		}

		// Check for challenge errors
		if (message.includes("challenge") || message.includes("expired")) {
			return apiError("CHALLENGE_EXPIRED", "Registration expired. Please try again.", 400);
		}

		return apiError("PASSKEY_REGISTER_ERROR", "Registration failed", 500);
	}
};
