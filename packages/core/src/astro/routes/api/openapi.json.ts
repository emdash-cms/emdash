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
	if (!cachedSpec) {
		const { emdash } = locals;
		const doc = generateOpenApiDocument({ maxUploadSize: emdash?.config.maxUploadSize });
		cachedSpec = JSON.stringify(doc);
	}

	return new Response(cachedSpec, {
		status: 200,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "public, max-age=3600",
			"Access-Control-Allow-Origin": "*",
		},
	});
};
