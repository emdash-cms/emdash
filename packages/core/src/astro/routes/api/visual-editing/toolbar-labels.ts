export const prerender = false;

import { loadVisualEditingToolbarLabels } from "@emdash-cms/admin/locales/server";
import type { APIRoute } from "astro";

export const GET: APIRoute = async ({ request }) => {
	const labels = await loadVisualEditingToolbarLabels(request);
	return Response.json(
		{
			data: {
				editMode: labels.editMode,
				hideToolbar: labels.hideToolbar,
			},
		},
		{ headers: { "Cache-Control": "private, no-store" } },
	);
};
