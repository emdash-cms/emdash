/**
 * Theme marketplace thumbnail proxy
 *
 * GET /_emdash/api/admin/themes/marketplace/:id/thumbnail - Proxy thumbnail from marketplace
 *
 * Avoids CORS/auth issues when the marketplace Worker is behind Cloudflare Access
 * or on a different origin. The admin UI uses this instead of linking directly.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError } from "#api/error.js";
import { fetchWithinOrigin, MarketplaceError } from "#plugins/marketplace.js";

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
	const target = new URL(`/api/v1/themes/${encodeURIComponent(id)}/thumbnail`, marketplaceUrl);
	if (width) target.searchParams.set("w", width);

	try {
		const resp = await fetchWithinOrigin(target.href, "Thumbnail fetch", "PROXY");
		if (!resp.ok) {
			// Allowlist: only forward Content-Type from upstream.
			// Never copy all upstream headers (denylist approach leaks
			// headers we haven't anticipated).
			return new Response(resp.body, {
				status: resp.status,
				headers: {
					"Content-Type": resp.headers.get("Content-Type") ?? "application/octet-stream",
					"Cache-Control": "private, no-store",
				},
			});
		}

		return new Response(resp.body, {
			headers: {
				"Content-Type": resp.headers.get("Content-Type") ?? "image/png",
				"Cache-Control": "private, no-store",
			},
		});
	} catch (error) {
		if (error instanceof MarketplaceError && error.code) {
			return apiError(error.code, "Thumbnail redirect was not followed", 502);
		}
		return apiError("PROXY_ERROR", "Failed to fetch thumbnail", 502);
	}
};
