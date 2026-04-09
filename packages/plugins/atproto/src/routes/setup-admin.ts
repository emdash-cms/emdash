/**
 * POST /_emdash/api/setup/atproto-admin
 *
 * Step 2 of setup for atproto auth: initiate OAuth flow with user's PDS.
 * Returns the authorization URL for the client to redirect to.
 *
 * The actual admin creation happens in the OAuth callback
 * (routes/callback.ts) when the PDS redirects back.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import type { ActorIdentifier } from "@atcute/lexicons";
import {
	apiError,
	apiSuccess,
	handleError,
	isParseError,
	OptionsRepository,
	parseBody,
} from "emdash/api/route-utils";
import { setupAtprotoAdminBody } from "emdash/api/schemas";

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

		// Parse request body
		const body = await parseBody(request, setupAtprotoAdminBody);
		if (isParseError(body)) return body;

		// Merge into existing setup state (preserves title/tagline from step 1)
		const existing = (await options.get<Record<string, unknown>>("emdash:setup_state")) ?? {};
		await options.set("emdash:setup_state", {
			...existing,
			step: "atproto_admin",
			handle: body.handle,
		});

		// Get OAuth client and generate authorization URL
		const url = new URL(request.url);
		const baseUrl = url.origin;
		const { getAtprotoOAuthClient } = await import("@emdash-cms/plugin-atproto/oauth-client");
		const client = await getAtprotoOAuthClient(baseUrl, emdash.db);

		const { url: authUrl } = await client.authorize({
			target: { type: "account", identifier: body.handle as ActorIdentifier },
		});

		return apiSuccess({
			url: authUrl.toString(),
		});
	} catch (error) {
		return handleError(error, "Failed to start AT Protocol setup", "SETUP_ATPROTO_ERROR");
	}
};
