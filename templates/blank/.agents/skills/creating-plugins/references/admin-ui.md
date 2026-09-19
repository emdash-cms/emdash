# Admin UI and field widgets

Sandboxed plugins return declarative Block Kit from a private route. Native plugins may instead ship React components. Keep these paths separate: sandboxed plugin JavaScript never runs in the browser.

## Sandboxed pages and dashboard widgets

Declare navigation and widget cards in `emdash-plugin.jsonc`:

```jsonc title="emdash-plugin.jsonc"
{
	"admin": {
		"pages": [
			{ "path": "/settings", "label": "Settings", "icon": "settings" },
			{ "path": "/reports", "label": "Reports", "icon": "chart" },
		],
		"widgets": [{ "id": "status", "title": "Plugin status", "size": "half" }],
	},
}
```

Pages mount at `/_emdash/admin/plugins/<plugin-id>/<path>`. Widget sizes are `full`, `half`, and `third`.

Any sandboxed plugin that declares a page or widget must define an `admin` route. The admin sends a `page_load`, `block_action`, or `form_submit` interaction as `routeCtx.input`:

```typescript title="src/plugin.ts"
import type { SandboxedPlugin } from "emdash/plugin";
import type { BlockResponse } from "@emdash-cms/blocks";
import { z } from "zod";

const interactionSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("page_load"), page: z.string() }),
	z.object({
		type: z.literal("block_action"),
		action_id: z.string(),
		block_id: z.string().optional(),
		value: z.unknown().optional(),
	}),
	z.object({
		type: z.literal("form_submit"),
		action_id: z.string(),
		block_id: z.string().optional(),
		values: z.object({ enabled: z.boolean() }),
	}),
]);

function settingsForm(enabled: boolean): BlockResponse {
	return {
		blocks: [
			{ type: "header", text: "Settings" },
			{
				type: "form",
				block_id: "settings",
				fields: [
					{ type: "toggle", action_id: "enabled", label: "Enabled", initial_value: enabled },
				],
				submit: { action_id: "save", label: "Save" },
			},
		],
	};
}

const plugin: SandboxedPlugin = {
	routes: {
		admin: {
			permission: "plugins:manage",
			handler: async (routeCtx, ctx) => {
				const parsed = interactionSchema.safeParse(routeCtx.input);
				if (!parsed.success) return { blocks: [] };
				const interaction = parsed.data;
				if (interaction.type === "form_submit" && interaction.action_id === "save") {
					await ctx.kv.set("settings:enabled", interaction.values.enabled === true);
					return {
						...settingsForm(interaction.values.enabled === true),
						toast: { type: "success", message: "Settings saved" },
					};
				}

				const enabled = (await ctx.kv.get<boolean>("settings:enabled")) ?? false;
				return settingsForm(enabled);
			},
		},
	},
};

export default plugin;
```

Validate interactions before production side effects; `routeCtx.input` is `unknown`. Read [Block Kit](./block-kit.md) for exact interaction, block, and element shapes.

The plugin CLI preserves `admin.settingsSchema` in the registry manifest and generated descriptor, so the host can generate a settings form. Both sandbox bridges route `settings:*` KV keys through the same options records as that form. Read a generated setting with `ctx.kv.get("settings:<key>")`; writes, deletes, list operations, and revision-based operations use the same namespace on Cloudflare and Node/workerd.

The `secret` settings field is write-only in the admin response, but EmDash does not currently provide encrypted plugin settings. Do not store a credential there when encryption at rest is required.

## Sandboxed declarative field widgets

Core and the admin contain a declarative field-widget path. Declare the widget in the registry manifest:

```jsonc title="emdash-plugin.jsonc"
{
	"admin": {
		"fieldWidgets": [
			{
				"name": "event-picker",
				"label": "Event",
				"fieldTypes": ["json"],
				"elements": [
					{ "type": "text_input", "action_id": "eventId", "label": "Event ID" },
					{ "type": "toggle", "action_id": "featured", "label": "Featured" },
				],
			},
		],
	},
}
```

A schema field selects it with `widget: "pluginId:widgetName"`. The editor stores an object keyed by each element's `action_id`. Use a `json` field for this object. The manifest schema accepts other compatible field types, but the repository has no end-to-end test proving that the composed object saves through them.

The current field-widget renderer supports:

- `text_input`
- `number_input`
- `toggle`
- `select`
- `media_picker`

Other Block Kit element types display an unsupported-element message in this surface.

`emdash-plugin.jsonc` accepts `admin.fieldWidgets`, and the plugin CLI carries the definitions through the bundle manifest and generated descriptor for registry installation. The artifact round-trip is covered by plugin CLI, shared manifest, and plugin-test tests. The browser E2E fixture still tests a native React color picker rather than a registry-installed declarative widget, so verify the real editor render and value persistence for the chosen elements.

The sandbox admin context does not expose the administrator's active locale. Labels in manifest metadata and Block Kit responses are static strings from the plugin; there is no locale-aware callback or translation catalog handoff for registry plugins.

## Native React pages, widgets, and fields

Native plugins may set `admin.entry` and export React components:

```typescript title="src/admin.tsx"
export const pages = {
	"/settings": SettingsPage,
};

export const widgets = {
	status: StatusWidget,
};

export const fields = {
	picker: ColorPickerField,
};
```

The plugin definition points to the entry and declares its surfaces:

```typescript
definePlugin({
	id: "color",
	version: "1.0.0",
	admin: {
		entry: "@my-org/plugin-color/admin",
		pages: [{ path: "/settings", label: "Settings" }],
		widgets: [{ id: "status", title: "Status", size: "half" }],
		fieldWidgets: [{ name: "picker", label: "Color picker", fieldTypes: ["string"] }],
	},
});
```

Native admin code must follow the repository's Kumo, localization, accessibility, and RTL rules. It runs with the site's authority and is not registry-installable.
