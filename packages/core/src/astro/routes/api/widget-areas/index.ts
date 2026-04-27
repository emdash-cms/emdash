/**
 * Widget areas list and create endpoints
 *
 * GET  /_emdash/api/widget-areas - List all widget areas
 * POST /_emdash/api/widget-areas - Create widget area
 */

import type { APIRoute } from "astro";
import { ulid } from "ulidx";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { createWidgetAreaBody } from "#api/schemas.js";
import { rowToWidget } from "#widgets/index.js";
import type { WidgetRow } from "#widgets/types.js";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;
	const db = emdash.db;

	const denied = requirePerm(user, "widgets:read");
	if (denied) return denied;

	try {
		const areas = await db
			.selectFrom("_emdash_widget_areas")
			.selectAll()
			.orderBy("name", "asc")
			.execute();

		// Get widgets for each area (needed for drag-and-drop reordering in admin UI)
		const areasWithWidgets = await Promise.all(
			areas.map(async (area) => {
				const widgets = await db
					.selectFrom("_emdash_widgets")
					.selectAll()
					.$castTo<WidgetRow>()
					.where("area_id", "=", area.id)
					.orderBy("sort_order", "asc")
					.execute();

				return {
					...area,
					widgets: widgets.map((row) => rowToWidget(row)),
					widgetCount: widgets.length,
				};
			}),
		);

		return apiSuccess({ items: areasWithWidgets });
	} catch (error) {
		return handleError(error, "Failed to fetch widget areas", "WIDGET_AREA_LIST_ERROR");
	}
};

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;
	const db = emdash.db;

	const denied = requirePerm(user, "widgets:manage");
	if (denied) return denied;

	try {
		const body = await parseBody(request, createWidgetAreaBody);
		if (isParseError(body)) return body;

		// Check if area name already exists
		const existing = await db
			.selectFrom("_emdash_widget_areas")
			.select("id")
			.where("name", "=", body.name)
			.executeTakeFirst();

		if (existing) {
			return apiError("CONFLICT", `Widget area with name "${body.name}" already exists`, 409);
		}

		const id = ulid();
		await db
			.insertInto("_emdash_widget_areas")
			.values({
				id,
				name: body.name,
				label: body.label,
				description: body.description ?? null,
			})
			.execute();

		const area = await db
			.selectFrom("_emdash_widget_areas")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirstOrThrow();

		return apiSuccess(area, 201);
	} catch (error) {
		return handleError(error, "Failed to create widget area", "WIDGET_AREA_CREATE_ERROR");
	}
};
