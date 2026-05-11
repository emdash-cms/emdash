/**
 * Content-taxonomy association endpoint
 *
 * GET /_emdash/api/content/:collection/:id/terms/:taxonomy - Get terms for an entry
 * POST /_emdash/api/content/:collection/:id/terms/:taxonomy - Set terms for an entry
 */

import type { APIRoute } from "astro";

import { requirePerm, requireOwnerPerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError, requireDb } from "#api/error.js";
import { parseBody, isParseError } from "#api/parse.js";
import { contentTermsBody } from "#api/schemas.js";
import { TaxonomyRepository } from "#db/repositories/taxonomy.js";
import { invalidateTermCache } from "#taxonomies/index.js";

export const prerender = false;

/**
 * Get terms assigned to an entry
 */
export const GET: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const { collection, id, taxonomy } = params;

	const denied = requirePerm(user, "content:read");
	if (denied) return denied;

	if (!collection || !id || !taxonomy) {
		return apiError("VALIDATION_ERROR", "Collection, id, and taxonomy required", 400);
	}

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	try {
		const repo = new TaxonomyRepository(emdash!.db);
		const terms = await repo.getTermsForEntry(collection, id, taxonomy);

		return apiSuccess({
			terms: terms.map((t) => ({
				id: t.id,
				name: t.name,
				slug: t.slug,
				label: t.label,
				parentId: t.parentId,
			})),
		});
	} catch (error) {
		return handleError(error, "Failed to get entry terms", "TERMS_GET_ERROR");
	}
};

/**
 * Set terms for an entry (replaces existing)
 */
export const POST: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const { collection, id, taxonomy } = params;

	if (!collection || !id || !taxonomy) {
		return apiError("VALIDATION_ERROR", "Collection, id, and taxonomy required", 400);
	}

	const denied = requirePerm(user, "content:edit_own");
	if (denied) return denied;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	if (!emdash!.handleContentGet) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	// Verify the content exists before modifying its terms
	const existing = await emdash!.handleContentGet(collection, id);
	if (!existing.success) {
		return apiError(
			existing.error?.code ?? "NOT_FOUND",
			existing.error?.message ?? "Content not found",
			existing.error?.code === "NOT_FOUND" ? 404 : 500,
		);
	}

	// Check ownership for edit permission
	const existingData =
		existing.data && typeof existing.data === "object"
			? // eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- handler returns unknown data; narrowed by typeof check above
				(existing.data as Record<string, unknown>)
			: undefined;
	// Handler returns { item, _rev } — extract the item for ownership check
	const existingItem =
		existingData?.item && typeof existingData.item === "object"
			? // eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- narrowed by typeof check above
				(existingData.item as Record<string, unknown>)
			: existingData;
	const authorId = typeof existingItem?.authorId === "string" ? existingItem.authorId : "";
	const editDenied = requireOwnerPerm(user, authorId, "content:edit_own", "content:edit_any");
	if (editDenied) return editDenied;

	// Resolve the canonical content ID from the handler result.
	// The URL `id` param may be a slug; we must use the real ID for term storage.
	const canonicalId = typeof existingItem?.id === "string" ? existingItem.id : id;

	try {
		const body = await parseBody(request, contentTermsBody);
		if (isParseError(body)) return body;
		const { termIds } = body;

		const repo = new TaxonomyRepository(emdash!.db);

		// Verify all term IDs exist and belong to the correct taxonomy
		for (const termId of termIds) {
			const term = await repo.findById(termId);
			if (!term) {
				return apiError("NOT_FOUND", `Term ID '${termId}' not found`, 404);
			}
			if (term.name !== taxonomy) {
				return apiError(
					"VALIDATION_ERROR",
					`Term ID '${termId}' does not belong to taxonomy '${taxonomy}'`,
					400,
				);
			}
		}

		// Set the terms (replaces existing) using the canonical ID
		await repo.setTermsForEntry(collection, canonicalId, taxonomy, termIds);

		// Term assignments changed — invalidate the hasAnyTermAssignments cache
		// so hydration on subsequent reads issues a fresh query.
		invalidateTermCache();

		// Get the updated terms using the canonical ID
		const terms = await repo.getTermsForEntry(collection, canonicalId, taxonomy);

		return apiSuccess({
			terms: terms.map((t) => ({
				id: t.id,
				name: t.name,
				slug: t.slug,
				label: t.label,
				parentId: t.parentId,
			})),
		});
	} catch (error) {
		return handleError(error, "Failed to set entry terms", "TERMS_SET_ERROR");
	}
};
