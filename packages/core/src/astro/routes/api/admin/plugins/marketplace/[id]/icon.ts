/**
 * Marketplace plugin icon proxy
 *
 * GET /_emdash/api/admin/plugins/marketplace/:id/icon - Proxy icon from marketplace
 *
 * Avoids CORS/auth issues when the marketplace Worker is behind Cloudflare Access
 * or on a different origin. The admin UI uses this instead of linking directly.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError } from "#api/error.js";
import { fetchWithinOrigin, MarketplaceError, proxiedImageResponse } from "#plugins/marketplace.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, url, locals }) => {
	const { emdash, user } = locals;
	const { id } = params;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "plugins:read");
	if (denied) return denied;

	const marketplaceUrl = emdash.config.marketplace;
	if (!marketplaceUrl || !id) {
		return apiError("NOT_CONFIGURED", "Marketplace not configured", 400);
	}

	const width = url.searchParams.get("w");
	const target = new URL(`/api/v1/plugins/${encodeURIComponent(id)}/icon`, marketplaceUrl);
	if (width) target.searchParams.set("w", width);

	try {
		const resp = await fetchWithinOrigin(target.href, "Icon fetch", "PROXY");
		const image = await proxiedImageResponse(resp);
		if (image) return image;

		if (resp.status === 404) {
			return apiError("NOT_FOUND", "Icon not found", 404);
		}
		return apiError("PROXY_ERROR", "Marketplace did not return an image", 502);
	} catch (error) {
		if (error instanceof MarketplaceError && error.code) {
			return apiError(error.code, "Icon redirect was not followed", 502);
		}
		return apiError("PROXY_ERROR", "Failed to fetch icon", 502);
	}
};
