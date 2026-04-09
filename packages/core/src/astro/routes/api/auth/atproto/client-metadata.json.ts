/**
 * GET /_emdash/api/auth/atproto/client-metadata.json
 *
 * Serves the OAuth client metadata document for ATProto OAuth.
 * This URL IS the client_id (ATProto convention for public clients).
 *
 * Must be publicly accessible — PDS authorization servers fetch this
 * to validate the client during the OAuth flow.
 */

import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
	const url = new URL(request.url);
	const origin = url.origin;

	const metadata = {
		client_id: `${origin}/_emdash/api/auth/atproto/client-metadata.json`,
		client_name: "EmDash CMS",
		client_uri: origin,
		redirect_uris: [`${origin}/_emdash/api/auth/atproto/callback`],
		grant_types: ["authorization_code"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
		scope: "atproto",
		dpop_bound_access_tokens: true,
		application_type: "web",
	};

	return Response.json(metadata, {
		headers: {
			"Cache-Control": "public, max-age=3600",
			"Content-Type": "application/json",
		},
	});
};
