/**
 * Typegen endpoint - generates emdash-env.d.ts content
 *
 * POST /_emdash/api/typegen - Generate types and return as JSON
 * GET /_emdash/api/typegen - Return types as text (for preview/debugging)
 *
 * The caller (integration or CLI) is responsible for writing the file to disk.
 * This endpoint only generates the content — it has no filesystem access,
 * which is essential for Cloudflare Workers where process.cwd() is "/" and
 * node:fs may not be available.
 *
 * Dev-only endpoint - disabled in production.
 */

import type { APIRoute } from "astro";

import { apiError, apiSuccess, handleError } from "#api/error.js";

export const prerender = false;

/**
 * GET - Return types as plain text (for preview/debugging)
 */
export const GET: APIRoute = async ({ locals }) => {
	if (!import.meta.env.DEV) {
		return apiError("FORBIDDEN", "Typegen is only available in development", 403);
	}

	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash not configured", 500);
	}

	try {
		const { generateEnvTypes } = await import("#schema/env-types.js");
		const { types } = await generateEnvTypes(emdash.db);

		return new Response(types, {
			status: 200,
			headers: {
				"Content-Type": "text/typescript",
				"Cache-Control": "private, no-store",
			},
		});
	} catch (error) {
		return handleError(error, "Typegen failed", "TYPEGEN_ERROR");
	}
};

/**
 * POST - Generate types and return as JSON
 *
 * The caller writes the file to disk. Response shape:
 * { types: string, hash: string, collections: number }
 */
export const POST: APIRoute = async ({ locals }) => {
	if (!import.meta.env.DEV) {
		return apiError("FORBIDDEN", "Typegen is only available in development", 403);
	}

	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash not configured", 500);
	}

	try {
		const { generateEnvTypes } = await import("#schema/env-types.js");
		const result = await generateEnvTypes(emdash.db);

		return apiSuccess(result);
	} catch (error) {
		return handleError(error, "Typegen failed", "TYPEGEN_ERROR");
	}
};
