/**
 * Registry publisher handle
 *
 * GET /_emdash/api/admin/plugins/registry/publisher-handle?did=
 *
 * Resolves a registry publisher's DID to a handle verified in both
 * directions, so the admin can show `@handle/slug` instead of the raw DID.
 * An indeterminate lookup (network failure, timeout) is a 502 so the admin
 * retries it later instead of caching it.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";

import { getRegistryConfigInput } from "../../../../../../registry/config.js";
import {
	isPublisherDid,
	resolvePublisherHandle,
} from "../../../../../../registry/publisher-handle.js";

export const prerender = false;

const MAX_DID_LENGTH = 256;

export const GET: APIRoute = async ({ url, locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "plugins:read");
	if (denied) return denied;

	if (!getRegistryConfigInput(emdash.config.registry, emdash.config.experimental?.registry)) {
		return apiError("REGISTRY_NOT_CONFIGURED", "Registry is not configured", 400);
	}

	const did = url.searchParams.get("did");
	if (!did || did.length > MAX_DID_LENGTH || !isPublisherDid(did)) {
		return apiError("INVALID_REQUEST", "Invalid did", 400);
	}

	try {
		const resolution = await resolvePublisherHandle(did);
		if (!resolution) {
			return apiError(
				"HANDLE_RESOLUTION_FAILED",
				"The publisher handle could not be resolved",
				502,
			);
		}
		return apiSuccess(resolution);
	} catch (error) {
		return handleError(error, "Failed to resolve publisher handle", "HANDLE_RESOLUTION_FAILED");
	}
};
