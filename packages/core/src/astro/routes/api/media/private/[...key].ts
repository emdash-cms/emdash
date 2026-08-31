import { hasPermission, hasScope } from "@emdash-cms/auth";
import type { APIRoute } from "astro";

import { apiError } from "#api/error.js";
import { serveStoredMedia } from "#media/serve-file.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
	const key = params.key;
	const { emdash, user, tokenScopes } = locals;

	if (
		!key ||
		key.includes("\\") ||
		key.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
		!hasPermission(user, "plugins:read") ||
		(tokenScopes !== undefined && !hasScope(tokenScopes, "media:read"))
	) {
		return apiError("NOT_FOUND", "File not found", 404);
	}
	if (!emdash?.storage) {
		return apiError("NOT_CONFIGURED", "Storage not configured", 500);
	}

	return serveStoredMedia(emdash.storage, `private/${key}`, "private, no-store");
};
