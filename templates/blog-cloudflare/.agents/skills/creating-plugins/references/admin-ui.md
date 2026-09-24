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

The plugin CLI preserves `admin.settingsSchema` in the registry manifest and generated descriptor, so the host can generate a settings form. Both sandbox bridges route `ctx.settings` through the same options records as that form. Read a generated setting with `ctx.settings.get("<key>")`; writes, deletes, list operations, and revision-based operations use the same namespace on Cloudflare and Node/workerd.

The `secret` settings field is write-only in the admin response and encrypted before persistence. The site must provide `EMDASH_ENCRYPTION_KEY`; missing, wrong, or tampered key material fails closed. Keep the encryption-key list with database backups. Existing `ctx.kv.get("settings:<key>")` reads remain compatible through EmDash 0.x.

## Sandboxed saved-entry extensions

Declare saved-entry panels and actions in `emdash-plugin.jsonc`:

```jsonc title="emdash-plugin.jsonc"
{
	"admin": {
		"editorPanels": [
			{
				"id": "health",
				"title": "Content health",
				"route": "editor/health",
				"collections": ["posts"],
				"draft": {
					"read": { "translatable": true },
					"patch": { "fields": ["title", "excerpt"] },
				},
			},
		],
		"editorActions": [
			{
				"id": "repair",
				"label": "Repair metadata",
				"route": "editor/repair",
				"placement": "overflow",
				"style": "danger",
				"confirm": {
					"title": "Repair?",
					"text": "This changes the saved entry.",
					"confirm": "Repair",
					"deny": "Cancel",
				},
			},
		],
	},
}
```

Every referenced route must be private. EmDash reloads the saved entry and checks ownership plus the route permission before invoking it. `routeCtx.ui.entry` contains only the canonical collection, ID, locale, and version.

Panels start collapsed. `panel_load` never includes draft values. After an explicit `block_action`, `form_submit`, or `editor_action`, `admin.editor-draft:read` can attach only the fields selected by the extension's `draft.read` declaration. `fields` selects explicit slugs and `translatable: true` selects current schema fields marked translatable. Draft declarations require explicit collection scope.

`admin.editor-draft:patch` permits a separate `draft.patch` field selector and does not imply read. Return `patch: { type: "editor-draft-patch", operations }` with whole-field `set` or `clear` operations. The host rejects the complete patch on an unknown, forbidden, invalid, unsupported, oversized, or stale operation. Accepted patches receive a host-rendered preview, update the form atomically, mark it dirty, and remain unsaved. A response may contain a toast and one terminal effect: patch, refresh, or navigation.

Use `createPluginRuntimeTestHost().admin` to exercise this boundary. `captureEditorDraft()` creates a saved-entry draft request, the existing panel/action helpers invoke the production route, and `applyEditorDraftPatch()` applies only a current response through the host validator.

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

The sandbox admin route receives `routeCtx.ui` with the host-attested admin locale, text direction, and surface. Use it to select localized text in a runtime Block Kit response. Labels in manifest metadata remain static strings; registry plugins do not hand translation catalogs to the host.

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
