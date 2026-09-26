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
import type { Kysely } from "kysely";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import type { SchemaRegistry } from "#schema/registry.js";

import type { Database } from "../../../database/types.js";

export const prerender = false;

/**
 * Safely list collections, returning empty array if tables don't exist yet
 */
async function safeListCollections(registry: SchemaRegistry) {
	try {
		return await registry.listCollections();
	} catch (error) {
		// Handle missing tables for new sites that haven't run setup yet
		if (error instanceof Error && error.message.includes("no such table")) {
			return [];
		}
		throw error;
	}
}

/**
 * Generate types content and metadata from the current schema.
 */
async function generateTypes(registry: SchemaRegistry, db: Kysely<Database>) {
	const { expandCollectionBlockFields } = await import("#schema/block-values.js");
	const { generateTypesFile, generateSchemaHash } = await import("#schema/zod-generator.js");

	const collections = await safeListCollections(registry);
	const collectionsWithFields = await Promise.all(
		collections.map(async (c) => {
			const fields = await registry.listFields(c.id);
			return expandCollectionBlockFields(db, { ...c, fields });
		}),
	);

	const types = generateTypesFile(collectionsWithFields);
	const hash: string = await generateSchemaHash(collectionsWithFields);

	return { types, hash, collections: collections.length };
}

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
		const { SchemaRegistry } = await import("#schema/registry.js");
		const registry = new SchemaRegistry(emdash.db);
		const { types } = await generateTypes(registry, emdash.db);

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
		const { SchemaRegistry } = await import("#schema/registry.js");
		const registry = new SchemaRegistry(emdash.db);
		const result = await generateTypes(registry, emdash.db);

		return apiSuccess(result);
	} catch (error) {
		return handleError(error, "Typegen failed", "TYPEGEN_ERROR");
	}
};
