/**
 * POST /_emdash/api/auth/atproto/login
 *
 * Initiates the AT Protocol OAuth flow by generating an authorization URL.
 * The client should redirect the browser to the returned URL.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import type { ActorIdentifier } from "@atcute/lexicons";
import { apiError, apiSuccess, handleError, isParseError, parseBody } from "emdash/api/route-utils";
import { atprotoLoginBody } from "emdash/api/schemas";

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		const body = await parseBody(request, atprotoLoginBody);
		if (isParseError(body)) return body;

		const url = new URL(request.url);
		const baseUrl = url.origin;

		const { getAtprotoOAuthClient } = await import("@emdash-cms/plugin-atproto/oauth-client");
		const client = await getAtprotoOAuthClient(baseUrl, emdash.db);

		const { url: authUrl } = await client.authorize({
			target: { type: "account", identifier: body.handle as ActorIdentifier },
		});

		return apiSuccess({ url: authUrl.toString() });
	} catch (error) {
		return handleError(error, "Failed to start AT Protocol login", "ATPROTO_LOGIN_ERROR");
	}
};
