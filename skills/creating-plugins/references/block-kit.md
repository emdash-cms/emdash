# Block Kit

Declarative JSON UI for sandboxed plugin admin pages. The host renders blocks — no plugin JavaScript runs in the browser. Inspired by Slack's Block Kit but not identical — similar concepts and naming, different block/element types and capabilities.

Trusted plugins (declared in `astro.config.ts`) can ship custom React components instead. Block Kit is for runtime-installed sandboxed plugins.

Native plugins also use Block Kit elements for [Portable Text block editing fields](./portable-text-blocks.md). Plugin CLI and registry packages cannot register Portable Text block types.

## How It Works

1. User navigates to plugin admin page
2. Admin sends `page_load` interaction to plugin's admin route
3. Plugin returns `BlockResponse` with array of blocks
4. Admin renders blocks using `BlockRenderer`
5. User interacts (button click, form submit) → interaction sent back
6. Plugin returns new blocks

```typescript
import type { BlockInteraction } from "@emdash-cms/blocks";

routes: {
	admin: {
		handler: async (ctx) => {
			// EmDash parses the request body once and exposes it as ctx.input;
			// read it directly rather than ctx.request.json() (the body is consumed).
			// BlockInteraction is the discriminated union of page_load,
			// block_action, and form_submit payloads.
			const interaction = ctx.input as BlockInteraction;

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

| Type        | Description                                         |
| ----------- | --------------------------------------------------- |
| `header`    | Large bold heading                                  |
| `section`   | Text with optional accessory element                |
| `divider`   | Horizontal rule                                     |
| `fields`    | Two-column label/value grid                         |
| `table`     | Data table with formatting, sorting, pagination     |
| `actions`   | Horizontal row of buttons and controls              |
| `stats`     | Dashboard metric cards with trend indicators        |
| `form`      | Input fields with conditional visibility and submit |
| `image`     | Block-level image with alt text and optional title  |
| `context`   | Small muted help text                               |
| `columns`   | 2-3 column layout with nested blocks                |
| `chart`     | Charts (timeseries line/bar, pie, custom ECharts)   |
| `code`      | Syntax-highlighted code block                       |
| `meter`     | Progress/quota meter bar                            |
| `banner`    | Info, warning, or error inline messages             |
| `empty`     | Empty state with optional command and actions       |
| `accordion` | Collapsible section containing nested blocks        |

## Element Types

| Type           | Description                                               |
| -------------- | --------------------------------------------------------- |
| `button`       | Action button with optional confirmation dialog           |
| `link`         | Host-resolved navigation that does not dispatch an action |
| `text_input`   | Single-line or multiline text input                       |
| `number_input` | Numeric input with min/max                                |
| `select`       | Dropdown select                                           |
| `toggle`       | On/off switch                                             |
| `secret_input` | Masked input for API keys and tokens                      |
| `checkbox`     | Multi-select checkboxes                                   |
| `radio`        | Single-select radio buttons                               |
| `date_input`   | Date picker                                               |
| `combobox`     | Searchable dropdown select                                |
| `repeater`     | Array of records with scalar sub-fields                   |
| `media_picker` | Media-library picker that stores the asset URL            |

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
	"accessory": { "type": "button", "label": "Refresh", "action_id": "refresh" }
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
	"items": [
		{ "label": "Total", "value": "1,234", "trend": "up", "description": "+12% vs last week" },
		{ "label": "Active", "value": "567" }
	]
}
```

- `items` — the array key is `items`, not `stats`
- `trend` — `"up"`, `"down"`, or `"neutral"`; renders an arrow icon next to the value
- `description` — secondary line beneath the value, for context such as "+12% vs last week"

### Table

```json
{
	"type": "table",
	"columns": [
		{ "key": "name", "label": "Name" },
		{ "key": "status", "label": "Status" },
		{ "key": "date", "label": "Date" }
	],
	"rows": [{ "name": "Item 1", "status": "Active", "date": "2025-01-01" }],
	"page_action_id": "browse_items",
	"empty_text": "No items yet."
}
```

- `page_action_id` — required. The admin sends it as the `block_action` id when the user sorts a column or pages through results.
- `empty_text` — shown in place of the table when `rows` is empty
- `next_cursor` — set it to render a "Load more" control

### Actions

```json
{
	"type": "actions",
	"elements": [
		{ "type": "button", "label": "Save", "action_id": "save", "style": "primary" },
		{ "type": "button", "label": "Cancel", "action_id": "cancel" }
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
		[
			{ "type": "header", "text": "Usage" },
			{ "type": "meter", "label": "Storage used", "value": 65 }
		],
		[
			{ "type": "header", "text": "Activity" },
			{ "type": "context", "text": "Last sync 2 hours ago" }
		]
	]
}
```

- `columns` — 2 or 3 columns, each one an array of blocks

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

### Empty

```json
{
	"type": "empty",
	"title": "No submissions",
	"description": "New submissions appear here.",
	"command_line": "pnpm run seed",
	"size": "base",
	"actions": [{ "type": "button", "action_id": "refresh", "label": "Refresh" }]
}
```

### Tabs

Use `tab` to group related blocks into labelled panels:

```json
{
	"type": "tab",
	"panels": [
		{
			"label": "General",
			"blocks": [{ "type": "context", "text": "General settings" }]
		}
	]
}
```

### Accordion

```json
{
	"type": "accordion",
	"label": "Advanced settings",
	"default_open": false,
	"blocks": [{ "type": "context", "text": "Settings visible when expanded" }]
}
```

## Repeater and media picker elements

`repeater` and `media_picker` are admin-authoring elements, not ordinary fields in a sandboxed admin-page `form`.

`repeater` captures an array of objects. Its nested fields are limited to `text_input`, `number_input`, `select`, and `toggle`:

```typescript
{
	"type": "repeater",
	"action_id": "items",
	"label": "Questions",
	"item_label": "Question",
	"fields": [
		{ "type": "text_input", "action_id": "question", "label": "Question" },
		{ "type": "text_input", "action_id": "answer", "label": "Answer", "multiline": true }
	]
}
```

`media_picker` opens the media library and stores the selected asset's URL string:

```typescript
{
	"type": "media_picker",
	"action_id": "hero",
	"label": "Hero image",
	"mime_type_filter": "image/"
}
```

## Declarative field widgets

The admin field editor can render a plugin field widget from Block Kit elements. A schema field refers to `pluginId:widgetName`; a config-declared standard descriptor supplies `name`, `label`, compatible `fieldTypes`, and `elements`.

The field-widget renderer currently supports only these elements:

- `text_input`
- `number_input`
- `toggle`
- `select`
- `media_picker`

It stores an object keyed by each element's `action_id`. Use a `json` field for this composed value; other field types are accepted by the manifest schema but are not covered by an end-to-end save test. Other element types render an unsupported-element message.

`emdash-plugin.jsonc` accepts this field-widget definition, and the plugin CLI preserves it in the registry manifest and generated descriptor. The artifact transport is tested; the repository's browser E2E test still covers a native React field widget rather than a registry declarative widget. Verify the rendered editor and saved value for the selected elements.

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

const {
	header,
	form,
	section,
	stats,
	timeseriesChart,
	customChart,
	banner: bannerBlock,
	empty,
	accordion,
} = blocks;
const { textInput, toggle, select, button, repeater, mediaPicker } = elements;

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
	"label": "Delete All",
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

## Saved-entry panels and actions

`admin.editorPanels` and `admin.editorActions` point to private plugin routes. Panel routes return Block Kit and receive `panel_load`, `block_action`, or `form_submit`. Action routes receive `editor_action` and return only these bounded fields:

```typescript
{
	toast?: { message: string; type: "success" | "error" | "info" };
	refresh?: true;
	navigate?: LinkTarget;
	patch?: EditorDraftPatchEffect;
}
```

Use only one of `refresh`, `navigate`, or `patch`. Navigation uses the same structured target validator as `link` elements. A danger action declaration must include a confirmation dialog.

For both surfaces, `routeCtx.ui.entry` contains the host-reloaded collection, saved entry ID, content locale, and version. `routeCtx.ui.extensionId` identifies the manifest declaration. Ordinary panel load contains no draft. An explicit interaction includes selected unsaved fields only when the plugin has `admin.editor-draft:read` and the extension declares bounded `draft.read` access. `admin.editor-draft:patch` separately permits atomic whole-field `set` and `clear` proposals for fields in `draft.patch`; the host previews accepted changes without saving them.

## Links and admin locale

Use a structured link target instead of returning an admin URL:

```json
{
	"type": "link",
	"label": "Edit article",
	"target": { "kind": "content", "collection": "posts", "id": "post-1", "locale": "ar" },
	"appearance": "primary"
}
```

Targets can identify saved content, a page declared by the same plugin, the plugin's generated settings page, or an absolute external HTTP, HTTPS, or `mailto:` URL. External links open in a new tab with `noopener noreferrer`. A link has no `action_id`; use a button when the interaction must call the plugin.

Every page and widget response is validated before rendering. Responses are limited to 256 KiB, 20 nested levels, 2,000 nodes, 1,000 items per array, and 64 KiB per string. Root-relative image URLs are accepted. External images require HTTPS and either `network:request` with the hostname in the plugin manifest's `allowedHosts`, or `network:request:unrestricted`.

The admin route receives host-attested UI context separately from the interaction:

```typescript
const { locale, direction, surface } = routeCtx.ui ?? {
	locale: "en",
	direction: "ltr",
	surface: "admin-page",
};
```

The UI locale is the administrator's active locale. It is separate from the site's default content locale in `ctx.site.locale`. Runtime page labels can use it to select localized Block Kit text; manifest navigation labels remain static.

## Toast Responses

Return a `toast` alongside blocks to show a notification:

```typescript
return {
	blocks: [/* ... */],
	toast: { message: "Settings saved", type: "success" }, // "success" | "error" | "info"
};
```
