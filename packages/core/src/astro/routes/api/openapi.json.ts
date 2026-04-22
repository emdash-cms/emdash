/**
 * OpenAPI spec endpoint
 *
 * GET /_emdash/api/openapi.json
 *
 * Returns the generated OpenAPI 3.1 document. The spec is generated once
 * and cached for the lifetime of the process.
 */

import type { APIRoute } from "astro";

import { generateOpenApiDocument } from "../../../api/openapi/index.js";

export const prerender = false;

let cachedSpec: string | null = null;

export const GET: APIRoute = async ({ locals }) => {
	const { emdash } = locals;
	if (!cachedSpec && emdash) {
		try {
			const doc = generateOpenApiDocument({ maxUploadSize: emdash.config.maxUploadSize });
			cachedSpec = JSON.stringify(doc);
		} catch {
			return new Response(
				JSON.stringify({ error: "Failed to generate OpenAPI document: invalid configuration" }),
				{ status: 500, headers: { "Content-Type": "application/json" } },
			);
		}
	}

	const spec = cachedSpec ?? JSON.stringify(generateOpenApiDocument());

	return new Response(spec, {
		status: 200,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "public, max-age=3600",
			"Access-Control-Allow-Origin": "*",
		},
	});
};
