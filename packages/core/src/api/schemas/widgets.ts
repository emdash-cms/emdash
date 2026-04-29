import { z } from "zod";

// ---------------------------------------------------------------------------
// Widgets: Input schemas
// ---------------------------------------------------------------------------

const widgetType = z.enum(["content", "menu", "component"]);

export const createWidgetAreaBody = z
	.object({
		name: z.string().min(1),
		label: z.string().min(1),
		description: z.string().optional(),
	})
	.meta({ id: "CreateWidgetAreaBody" });

export const createWidgetBody = z
	.object({
		type: widgetType,
		title: z.string().optional(),
		content: z.array(z.record(z.string(), z.unknown())).optional(),
		menuName: z.string().optional(),
		componentId: z.string().optional(),
		componentProps: z.record(z.string(), z.unknown()).optional(),
	})
	.meta({ id: "CreateWidgetBody" });

export const updateWidgetBody = z
	.object({
		type: widgetType.optional(),
		title: z.string().optional(),
		content: z.array(z.record(z.string(), z.unknown())).optional(),
		menuName: z.string().optional(),
		componentId: z.string().optional(),
		componentProps: z.record(z.string(), z.unknown()).optional(),
	})
	.meta({ id: "UpdateWidgetBody" });

export const reorderWidgetsBody = z
	.object({
		widgetIds: z.array(z.string().min(1)),
	})
	.meta({ id: "ReorderWidgetsBody" });

// ---------------------------------------------------------------------------
// Widgets: Response schemas
// ---------------------------------------------------------------------------

export const widgetAreaSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		label: z.string(),
		description: z.string().nullable(),
		created_at: z.string(),
		updated_at: z.string(),
	})
	.meta({ id: "WidgetArea" });

export const widgetSchema = z
	.object({
		id: z.string(),
		type: widgetType,
		title: z.string().optional(),
		content: z.array(z.record(z.string(), z.unknown())).optional(),
		menuName: z.string().optional(),
		componentId: z.string().optional(),
		componentProps: z.record(z.string(), z.unknown()).optional(),
	})
	.meta({ id: "Widget" });

export const widgetAreaWithWidgetsSchema = widgetAreaSchema
	.extend({
		widgets: z.array(widgetSchema),
	})
	.meta({ id: "WidgetAreaWithWidgets" });

export const widgetAreaWithWidgetsAndCountSchema = widgetAreaWithWidgetsSchema
	.extend({
		widgetCount: z.number().int(),
	})
	.meta({ id: "WidgetAreaWithWidgetsAndCount" });
