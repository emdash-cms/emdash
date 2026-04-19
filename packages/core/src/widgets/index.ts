import { getDb } from "../loader.js";
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
 *
 * Single query with a left join rather than area-then-widgets so the
 * common case costs one round-trip. An area with no widgets yields one
 * row with null widget columns, which we skip when mapping.
 */
export async function getWidgetArea(name: string): Promise<WidgetArea | null> {
	const db = await getDb();
	const rows = await db
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
		])
		.where("a.name", "=", name)
		.orderBy("w.sort_order", "asc")
		.execute();

	const first = rows[0];
	if (!first) return null;
	const widgets: Widget[] = [];
	for (const row of rows) {
		if (row.w_id === null) continue; // area has no widgets (left-join null row)
		// Left-join makes every w_* column nullable in the type; at runtime
		// they're all non-null once w_id is (we match on widgets.area_id, so
		// a widget row always has the not-null columns filled). Cast is the
		// price of that structural fact.
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- left-join row is non-null when w_id is set; see above
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
		widgets.push(rowToWidget(widgetRow));
	}

	return {
		id: first.a_id,
		name: first.a_name,
		label: first.a_label,
		description: first.a_description ?? undefined,
		widgets,
	};
}

/**
 * Get all widget areas with their widgets
 */
export async function getWidgetAreas(): Promise<WidgetArea[]> {
	const db = await getDb();
	// Get all areas
	const areaRows = await db.selectFrom("_emdash_widget_areas").selectAll().execute();

	// Get all widgets
	const widgetRows = await db
		.selectFrom("_emdash_widgets")
		.selectAll()
		.$castTo<WidgetRow>()
		.orderBy("sort_order", "asc")
		.execute();

	// Group widgets by area
	const widgetsByArea = new Map<string, Widget[]>();
	for (const row of widgetRows) {
		if (!widgetsByArea.has(row.area_id)) {
			widgetsByArea.set(row.area_id, []);
		}
		widgetsByArea.get(row.area_id)!.push(rowToWidget(row));
	}

	// Combine
	return areaRows.map((areaRow) => ({
		id: areaRow.id,
		name: areaRow.name,
		label: areaRow.label,
		description: areaRow.description ?? undefined,
		widgets: widgetsByArea.get(areaRow.id) || [],
	}));
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
function rowToWidget(row: WidgetRow): Widget {
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
