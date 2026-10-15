import type { Kysely } from "kysely";

import { widgetAreaTag } from "../cache/chrome-tags.js";
import type { Database } from "../database/types.js";
import { getDb } from "../loader.js";
import type { CacheHint } from "../query.js";
import { peekRequestCache, requestCached } from "../request-cache.js";
import { getWidgetComponents as getComponentRegistry } from "./components.js";
import type { Widget, WidgetArea, WidgetRow, WidgetComponentDef } from "./types.js";

export type {
	Widget,
	WidgetArea,
	WidgetType,
	WidgetComponentDef,
	PropDef,
	CreateWidgetAreaInput,
	CreateWidgetInput,
	UpdateWidgetInput,
	ReorderWidgetsInput,
} from "./types.js";

/**
 * Get a widget area by name, with all its widgets.
 */
export async function getWidgetArea(name: string): Promise<WidgetArea | null> {
	return requestCached(`widget-area:${name}`, async () => {
		const prefetched = peekRequestCache<WidgetArea[]>("widget-areas");
		if (prefetched) {
			try {
				const areas = await prefetched;
				return areas.find((area) => area.name === name) ?? null;
			} catch {
				// Optional prefetch failure must still allow the scoped read.
			}
		}

		const db = await getDb();
		const rows = await selectAreasWithWidgets(db)
			.where("a.name", "=", name)
			.orderBy("w.sort_order", "asc")
			.execute();
		return groupAreaRows(rows)[0] ?? null;
	});
}

/**
 * Areas left-joined with their widgets, so areas and widgets load in one
 * round trip. An area with no widgets yields one row with null widget columns.
 */
function selectAreasWithWidgets(db: Kysely<Database>) {
	return db
		.selectFrom("_emdash_widget_areas as a")
		.leftJoin("_emdash_widgets as w", "w.area_id", "a.id")
		.select([
			"a.id as a_id",
			"a.name as a_name",
			"a.label as a_label",
			"a.description as a_description",
			"w.id as w_id",
			"w.type as w_type",
			"w.title as w_title",
			"w.content as w_content",
			"w.menu_name as w_menu_name",
			"w.component_id as w_component_id",
			"w.component_props as w_component_props",
			"w.area_id as w_area_id",
			"w.sort_order as w_sort_order",
			"w.created_at as w_created_at",
		]);
}

type AreaWidgetRow = Awaited<
	ReturnType<ReturnType<typeof selectAreasWithWidgets>["execute"]>
>[number];

/** Group joined rows into areas, keeping row order for areas and widgets. */
function groupAreaRows(rows: AreaWidgetRow[]): WidgetArea[] {
	const areas = new Map<string, WidgetArea>();
	for (const row of rows) {
		let area = areas.get(row.a_id);
		if (!area) {
			area = {
				id: row.a_id,
				name: row.a_name,
				label: row.a_label,
				description: row.a_description ?? undefined,
				widgets: [],
			};
			areas.set(row.a_id, area);
		}
		if (row.w_id === null) continue;
		// Every w_* column is non-null whenever w_id is set.
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- left-join row is non-null when w_id is set; see above
		const widgetRow = {
			id: row.w_id,
			type: row.w_type,
			title: row.w_title,
			content: row.w_content,
			menu_name: row.w_menu_name,
			component_id: row.w_component_id,
			component_props: row.w_component_props,
			area_id: row.w_area_id,
			sort_order: row.w_sort_order,
			created_at: row.w_created_at,
		} as WidgetRow;
		area.widgets.push(rowToWidget(widgetRow));
	}
	return [...areas.values()];
}

/**
 * Get a widget area by name with a Workers edge-cache hint.
 *
 * Use the returned `cacheHint` with `Astro.cache.set()` so pages that render
 * this widget area can be purged automatically when its widgets change.
 */
export async function getWidgetAreaWithCacheHint(name: string): Promise<{
	data: WidgetArea | null;
	cacheHint: CacheHint;
}> {
	const data = await getWidgetArea(name);
	return { data, cacheHint: { tags: [widgetAreaTag(name)] } };
}

/**
 * Get all widget areas with their widgets
 */
export async function getWidgetAreas(): Promise<WidgetArea[]> {
	const db = await getDb();
	const rows = await selectAreasWithWidgets(db)
		.orderBy("a.created_at", "asc")
		.orderBy("a.id", "asc")
		.orderBy("w.sort_order", "asc")
		.execute();
	return groupAreaRows(rows);
}

/**
 * Get available widget components (for admin UI)
 */
export function getWidgetComponents(): WidgetComponentDef[] {
	return getComponentRegistry();
}

/**
 * Convert a widget row to the API type
 */
export function rowToWidget(row: WidgetRow): Widget {
	const widget: Widget = {
		id: row.id,
		type: row.type,
		title: row.title ?? undefined,
	};

	// Type-specific fields
	if (row.type === "content" && row.content) {
		try {
			widget.content = JSON.parse(row.content);
		} catch {
			// Invalid JSON, ignore
		}
	}

	if (row.type === "menu" && row.menu_name) {
		widget.menuName = row.menu_name;
	}

	if (row.type === "component" && row.component_id) {
		widget.componentId = row.component_id;
		if (row.component_props) {
			try {
				widget.componentProps = JSON.parse(row.component_props);
			} catch {
				// Invalid JSON, ignore
			}
		}
	}

	return widget;
}
