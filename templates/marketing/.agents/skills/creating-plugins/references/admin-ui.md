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
					await ctx.settings.set("enabled", interaction.values.enabled === true);
					return {
						...settingsForm(interaction.values.enabled === true),
						toast: { type: "success", message: "Settings saved" },
					};
				}

				const enabled = (await ctx.settings.get<boolean>("enabled")) ?? false;
				return settingsForm(enabled);
			},
		},
	},
};

export default plugin;
```

Validate interactions before production side effects; `routeCtx.input` is `unknown`. Read [Block Kit](./block-kit.md) for exact interaction, block, and element shapes.

The plugin CLI preserves `admin.settingsSchema` in the registry manifest and generated descriptor. Both sandbox bridges route `ctx.settings` through the same records as the generated form.

Secret fields are write-only in admin responses and encrypted before persistence. The site needs matching `EMDASH_ENCRYPTION_KEY` material to read them. Keep the key list with database backups. Legacy `ctx.kv.get("settings:<key>")` reads remain compatible through EmDash 0.x.

## Sandboxed saved-entry extensions

Declare `admin.editorPanels` and `admin.editorActions` in `emdash-plugin.jsonc`. Every declaration names a private route and may restrict itself to exact collection slugs.

The host reloads and ownership-authorizes the saved entry before invoking the route. `routeCtx.ui.entry` contains only collection, ID, locale, and version; `routeCtx.ui.extensionId` identifies the declaration. Field values and unsaved editor state never cross the boundary.

Panels load lazily and return Block Kit for `panel_load`, `block_action`, and `form_submit`. Actions are disabled while edits are unsaved and return only a bounded toast, `refresh: true`, or structured navigation. Danger actions require a manifest confirmation.

Use the runtime host's admin helpers to load and interact with panels and invoke editor actions through the production ownership and permission boundary.

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

Sandboxed admin routes receive host-attested locale, direction, and surface in `routeCtx.ui`. Use it to select localized runtime Block Kit text. Manifest labels remain static strings; registry plugins do not hand translation catalogs to the host.

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
