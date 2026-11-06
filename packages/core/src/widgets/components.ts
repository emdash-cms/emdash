import type { WidgetComponentDef } from "./types.js";

/**
 * Core widget components registry
 * These are built-in widgets that ship with EmDash
 */
export const coreWidgetComponents: WidgetComponentDef[] = [
	{
		id: "core:recent-posts",
		label: "Recent Posts",
		description: "Display a list of recent posts",
		props: {
			count: {
				type: "number",
				label: "Number of posts",
				default: 5,
			},
			showThumbnails: {
				type: "boolean",
				label: "Show thumbnails",
				default: false,
			},
			showDate: {
				type: "boolean",
				label: "Show date",
				default: true,
			},
			urlTemplate: {
				type: "string",
				label: "URL template (e.g. /blog/:slug)",
			},
		},
	},
	{
		id: "core:categories",
		label: "Categories",
		description: "Display category list",
		props: {
			showCount: {
				type: "boolean",
				label: "Show post count",
				default: true,
			},
			hierarchical: {
				type: "boolean",
				label: "Show hierarchy",
				default: true,
			},
		},
	},
	{
		id: "core:tags",
		label: "Tags",
		description: "Display tag cloud",
		props: {
			showCount: {
				type: "boolean",
				label: "Show count",
				default: false,
			},
			limit: {
				type: "number",
				label: "Maximum tags",
				default: 20,
			},
		},
	},
	{
		id: "core:search",
		label: "Search",
		description: "Search form",
		props: {
			placeholder: {
				type: "string",
				label: "Placeholder text",
				default: "Search...",
			},
		},
	},
	{
		id: "core:archives",
		label: "Archives",
		description: "Monthly/yearly archives",
		props: {
			type: {
				type: "select",
				label: "Group by",
				default: "monthly",
				options: [
					{ value: "monthly", label: "Monthly" },
					{ value: "yearly", label: "Yearly" },
				],
			},
			limit: {
				type: "number",
				label: "Limit",
				default: 12,
			},
		},
	},
];

/**
 * Get all widget component definitions (core + plugin-registered)
 * For now, only returns core components. Plugin widgets will be added later.
 */
export function getWidgetComponents(): WidgetComponentDef[] {
	return [...coreWidgetComponents];
}
