import type { APIRoute } from "astro";

import { apiError } from "#api/error.js";
import { dispatchPluginEditorExtensionApiRequest } from "#plugins/http-route-dispatch.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	if (!emdash) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);

	const kind = params.kind;
	if (kind !== "panel" && kind !== "action") {
		return apiError("NOT_FOUND", "Plugin editor extension not found", 404);
	}

	return dispatchPluginEditorExtensionApiRequest({
		runtime: emdash,
		pluginId: params.pluginId!,
		kind,
		extensionId: params.extensionId!,
		collection: params.collection!,
		entryId: params.id!,
		request,
		user,
		tokenScopes: locals.tokenScopes,
	});
};
