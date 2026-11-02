/**
 * Domain proof endpoint
 *
 * POST /_emdash/api/site/domain-proof - Returns the token of a domain check in
 * progress, so the site can confirm that a new domain serves it. POST keeps
 * the read on the primary database, where the token was just written, rather
 * than a read replica.
 */

import type { APIRoute } from "astro";

import { apiError, handleError, unwrapResult } from "#api/error.js";
import { handleDomainProof } from "#api/handlers/site-domain.js";

export const prerender = false;

export const POST: APIRoute = async ({ locals }) => {
	const { emdash } = locals;
	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		return unwrapResult(await handleDomainProof(emdash.db));
	} catch (error) {
		return handleError(error, "Failed to read domain proof", "DOMAIN_PROOF_ERROR");
	}
};
