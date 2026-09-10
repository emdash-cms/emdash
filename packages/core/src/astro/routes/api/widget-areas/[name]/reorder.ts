/**
 * Reorder widgets endpoint
 *
 * POST /_emdash/api/widget-areas/:name/reorder
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { reorderWidgetsBody } from "#api/schemas.js";
import { widgetAreaTag } from "#cache/chrome-tags.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals, cache }) => {
	const { emdash, user } = locals;
	const db = emdash.db;
	const { name } = params;

	const denied = requirePerm(user, "widgets:manage");
	if (denied) return denied;

	if (!name) {
		return apiError("VALIDATION_ERROR", "name is required", 400);
	}

	try {
		// Get the area
		const area = await db
			.selectFrom("_emdash_widget_areas")
			.select("id")
			.where("name", "=", name)
			.executeTakeFirst();

		if (!area) {
			return apiError("NOT_FOUND", `Widget area "${name}" not found`, 404);
		}

		const body = await parseBody(request, reorderWidgetsBody);
		if (isParseError(body)) return body;

		// Verify all widget IDs belong to this area
		const existingWidgets = await db
			.selectFrom("_emdash_widgets")
			.select("id")
			.where("area_id", "=", area.id)
			.execute();

		const existingIds = new Set(existingWidgets.map((w) => w.id));
		for (const id of body.widgetIds) {
			if (!existingIds.has(id)) {
				return apiError("VALIDATION_ERROR", `Widget "${id}" not found in area "${name}"`, 400);
			}
		}

		// Update sort_order for each widget
		await Promise.all(
			body.widgetIds.map((id, index) =>
				db.updateTable("_emdash_widgets").set({ sort_order: index }).where("id", "=", id).execute(),
			),
		);

		if (cache?.enabled) await cache.invalidate({ tags: [widgetAreaTag(name)] });
		return apiSuccess({ success: true });
	} catch (error) {
		return handleError(error, "Failed to reorder widgets", "WIDGET_REORDER_ERROR");
	}
};
