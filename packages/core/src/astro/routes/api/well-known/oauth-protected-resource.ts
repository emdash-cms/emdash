/**
 * GET /.well-known/oauth-protected-resource
 *
 * RFC 9728 Protected Resource Metadata. Tells MCP clients where to find
 * the authorization server. Injected at the site root (not under /_emdash/)
 * because RFC 9728 requires it at the well-known URI of the resource's origin.
 *
 * Also serves as `/.well-known/oauth-protected-resource/_emdash/api/mcp`
 * (path-scoped variant) when Astro's routing allows.
 *
 * Public, unauthenticated.
 */

import type { APIRoute } from "astro";

import { getPublicOrigin } from "#api/public-url.js";
import { VALID_SCOPES } from "#auth/api-tokens.js";

export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
	const origin = getPublicOrigin(url, locals.emdash?.config);

	return Response.json(
		{
			resource: `${origin}/_emdash/api/mcp`,
			authorization_servers: [`${origin}/_emdash`],
			scopes_supported: [...VALID_SCOPES],
			bearer_methods_supported: ["header"],
		},
		{
			headers: {
				"Cache-Control": "public, max-age=3600",
				"Access-Control-Allow-Origin": "*",
			},
		},
	);
};
