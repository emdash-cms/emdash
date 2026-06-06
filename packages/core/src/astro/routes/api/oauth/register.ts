/**
 * POST /_emdash/api/oauth/register
 *
 * RFC 7591 Dynamic Client Registration. Public, unauthenticated.
 * MCP clients (e.g. Claude Code) call this to register themselves
 * before starting the OAuth authorization flow.
 */

import type { APIRoute } from "astro";

import { apiError, handleError } from "#api/error.js";
import { handleOAuthClientCreate } from "#api/handlers/oauth-clients.js";

export const prerender = false;

const OAUTH_REGISTRATION_HEADERS: HeadersInit = {
	"Cache-Control": "no-store",
	Pragma: "no-cache",
	// RFC 7591 dynamic client registration is called cross-origin by MCP clients,
	// CLIs, and native apps. The endpoint is anonymous and carries no ambient
	// credentials, so CORS `*` is safe.
	"Access-Control-Allow-Origin": "*",
};

const OAUTH_PREFLIGHT_HEADERS: HeadersInit = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
	"Access-Control-Max-Age": "86400",
};

const SUPPORTED_GRANT_TYPES = new Set([
	"authorization_code",
	"refresh_token",
	"urn:ietf:params:oauth:grant-type:device_code",
]);
const SUPPORTED_RESPONSE_TYPES = new Set(["code"]);

function registrationError(description: string, status = 400): Response {
	return Response.json(
		{
			error: "invalid_client_metadata",
			error_description: description,
		},
		{ status, headers: OAUTH_REGISTRATION_HEADERS },
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseScope(value: unknown): string[] | Response | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") {
		const scopes = value.split(" ").filter(Boolean);
		return scopes.length > 0 ? scopes : undefined;
	}
	if (isStringArray(value)) {
		const scopes = value.filter(Boolean);
		return scopes.length > 0 ? scopes : undefined;
	}
	return registrationError("scope must be a string or array of strings");
}

function parseSupportedStringArray(
	value: unknown,
	field: string,
	supported: ReadonlySet<string>,
): string[] | Response | undefined {
	if (value === undefined) return undefined;
	if (!isStringArray(value)) {
		return registrationError(`${field} must be an array of strings`);
	}
	const invalidValue = value.find((item) => !supported.has(item));
	if (invalidValue) {
		return registrationError(`${field} contains unsupported value: ${invalidValue}`);
	}
	return value;
}

export const OPTIONS: APIRoute = () => {
	return new Response(null, { status: 204, headers: OAUTH_PREFLIGHT_HEADERS });
};

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return registrationError("Request body must be valid JSON");
		}

		if (!isRecord(body)) {
			return registrationError("Request body must be a JSON object");
		}

		// redirect_uris is the only required field per RFC 7591 §2
		if (!isStringArray(body.redirect_uris) || body.redirect_uris.length === 0) {
			return registrationError("redirect_uris must be a non-empty array of strings");
		}

		if (
			body.token_endpoint_auth_method !== undefined &&
			body.token_endpoint_auth_method !== "none"
		) {
			return registrationError("Only token_endpoint_auth_method=none is supported");
		}

		const grantTypes = parseSupportedStringArray(
			body.grant_types,
			"grant_types",
			SUPPORTED_GRANT_TYPES,
		);
		if (grantTypes instanceof Response) {
			return grantTypes;
		}

		const responseTypes = parseSupportedStringArray(
			body.response_types,
			"response_types",
			SUPPORTED_RESPONSE_TYPES,
		);
		if (responseTypes instanceof Response) {
			return responseTypes;
		}

		const scopes = parseScope(body.scope);
		if (scopes instanceof Response) {
			return scopes;
		}

		const clientId = crypto.randomUUID();
		const clientName =
			typeof body.client_name === "string" && body.client_name
				? body.client_name
				: `dynamic-${clientId.slice(0, 8)}`;

		const result = await handleOAuthClientCreate(emdash.db, {
			id: clientId,
			name: clientName,
			redirectUris: body.redirect_uris,
			scopes,
		});

		if (!result.success) {
			return registrationError(result.error.message);
		}

		// RFC 7591 §3.2.1 response
		return Response.json(
			{
				client_id: result.data.id,
				client_id_issued_at: Math.floor(new Date(result.data.createdAt).getTime() / 1000),
				redirect_uris: result.data.redirectUris,
				client_name: result.data.name,
				grant_types: grantTypes ?? ["authorization_code", "refresh_token"],
				response_types: responseTypes ?? ["code"],
				token_endpoint_auth_method: "none",
				scope: result.data.scopes ? result.data.scopes.join(" ") : undefined,
			},
			{ status: 201, headers: OAUTH_REGISTRATION_HEADERS },
		);
	} catch (error) {
		return handleError(error, "Failed to register OAuth client", "CLIENT_REGISTER_ERROR");
	}
};
