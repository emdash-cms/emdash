# Admin UI

Plugins extend the admin panel with React pages and dashboard widgets.

## Entry Point

Export pages and widgets from `src/admin.tsx`:

```typescript
// src/admin.tsx
import { SettingsPage } from "./components/SettingsPage";
import { ReportsPage } from "./components/ReportsPage";
import { StatusWidget } from "./components/StatusWidget";

// Pages keyed by path (must match admin.pages paths)
export const pages = {
	"/settings": SettingsPage,
	"/reports": ReportsPage,
};

// Widgets keyed by ID (must match admin.widgets IDs)
export const widgets = {
	status: StatusWidget,
};
```

Reference in plugin definition:

```typescript
definePlugin({
	id: "my-plugin",
	version: "1.0.0",

	admin: {
		entry: "@my-org/my-plugin/admin",
		pages: [
			{ path: "/settings", label: "Settings", icon: "settings" },
			{ path: "/reports", label: "Reports", icon: "chart" },
		],
		widgets: [{ id: "status", title: "Status", size: "half" }],
	},
});
```

Pages mount at `/_emdash/admin/plugins/<plugin-id>/<path>`.

## Pages

React components. Use `usePluginAPI()` to call plugin routes.

```typescript
// src/components/SettingsPage.tsx
import { useState, useEffect } from "react";
import { usePluginAPI } from "@emdash-cms/admin";

export function SettingsPage() {
	const api = usePluginAPI();
	const [settings, setSettings] = useState<Record<string, unknown>>({});
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		api.get("settings").then(setSettings);
	}, []);

	const handleSave = async () => {
		setSaving(true);
		await api.post("settings/save", settings);
		setSaving(false);
	};

	return (
		<div>
			<h1>Settings</h1>
			<label>
				Site Title
				<input
					type="text"
					value={settings.siteTitle || ""}
					onChange={(e) => setSettings({ ...settings, siteTitle: e.target.value })}
				/>
			</label>
			<button onClick={handleSave} disabled={saving}>
				{saving ? "Saving..." : "Save"}
			</button>
		</div>
	);
}
```

## Widgets

Dashboard cards with at-a-glance info.

```typescript
// src/components/StatusWidget.tsx
import { useState, useEffect } from "react";
import { usePluginAPI } from "@emdash-cms/admin";

export function StatusWidget() {
	const api = usePluginAPI();
	const [data, setData] = useState({ count: 0 });

	useEffect(() => {
		api.get("status").then(setData);
	}, []);

	return (
		<div className="widget-content">
			<div className="score">{data.count}</div>
		</div>
	);
}
```

### Widget Sizes

| Size    | Width                |
| ------- | -------------------- |
| `full`  | Full dashboard width |
| `half`  | Half width           |
| `third` | One-third width      |

## usePluginAPI()

Auto-prefixes plugin ID to route URLs:

```typescript
const api = usePluginAPI();

const data = await api.get("status"); // GET /.../plugins/<id>/status
await api.post("settings/save", { enabled: true }); // POST with body
const result = await api.get("history?limit=50"); // Query params
```

## Admin Components

Pre-built components from `@emdash-cms/admin`:

```typescript
import { Card, Button, Input, Select, Toggle, Table, Loading, Alert } from "@emdash-cms/admin";
```

## Auto-Generated Settings

If your plugin only needs settings, skip custom pages — use `settingsSchema` and EmDash generates the form:

```typescript
admin: {
	settingsSchema: {
		apiKey: { type: "secret", label: "API Key" },
		enabled: { type: "boolean", label: "Enabled", default: true },
	}
}
```

## Build Configuration

Admin components need a separate build entry:

```typescript
// tsdown.config.ts
export default {
	entry: {
		index: "src/index.ts",
		admin: "src/admin.tsx",
	},
	format: "esm",
	dts: true,
	external: ["react", "react-dom", "emdash", "@emdash-cms/admin"],
};
```

Keep React and `@emdash-cms/admin` as externals to avoid bundling duplicates.

## Plugin Descriptor

The descriptor (returned by factory function) also declares admin metadata:

```typescript
export function myPlugin(options = {}): PluginDescriptor {
	return {
		id: "my-plugin",
		entrypoint: "@my-org/my-plugin",
		version: "1.0.0",
		options,
		adminEntry: "@my-org/my-plugin/admin",
		adminPages: [{ path: "/settings", label: "Settings", icon: "settings" }],
		adminWidgets: [{ id: "status", title: "Status", size: "half" }],
	};
}
```
