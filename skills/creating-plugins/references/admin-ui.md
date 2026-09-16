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

The plugin CLI does not serialize `admin.settingsSchema` for a sandboxed package. Build settings with Block Kit and store validated values in `ctx.kv`.

## Sandboxed declarative field widgets

Core and the admin contain a declarative field-widget path. A field widget definition has this shape:

```typescript
interface FieldWidgetConfig {
	name: string;
	label: string;
	fieldTypes: FieldType[];
	elements?: Element[];
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

This feature does not currently travel through the plugin CLI package boundary. `emdash-plugin.jsonc` rejects `admin.fieldWidgets`, the probe reads no admin definitions from `src/plugin.ts`, and manifest extraction omits them. The browser E2E fixture tests a native React color picker only. Use declarative widgets only in a config-declared standard plugin whose descriptor supplies `fieldWidgets`, then verify the real editor render and value persistence.

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
