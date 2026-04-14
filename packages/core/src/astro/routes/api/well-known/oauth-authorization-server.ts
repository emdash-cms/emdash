/**
 * GET /_emdash/.well-known/oauth-authorization-server
 *
 * RFC 8414 Authorization Server Metadata. Tells MCP clients which
 * endpoints to use for OAuth authorization, token exchange, etc.
 *
 * Public, unauthenticated.
 */

import type { APIRoute } from "astro";

import { getPublicOrigin } from "#api/public-url.js";
import { VALID_SCOPES } from "#auth/api-tokens.js";

export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
	const origin = getPublicOrigin(url, locals.emdash?.config);
	const issuer = `${origin}/_emdash`;

	return Response.json(
		{
			issuer,
			authorization_endpoint: `${origin}/_emdash/oauth/authorize`,
			token_endpoint: `${origin}/_emdash/api/oauth/token`,
			scopes_supported: [...VALID_SCOPES],
			response_types_supported: ["code"],
			grant_types_supported: [
				"authorization_code",
				"refresh_token",
				"urn:ietf:params:oauth:grant-type:device_code",
			],
			code_challenge_methods_supported: ["S256"],
			token_endpoint_auth_methods_supported: ["none"],
			client_id_metadata_document_supported: true,
			device_authorization_endpoint: `${origin}/_emdash/api/oauth/device/code`,
		},
		{
			headers: {
				"Cache-Control": "public, max-age=3600",
				"Access-Control-Allow-Origin": "*",
			},
		},
	);
};
