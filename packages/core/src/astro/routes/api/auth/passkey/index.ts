/**
 * GET /_emdash/api/auth/passkey
 *
 * List all passkeys for the authenticated user, with the relying party ID and
 * WebAuthn user handle the admin needs to report the list to the browser.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import { encodeBase64urlNoPadding } from "@oslojs/encoding";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { getPublicOrigin } from "#api/public-url.js";
import { getPasskeyConfig } from "#auth/passkey-config.js";

interface PasskeyResponse {
	id: string;
	name: string | null;
	deviceType: "singleDevice" | "multiDevice";
	backedUp: boolean;
	createdAt: string;
	lastUsedAt: string;
}

export const GET: APIRoute = async ({ request, locals }) => {
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
		const credentials = await adapter.getCredentialsByUserId(user.id);

		// Map to public response format (exclude sensitive fields)
		const passkeys: PasskeyResponse[] = credentials.map((cred) => ({
			id: cred.id,
			name: cred.name,
			deviceType: cred.deviceType,
			backedUp: cred.backedUp,
			createdAt: cred.createdAt.toISOString(),
			lastUsedAt: cred.lastUsedAt.toISOString(),
		}));

		const url = new URL(request.url);
		const { rpId } = getPasskeyConfig(url, undefined, getPublicOrigin(url, emdash.config));
		const userHandle = encodeBase64urlNoPadding(new TextEncoder().encode(user.id));

		return apiSuccess({ items: passkeys, rpId, userHandle });
	} catch (error) {
		return handleError(error, "Failed to list passkeys", "PASSKEY_LIST_ERROR");
	}
};
