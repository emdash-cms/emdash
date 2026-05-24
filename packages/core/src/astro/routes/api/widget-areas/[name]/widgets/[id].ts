/**
 * Single widget endpoints
 *
 * PUT    /_emdash/api/widget-areas/:name/widgets/:id - Update widget
 * DELETE /_emdash/api/widget-areas/:name/widgets/:id - Delete widget
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { updateWidgetBody } from "#api/schemas.js";
import { rowToWidget } from "#widgets/index.js";
import type { WidgetRow } from "#widgets/types.js";

export const prerender = false;

export const PUT: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const db = emdash.db;
	const { name, id } = params;

	const denied = requirePerm(user, "widgets:manage");
	if (denied) return denied;

	if (!name || !id) {
		return apiError("VALIDATION_ERROR", "name and id are required", 400);
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

		// Check widget exists and belongs to this area
		const existingWidget = await db
			.selectFrom("_emdash_widgets")
			.select("id")
			.where("id", "=", id)
			.where("area_id", "=", area.id)
			.executeTakeFirst();

		if (!existingWidget) {
			return apiError("NOT_FOUND", `Widget "${id}" not found in area "${name}"`, 404);
		}

		const body = await parseBody(request, updateWidgetBody);
		if (isParseError(body)) return body;

		// Build update object (only update provided fields)
		const updates: Record<string, unknown> = {};
		if (body.title !== undefined) updates.title = body.title || null;
		if (body.type !== undefined) updates.type = body.type;
		if (body.content !== undefined)
			updates.content = body.content ? JSON.stringify(body.content) : null;
		if (body.menuName !== undefined) updates.menu_name = body.menuName || null;
		if (body.componentId !== undefined) updates.component_id = body.componentId || null;
		if (body.componentProps !== undefined)
			updates.component_props = body.componentProps ? JSON.stringify(body.componentProps) : null;

		if (Object.keys(updates).length === 0) {
			return apiError("VALIDATION_ERROR", "No fields to update", 400);
		}

		await db.updateTable("_emdash_widgets").set(updates).where("id", "=", id).execute();

		const widget = await db
			.selectFrom("_emdash_widgets")
			.selectAll()
			.$castTo<WidgetRow>()
			.where("id", "=", id)
			.executeTakeFirstOrThrow();

		return apiSuccess(rowToWidget(widget));
	} catch (error) {
		return handleError(error, "Failed to update widget", "WIDGET_UPDATE_ERROR");
	}
};

export const DELETE: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const db = emdash.db;
	const { name, id } = params;

	const denied = requirePerm(user, "widgets:manage");
	if (denied) return denied;

	if (!name || !id) {
		return apiError("VALIDATION_ERROR", "name and id are required", 400);
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

		// Check widget exists and belongs to this area
		const existingWidget = await db
			.selectFrom("_emdash_widgets")
			.select("id")
			.where("id", "=", id)
			.where("area_id", "=", area.id)
			.executeTakeFirst();

		if (!existingWidget) {
			return apiError("NOT_FOUND", `Widget "${id}" not found in area "${name}"`, 404);
		}

		await db.deleteFrom("_emdash_widgets").where("id", "=", id).execute();

		return apiSuccess({ deleted: true });
	} catch (error) {
		return handleError(error, "Failed to delete widget", "WIDGET_DELETE_ERROR");
	}
};
