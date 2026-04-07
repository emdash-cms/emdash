# Block Kit

Declarative JSON UI for sandboxed plugin admin pages. The host renders blocks — no plugin JavaScript runs in the browser. Inspired by Slack's Block Kit but not identical — similar concepts and naming, different block/element types and capabilities.

Trusted plugins (declared in `astro.config.ts`) can ship custom React components instead. Block Kit is for runtime-installed sandboxed plugins.

Block Kit elements are also used for [Portable Text block editing fields](./portable-text-blocks.md). When a plugin declares `fields` on a block type, the editor renders a Block Kit form.

## How It Works

1. User navigates to plugin admin page
2. Admin sends `page_load` interaction to plugin's admin route
3. Plugin returns `BlockResponse` with array of blocks
4. Admin renders blocks using `BlockRenderer`
5. User interacts (button click, form submit) → interaction sent back
6. Plugin returns new blocks

```typescript
routes: {
	admin: {
		handler: async (ctx) => {
			const interaction = await ctx.request.json();

			if (interaction.type === "page_load") {
				return {
					blocks: [
						{ type: "header", text: "My Plugin Settings" },
						{
							type: "form",
							block_id: "settings",
							fields: [
								{ type: "text_input", action_id: "api_url", label: "API URL" },
								{ type: "toggle", action_id: "enabled", label: "Enabled", initial_value: true },
							],
							submit: { label: "Save", action_id: "save" },
						},
					],
				};
			}

			if (interaction.type === "form_submit" && interaction.action_id === "save") {
				await ctx.kv.set("settings", interaction.values);
				return {
					blocks: [/* updated blocks */],
					toast: { message: "Settings saved", type: "success" },
				};
			}
		},
	},
}
```

## Block Types

| Type      | Description                                         |
| --------- | --------------------------------------------------- |
| `header`  | Large bold heading                                  |
| `section` | Text with optional accessory element                |
| `divider` | Horizontal rule                                     |
| `fields`  | Two-column label/value grid                         |
| `table`   | Data table with formatting, sorting, pagination     |
| `actions` | Horizontal row of buttons and controls              |
| `stats`   | Dashboard metric cards with trend indicators        |
| `form`    | Input fields with conditional visibility and submit |
| `image`   | Block-level image with caption                      |
| `context` | Small muted help text                               |
| `columns` | 2-3 column layout with nested blocks                |
| `chart`   | Charts (timeseries line/bar, pie, custom ECharts)   |
| `code`    | Syntax-highlighted code block                       |
| `meter`   | Progress/quota meter bar                            |
| `banner`  | Info, warning, or error inline messages             |

## Element Types

| Type           | Description                                     |
| -------------- | ----------------------------------------------- |
| `button`       | Action button with optional confirmation dialog |
| `text_input`   | Single-line or multiline text input             |
| `number_input` | Numeric input with min/max                      |
| `select`       | Dropdown select                                 |
| `toggle`       | On/off switch                                   |
| `secret_input` | Masked input for API keys and tokens            |
| `checkbox`     | Multi-select checkboxes                         |
| `radio`        | Single-select radio buttons                     |
| `date_input`   | Date picker                                     |
| `combobox`     | Searchable dropdown select                      |

## Block Syntax

### Header

```json
{ "type": "header", "text": "Settings" }
```

### Section

```json
{
	"type": "section",
	"text": "Configure your plugin settings below.",
	"accessory": { "type": "button", "text": "Refresh", "action_id": "refresh" }
}
```

### Divider

```json
{ "type": "divider" }
```

### Fields

```json
{
	"type": "fields",
	"fields": [
		{ "label": "Status", "value": "Active" },
		{ "label": "Last Sync", "value": "2 hours ago" }
	]
}
```

### Stats

```json
{
	"type": "stats",
	"stats": [
		{ "label": "Total", "value": "1,234", "trend": "+12%", "trend_direction": "up" },
		{ "label": "Active", "value": "567" }
	]
}
```

### Table

```json
{
	"type": "table",
	"columns": [
		{ "key": "name", "label": "Name" },
		{ "key": "status", "label": "Status" },
		{ "key": "date", "label": "Date" }
	],
	"rows": [{ "name": "Item 1", "status": "Active", "date": "2025-01-01" }]
}
```

### Actions

```json
{
	"type": "actions",
	"elements": [
		{ "type": "button", "text": "Save", "action_id": "save", "style": "primary" },
		{ "type": "button", "text": "Cancel", "action_id": "cancel" }
	]
}
```

### Form

```json
{
	"type": "form",
	"block_id": "settings",
	"fields": [
		{ "type": "text_input", "action_id": "name", "label": "Name" },
		{ "type": "number_input", "action_id": "count", "label": "Count", "min": 0, "max": 100 },
		{
			"type": "select",
			"action_id": "theme",
			"label": "Theme",
			"options": [
				{ "label": "Light", "value": "light" },
				{ "label": "Dark", "value": "dark" }
			]
		},
		{ "type": "toggle", "action_id": "enabled", "label": "Enabled", "initial_value": true },
		{ "type": "secret_input", "action_id": "api_key", "label": "API Key" }
	],
	"submit": { "label": "Save", "action_id": "save_settings" }
}
```

### Columns

```json
{
	"type": "columns",
	"columns": [
		{ "blocks": [{ "type": "header", "text": "Left" }] },
		{ "blocks": [{ "type": "header", "text": "Right" }] }
	]
}
```

### Chart (Timeseries)

```json
{
	"type": "chart",
	"config": {
		"chart_type": "timeseries",
		"series": [
			{
				"name": "Requests",
				"data": [
					[1709596800000, 42],
					[1709600400000, 67],
					[1709604000000, 53]
				],
				"color": "#086FFF"
			},
			{
				"name": "Errors",
				"data": [
					[1709596800000, 2],
					[1709600400000, 5],
					[1709604000000, 1]
				]
			}
		],
		"x_axis_name": "Time",
		"y_axis_name": "Count",
		"style": "line",
		"gradient": true,
		"height": 300
	}
}
```

- `series[].data` — array of `[timestamp_ms, value]` tuples
- `series[].color` — hex color (optional, auto-assigned from Kumo palette)
- `style` — `"line"` (default) or `"bar"`
- `gradient` — fill gradient beneath lines (default false)
- `height` — chart height in pixels (default 350)

### Chart (Custom)

For pie charts, gauges, or any ECharts visualization:

```json
{
	"type": "chart",
	"config": {
		"chart_type": "custom",
		"options": {
			"series": [
				{
					"type": "pie",
					"data": [
						{ "value": 335, "name": "Published" },
						{ "value": 234, "name": "Draft" },
						{ "value": 120, "name": "Scheduled" }
					]
				}
			]
		},
		"height": 300
	}
}
```

- `options` — raw ECharts option object passed through to `chart.setOption()`

### Code

```json
{
	"type": "code",
	"code": "const greeting = \"Hello!\";\nconsole.log(greeting);",
	"language": "ts"
}
```

- `language` — `"ts"`, `"tsx"`, `"jsonc"`, `"bash"`, or `"css"` (defaults to `"ts"`)

### Meter

```json
{
	"type": "meter",
	"label": "Storage used",
	"value": 65,
	"custom_value": "6.5 GB / 10 GB"
}
```

- `value` — numeric value (default range 0-100)
- `max` / `min` — custom range (defaults to 0-100)
- `custom_value` — display string instead of percentage (e.g. "750 / 1,000")

### Banner

```json
{
	"type": "banner",
	"title": "API key invalid",
	"description": "Please check your API key in settings.",
	"variant": "error"
}
```

- `variant` — `"default"` (info, default), `"alert"` (warning), or `"error"`
- At least one of `title` or `description` is required

## Conditional Fields

Show/hide fields based on other field values. Evaluated client-side, no round-trip.

```json
{
	"type": "toggle",
	"action_id": "auth_enabled",
	"label": "Enable Authentication"
}
```

```json
{
	"type": "secret_input",
	"action_id": "api_key",
	"label": "API Key",
	"condition": { "field": "auth_enabled", "eq": true }
}
```

## Builder Helpers

`@emdash-cms/blocks` provides TypeScript helpers:

```typescript
import { blocks, elements } from "@emdash-cms/blocks";

const { header, form, section, stats, timeseriesChart, customChart, banner: bannerBlock } = blocks;
const { textInput, toggle, select, button } = elements;

return {
	blocks: [
		header("Settings"),
		form({
			blockId: "settings",
			fields: [
				textInput("site_title", "Site Title", { initialValue: "My Site" }),
				toggle("generate_sitemap", "Generate Sitemap", { initialValue: true }),
				select("robots", "Default Robots", [
					{ label: "Index, Follow", value: "index,follow" },
					{ label: "No Index", value: "noindex,follow" },
				]),
			],
			submit: { label: "Save", actionId: "save" },
		}),
		// Timeseries chart
		timeseriesChart({
			series: [
				{
					name: "Page Views",
					data: [
						[Date.now() - 3600000, 100],
						[Date.now(), 150],
					],
				},
			],
			yAxisName: "Views",
			gradient: true,
		}),
		// Pie chart via custom ECharts options
		customChart({
			options: {
				series: [
					{
						type: "pie",
						data: [
							{ value: 335, name: "Published" },
							{ value: 234, name: "Draft" },
						],
					},
				],
			},
		}),
	],
};
```

## Button Confirmations

```json
{
	"type": "button",
	"text": "Delete All",
	"action_id": "delete_all",
	"style": "danger",
	"confirm": {
		"title": "Are you sure?",
		"text": "This cannot be undone.",
		"confirm": "Delete",
		"deny": "Cancel"
	}
}
```

## Toast Responses

Return a `toast` alongside blocks to show a notification:

```typescript
return {
	blocks: [
		/* ... */
	],
	toast: { message: "Settings saved", type: "success" }, // "success" | "error" | "info"
};
```
