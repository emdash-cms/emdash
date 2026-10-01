/**
 * Site domain endpoint
 *
 * GET  /_emdash/api/settings/domain - The site URL set by the deployment
 *      configuration, if any, which takes precedence over the Site URL for
 *      links in emails and plugins, and `siteOrigin`, the origin sign-in
 *      handover links to (null until a Site URL or `siteUrl` is set).
 * POST /_emdash/api/settings/domain - Verify a new domain and store it as the
 *      Site URL.
 */

import type { APIRoute } from "astro";
import { z } from "zod";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError, unwrapResult } from "#api/error.js";
import { handleSiteDomainChange } from "#api/handlers/site-domain.js";
import { isParseError, parseBody } from "#api/parse.js";
import { getConfiguredOrigin } from "#api/public-url.js";
import { getChosenSiteOrigin } from "#api/site-url.js";
import { siteSettingsTag } from "#cache/chrome-tags.js";

export const prerender = false;

const siteDomainBody = z.object({ domain: z.string().min(1).max(253) });

export const GET: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "settings:read");
	if (denied) return denied;

	try {
		const siteOrigin = (await getChosenSiteOrigin(emdash.db, emdash.config)) ?? null;
		return apiSuccess({ configuredUrl: getConfiguredOrigin(emdash.config) ?? null, siteOrigin });
	} catch (error) {
		return handleError(error, "Failed to read the site domain", "SITE_DOMAIN_ERROR");
	}
};

export const POST: APIRoute = async ({ request, locals, cache }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "settings:manage");
	if (denied) return denied;

	try {
		const body = await parseBody(request, siteDomainBody);
		if (isParseError(body)) return body;

		const result = await handleSiteDomainChange(emdash.db, body.domain);
		if (result.success && cache?.enabled) await cache.invalidate({ tags: [siteSettingsTag()] });
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to change the site domain", "SITE_DOMAIN_ERROR");
	}
};
