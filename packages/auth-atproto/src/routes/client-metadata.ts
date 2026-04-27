/**
 * GET /.well-known/atproto-client-metadata.json
 *
 * Serves the OAuth client metadata document required by the AT Protocol OAuth spec.
 * The user's PDS fetches this URL during authorization to verify the client.
 */

import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
	const baseUrl = new URL(request.url).origin;

	// Build metadata statically — no keyset or OAuthClient needed.
	// This must be fast because PDS authorization servers fetch it
	// during PAR with short timeouts (~1-2s).
	const metadata = {
		client_id: `${baseUrl}/.well-known/atproto-client-metadata.json`,
		redirect_uris: [`${baseUrl}/_emdash/api/auth/atproto/callback`],
		scope: "atproto transition:generic",
		application_type: "web",
		subject_type: "public",
		response_types: ["code"],
		grant_types: ["authorization_code", "refresh_token"],
		token_endpoint_auth_method: "none",
		dpop_bound_access_tokens: true,
	};

	return new Response(JSON.stringify(metadata), {
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "public, max-age=3600",
			"Access-Control-Allow-Origin": "*",
		},
	});
};
