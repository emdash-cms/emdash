# Portable Text Block Types

**Trusted plugins only.** PT blocks require Astro components for site-side rendering (`componentsEntry`), loaded at build time from an npm package. Sandboxed/marketplace plugins cannot define PT blocks.

Plugins can add custom block types to the Portable Text editor. These appear in the slash command menu and can be inserted into any `portableText` field.

## Declaring Block Types

In `definePlugin()`, declare blocks under `admin.portableTextBlocks`:

```typescript
admin: {
	portableTextBlocks: [
		{
			type: "youtube",
			label: "YouTube Video",
			icon: "video",
			placeholder: "Paste YouTube URL...",
			fields: [
				{ type: "text_input", action_id: "id", label: "YouTube URL" },
				{ type: "text_input", action_id: "title", label: "Title" },
				{ type: "text_input", action_id: "poster", label: "Poster Image URL" },
			],
		},
		{
			type: "codepen",
			label: "CodePen",
			icon: "code",
			placeholder: "Paste CodePen URL...",
		},
	],
}
```

### Block Config Fields

| Field         | Type     | Description                                     |
| ------------- | -------- | ----------------------------------------------- |
| `type`        | `string` | Block type name (used in PT `_type`). Required. |
| `label`       | `string` | Display name in slash command menu. Required.   |
| `icon`        | `string` | Icon key. Optional.                             |
| `description` | `string` | Description in slash command menu. Optional.    |
| `placeholder` | `string` | Input placeholder text. Optional.               |
| `fields`      | `array`  | Block Kit form fields for editing UI. Optional. |

### Icons

Named icons: `video`, `code`, `link`, `link-external`. Unknown or missing falls back to a generic cube icon.

### Fields

When `fields` is declared, the editor renders a Block Kit form for editing. When omitted, a simple URL input is shown.

Fields use Block Kit element syntax:

```typescript
fields: [
	{
		type: "text_input",
		action_id: "id",
		label: "URL",
		placeholder: "https://...",
	},
	{ type: "text_input", action_id: "title", label: "Title" },
	{ type: "text_input", action_id: "poster", label: "Poster Image" },
	{ type: "number_input", action_id: "start", label: "Start Time (seconds)" },
	{ type: "toggle", action_id: "autoplay", label: "Autoplay" },
	{
		type: "select",
		action_id: "size",
		label: "Size",
		options: [
			{ label: "Small", value: "small" },
			{ label: "Medium", value: "medium" },
			{ label: "Large", value: "large" },
		],
	},
];
```

See [Block Kit reference](./block-kit.md) for all element types.

The `action_id` of each field becomes a key in the Portable Text block data. The field with `action_id: "id"` is treated as the primary identifier (typically the URL).

### Data Flow

1. User types `/` in the editor and selects a block type
2. Modal opens with Block Kit form (or simple URL input if no fields)
3. User fills in fields and submits
4. Block is inserted with `_type` set to the block type and field values as properties
5. Editing an existing block re-opens the modal pre-populated

Portable Text output:

```json
{
	"_type": "youtube",
	"_key": "abc123",
	"id": "https://youtube.com/watch?v=dQw4w9WgXcQ",
	"title": "Never Gonna Give You Up",
	"poster": "https://img.youtube.com/vi/dQw4w9WgXcQ/0.jpg"
}
```

## Site-Side Rendering

To render block types on the site, export Astro components from a `componentsEntry`.

### Component File

```typescript
// src/astro/index.ts
import YouTube from "./YouTube.astro";
import CodePen from "./CodePen.astro";

// This export name is required
export const blockComponents = {
	youtube: YouTube,
	codepen: CodePen,
};
```

### Astro Component

```astro
---
// src/astro/YouTube.astro
const { id, title, poster } = Astro.props.node;

// Extract video ID from URL
const videoId = id?.match(/(?:v=|youtu\.be\/)([^&]+)/)?.[1] ?? id;
---

<div class="youtube-embed">
	<iframe
		src={`https://www.youtube-nocookie.com/embed/${videoId}`}
		title={title || "YouTube Video"}
		allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
		allowfullscreen
	></iframe>
</div>
```

Component receives `Astro.props.node` with the full block data.

### Plugin Descriptor

Set `componentsEntry` in the descriptor:

```typescript
export function myPlugin(options = {}): PluginDescriptor {
	return {
		id: "my-plugin",
		entrypoint: "@my-org/my-plugin",
		componentsEntry: "@my-org/my-plugin/astro",
		version: "1.0.0",
		options,
	};
}
```

### Package Exports

Add the `./astro` export:

```json
{
	"exports": {
		".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
		"./admin": { "types": "./dist/admin.d.ts", "import": "./dist/admin.js" },
		"./astro": {
			"types": "./dist/astro/index.d.ts",
			"import": "./dist/astro/index.js"
		}
	}
}
```

### Auto-Wiring

Plugin block components are automatically merged into `<PortableText>` on the site. Merge order:

1. EmDash defaults (lowest priority)
2. Plugin block components
3. User-provided components (highest priority)

Site authors don't need to import anything. User components take precedence over plugin defaults.

## Complete Example

```typescript
// src/index.ts
import { definePlugin } from "emdash";
import type { PluginDescriptor } from "emdash";

export function embedsPlugin(options = {}): PluginDescriptor {
	return {
		id: "embeds",
		version: "1.0.0",
		entrypoint: "@my-org/plugin-embeds",
		componentsEntry: "@my-org/plugin-embeds/astro",
		options,
	};
}

export function createPlugin() {
	return definePlugin({
		id: "embeds",
		version: "1.0.0",

		admin: {
			portableTextBlocks: [
				{
					type: "youtube",
					label: "YouTube Video",
					icon: "video",
					placeholder: "Paste YouTube URL...",
					fields: [
						{ type: "text_input", action_id: "id", label: "YouTube URL" },
						{ type: "text_input", action_id: "title", label: "Title" },
						{
							type: "text_input",
							action_id: "poster",
							label: "Poster Image URL",
						},
					],
				},
				{
					type: "linkPreview",
					label: "Link Preview",
					icon: "link-external",
					placeholder: "Paste any URL...",
				},
			],
		},
	});
}

export default createPlugin;
```

```typescript
// src/astro/index.ts
import YouTube from "./YouTube.astro";
import LinkPreview from "./LinkPreview.astro";

export const blockComponents = {
	youtube: YouTube,
	linkPreview: LinkPreview,
};
```
