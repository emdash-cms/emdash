/**
 * GET /_emdash/api/dev/emails
 * DELETE /_emdash/api/dev/emails
 *
 * Development-only endpoint to view and clear emails captured by
 * the dev console email provider.
 *
 * ONLY available when isDevOnlyEnabled() is true.
 *
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { isDevOnlyEnabled } from "#api/dev-only.js";
import { apiError, apiSuccess } from "#api/error.js";

import { clearDevEmails, getDevEmails } from "../../../../plugins/email-console.js";

export const GET: APIRoute = async () => {
	if (!isDevOnlyEnabled()) {
		return apiError("FORBIDDEN", "Dev emails endpoint is only available in development mode", 403);
	}

	const emails = getDevEmails();
	return apiSuccess({ items: emails });
};

export const DELETE: APIRoute = async () => {
	if (!isDevOnlyEnabled()) {
		return apiError("FORBIDDEN", "Dev emails endpoint is only available in development mode", 403);
	}

	clearDevEmails();
	return apiSuccess({ success: true });
};
