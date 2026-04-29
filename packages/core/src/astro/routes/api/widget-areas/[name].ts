/**
 * Widget area by name endpoints
 *
 * GET    /_emdash/api/widget-areas/:name - Get area with widgets
 * DELETE /_emdash/api/widget-areas/:name - Delete area
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { rowToWidget } from "#widgets/index.js";
import type { WidgetRow } from "#widgets/types.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const db = emdash.db;
	const { name } = params;

	const denied = requirePerm(user, "widgets:read");
	if (denied) return denied;

	if (!name) {
		return apiError("VALIDATION_ERROR", "name is required", 400);
	}

	try {
		// Get the area
		const area = await db
			.selectFrom("_emdash_widget_areas")
			.selectAll()
			.where("name", "=", name)
			.executeTakeFirst();

		if (!area) {
			return apiError("NOT_FOUND", `Widget area "${name}" not found`, 404);
		}

		// Get widgets for this area
		const widgets = await db
			.selectFrom("_emdash_widgets")
			.selectAll()
			.$castTo<WidgetRow>()
			.where("area_id", "=", area.id)
			.orderBy("sort_order", "asc")
			.execute();

		return apiSuccess({
			...area,
			widgets: widgets.map((row) => rowToWidget(row)),
		});
	} catch (error) {
		return handleError(error, "Failed to fetch widget area", "WIDGET_AREA_GET_ERROR");
	}
};

export const DELETE: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const db = emdash.db;
	const { name } = params;

	const denied = requirePerm(user, "widgets:manage");
	if (denied) return denied;

	if (!name) {
		return apiError("VALIDATION_ERROR", "name is required", 400);
	}

	try {
		// Check if area exists
		const area = await db
			.selectFrom("_emdash_widget_areas")
			.select("id")
			.where("name", "=", name)
			.executeTakeFirst();

		if (!area) {
			return apiError("NOT_FOUND", `Widget area "${name}" not found`, 404);
		}

		// Delete area (widgets cascade)
		await db.deleteFrom("_emdash_widget_areas").where("id", "=", area.id).execute();

		return apiSuccess({ deleted: true });
	} catch (error) {
		return handleError(error, "Failed to delete widget area", "WIDGET_AREA_DELETE_ERROR");
	}
};
