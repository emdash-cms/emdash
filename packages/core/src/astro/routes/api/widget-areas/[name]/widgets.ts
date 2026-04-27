/**
 * Widgets CRUD endpoints
 *
 * POST /_emdash/api/widget-areas/:name/widgets - Add widget
 */

import type { APIRoute } from "astro";
import { ulid } from "ulidx";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { createWidgetBody } from "#api/schemas.js";
import { rowToWidget } from "#widgets/index.js";
import type { WidgetRow } from "#widgets/types.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
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

		const body = await parseBody(request, createWidgetBody);
		if (isParseError(body)) return body;

		// Get max sort_order
		const maxOrder = await db
			.selectFrom("_emdash_widgets")
			.select(({ fn }) => fn.max("sort_order").as("maxOrder"))
			.where("area_id", "=", area.id)
			.executeTakeFirst();

		const sortOrder = (maxOrder?.maxOrder ?? -1) + 1;

		// Prepare values
		const id = ulid();
		await db
			.insertInto("_emdash_widgets")
			.values({
				id,
				area_id: area.id,
				sort_order: sortOrder,
				type: body.type,
				title: body.title ?? null,
				content: body.content ? JSON.stringify(body.content) : null,
				menu_name: body.menuName ?? null,
				component_id: body.componentId ?? null,
				component_props: body.componentProps ? JSON.stringify(body.componentProps) : null,
			})
			.execute();

		const widget = await db
			.selectFrom("_emdash_widgets")
			.selectAll()
			.$castTo<WidgetRow>()
			.where("id", "=", id)
			.executeTakeFirstOrThrow();

		return apiSuccess(rowToWidget(widget), 201);
	} catch (error) {
		return handleError(error, "Failed to create widget", "WIDGET_CREATE_ERROR");
	}
};
