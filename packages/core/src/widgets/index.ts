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
 * Get a widget area by name, with all its widgets
 */
export async function getWidgetArea(name: string): Promise<WidgetArea | null> {
	const db = await getDb();
	// Get the area
	const areaRow = await db
		.selectFrom("_emdash_widget_areas")
		.selectAll()
		.where("name", "=", name)
		.executeTakeFirst();

	if (!areaRow) {
		return null;
	}

	// Get widgets for this area, ordered by sort_order
	const widgetRows = await db
		.selectFrom("_emdash_widgets")
		.selectAll()
		.$castTo<WidgetRow>()
		.where("area_id", "=", areaRow.id)
		.orderBy("sort_order", "asc")
		.execute();

	// Map to API types
	const widgets: Widget[] = widgetRows.map((row) => rowToWidget(row));

	return {
		id: areaRow.id,
		name: areaRow.name,
		label: areaRow.label,
		description: areaRow.description ?? undefined,
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
