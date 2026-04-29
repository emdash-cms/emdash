/**
 * OpenAPI spec endpoint
 *
 * GET /_emdash/api/openapi.json
 *
 * Returns the generated OpenAPI 3.1 document. The spec is generated once
 * and cached for the lifetime of the process.
 */

import type { APIRoute } from "astro";

import { handleError } from "../../../api/error.js";
import { generateOpenApiDocument } from "../../../api/openapi/index.js";

export const prerender = false;

// Use globalThis with Symbol.for to survive Vite's SSR module duplication
const OPENAPI_CACHE_KEY = Symbol.for("emdash.openapi.cachedSpec");

function getCachedSpec(): string | null {
	const val = (globalThis as Record<symbol, unknown>)[OPENAPI_CACHE_KEY];
	return typeof val === "string" ? val : null;
}

function setCachedSpec(spec: string): void {
	(globalThis as Record<symbol, unknown>)[OPENAPI_CACHE_KEY] = spec;
}

export const GET: APIRoute = async ({ locals }) => {
	const { emdash } = locals;

	let spec = getCachedSpec();
	if (!spec && emdash) {
		try {
			const doc = generateOpenApiDocument({ maxUploadSize: emdash.config.maxUploadSize });
			spec = JSON.stringify(doc);
			setCachedSpec(spec);
		} catch (error) {
			return handleError(error, "Failed to generate OpenAPI document", "OPENAPI_ERROR");
		}
	}

	if (!spec) {
		try {
			spec = JSON.stringify(generateOpenApiDocument());
		} catch (error) {
			return handleError(error, "Failed to generate OpenAPI document", "OPENAPI_ERROR");
		}
	}

	return new Response(spec, {
		status: 200,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "private, no-store",
			"Access-Control-Allow-Origin": "*",
		},
	});
};
