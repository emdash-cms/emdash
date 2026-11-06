export const prerender = false;

import { loadVisualEditingToolbarLabels } from "@emdash-cms/admin/locales/server";
import type { APIRoute } from "astro";

import { apiSuccess } from "#api/error.js";

export const GET: APIRoute = async ({ request }) => {
	const labels = await loadVisualEditingToolbarLabels(request);
	const response = apiSuccess({
		editMode: labels.editMode,
		hideToolbar: labels.hideToolbar,
	});
	response.headers.set("Cache-Control", "private, no-store");
	return response;
};
