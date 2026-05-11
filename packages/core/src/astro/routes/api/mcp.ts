/**
 * MCP Streamable HTTP endpoint
 *
 * Exposes an MCP server at /_emdash/api/mcp using the Streamable HTTP
 * transport (Web Standard variant). The server runs stateless — each
 * request creates a fresh transport, so no session tracking is needed.
 * Authentication is handled by the existing EmDash auth middleware.
 *
 * POST /_emdash/api/mcp — JSON-RPC tool calls
 * GET  /_emdash/api/mcp — SSE stream (not used in stateless mode)
 * DELETE /_emdash/api/mcp — Session close (not used in stateless mode)
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { APIRoute } from "astro";

import { apiError } from "#api/error.js";
import { createMcpServer } from "#mcp/server.js";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	if (!emdash) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	if (!user) {
		return apiError("UNAUTHORIZED", "Authentication required", 401);
	}

	const server = createMcpServer(emdash);

	try {
		const transport = new WebStandardStreamableHTTPServerTransport({
			// Stateless: no session management
			sessionIdGenerator: undefined,
		});

		await server.connect(transport);

		return await transport.handleRequest(request, {
			authInfo: {
				token: "",
				clientId: "emdash-admin",
				scopes: [],
				extra: {
					emdash,
					userId: user.id,
					userRole: user.role,
					tokenScopes: locals.tokenScopes,
				},
			},
		});
	} catch (error) {
		console.error("[MCP]", error);
		await server.close().catch(() => {});

		return new Response(
			JSON.stringify({
				jsonrpc: "2.0",
				error: {
					code: -32603,
					message: "Internal server error",
				},
				id: null,
			}),
			{
				status: 500,
				headers: {
					"Content-Type": "application/json",
					"Cache-Control": "private, no-store",
				},
			},
		);
	}
};

/**
 * GET — SSE stream. Not used in stateless mode.
 */
export const GET: APIRoute = async () => {
	return new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			error: {
				code: -32000,
				message: "Method not allowed. This is a stateless MCP endpoint — use POST.",
			},
			id: null,
		}),
		{
			status: 405,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "private, no-store",
			},
		},
	);
};

/**
 * DELETE — Session close. Not used in stateless mode.
 */
export const DELETE: APIRoute = async () => {
	return new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			error: {
				code: -32000,
				message: "Method not allowed. This is a stateless MCP endpoint.",
			},
			id: null,
		}),
		{
			status: 405,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "private, no-store",
			},
		},
	);
};
