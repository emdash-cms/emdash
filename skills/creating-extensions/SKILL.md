---
name: creating-extensions
description: Create EmDash extensions — custom admin pages with full database and storage access. Use this skill when asked to build admin tools, dashboards, export pages, or any feature that needs direct database queries or R2 storage access from the admin sidebar.
---

# Creating EmDash Extensions

Extensions are Astro pages that appear in the admin sidebar with full access to the database, storage, and authenticated user. They fill the gap between plugins (sandboxed, limited API) and custom Astro pages (no sidebar integration).

## When to Use Extensions vs Plugins

| Need | Use |
|------|-----|
| Send email, react to content changes, webhooks | Plugin |
| Simple settings page with form fields | Plugin |
| Query all database tables directly | Extension |
| Upload files to R2 storage | Extension |
| Custom analytics dashboard | Extension |
| Bulk import/export tool | Extension |
| Deploy trigger with custom UI | Extension |

**Rule:** If the plugin `ctx` API is enough, use a plugin. If you need `db` or `storage` directly, use an extension.

## Quick Start

### 1. Create the extension folder

```
src/extensions/my-tool/
	page.astro
```

### 2. Write the page

```astro
---
export const prerender = false;

const user = (Astro.locals as any).user;
if (!user) return Astro.redirect("/_emdash/admin");
if (user.role < 50) return new Response("Forbidden", { status: 403 });

const emdash = (Astro.locals as any).emdash;
const db = emdash?.db;
---
<html lang="en">
<head>
	<meta charset="utf-8" />
	<title>My Tool</title>
</head>
<body>
	<h1>My Tool</h1>
	<p>Extension is working.</p>
</body>
</html>
```

### 3. Register in astro.config.mjs

```ts
emdash({
	extensions: [
		{ name: "my-tool", label: "My Tool", icon: "rocket", group: "manage" },
	],
})
```

### 4. Build and deploy

The extension appears in the admin sidebar under the specified group.

## Extension Descriptor

```ts
{
	name: string;       // Slug: lowercase, hyphens, no special chars
	label: string;      // Display name in sidebar
	icon?: string;      // Phosphor icon name (default: "upload")
	group?: string;     // Sidebar group: "content" | "manage" | "admin" (default: "manage")
}
```

### Available Icons

| Name | Icon |
|------|------|
| `rocket` | Rocket |
| `upload` | Upload |
| `database` | Database |
| `gear` | Gear |
| `list` | List |
| `globe` | Globe |

Unrecognized names fall back to Upload.

### Sidebar Groups

| Group | Appears alongside |
|-------|------------------|
| `content` | Posts, Pages, Media |
| `manage` | Menus, Tags, Bylines |
| `admin` | Users, Plugins, Settings |

## What Extensions Can Access

The page runs as a standard Astro page with full access to:

```ts
// Database (Kysely instance)
const db = (Astro.locals as any).emdash?.db;
const posts = await db.selectFrom("ec_posts").selectAll().execute();

// Storage (R2/S3)
const storage = (Astro.locals as any).emdash?.storage;
await storage.upload({ key: "exports/data.json", body: jsonBytes, contentType: "application/json" });

// Authenticated user
const user = (Astro.locals as any).user;
// user.role: 50 = admin, 40 = editor, 30 = author, 20 = contributor

// Request
const url = Astro.url;
const method = Astro.request.method;
const formData = await Astro.request.formData();
```

## File Structure

```
src/extensions/
	my-tool/
		page.astro            # Required — the page rendered in the admin
		integration.ts        # Optional — build-time setup (Vite aliases, extra routes)
		helper.ts             # Optional — any helper files the page imports
```

### page.astro (Required)

The main page. Must have `export const prerender = false;`. Should check auth:

```astro
---
export const prerender = false;
const user = (Astro.locals as any).user;
if (!user) return Astro.redirect("/_emdash/admin");
if (user.role < 50) return new Response("Forbidden", { status: 403 });
---
```

### integration.ts (Optional)

Build-time setup. Only needed if the page imports something Vite can't resolve (like emdash internal modules). Returns an Astro integration:

```ts
import { createRequire } from "node:module";
import path from "node:path";
import type { AstroIntegration } from "astro";

export function myToolSetup(): AstroIntegration {
	return {
		name: "my-tool-setup",
		hooks: {
			"astro:config:setup": ({ updateConfig }) => {
				const require = createRequire(path.join(process.cwd(), "package.json"));
				const emdashRoot = require.resolve("emdash").replace(/[/\\]dist[/\\].*$/, "");
				updateConfig({
					vite: {
						resolve: {
							alias: {
								"my-custom-alias": path.join(emdashRoot, "src/some/internal/module.ts"),
							},
						},
					},
				});
			},
		},
	};
}
```

Most extensions don't need this. Only use it when importing emdash internals that aren't publicly exported.

## How It Works

1. emdash reads `extensions` from config at build time
2. Validates each name against `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`
3. Resolves `src/extensions/{name}/page.astro` and injects a route at `/_emdash/ext/{name}`
4. If `integration.ts` exists, imports and runs its setup hook
5. Serializes extension metadata (label, icon, group, URL) into the manifest
6. The admin sidebar reads extensions from the manifest and adds nav items
7. Clicking an extension navigates to a TanStack Router route that renders an iframe
8. The iframe loads the Astro page at `/_emdash/ext/{name}`

## Handling Form Submissions

Extensions support POST requests for form handling:

```astro
---
export const prerender = false;

const user = (Astro.locals as any).user;
if (!user) return Astro.redirect("/_emdash/admin");

let result = null;

if (Astro.request.method === "POST") {
	const formData = await Astro.request.formData();
	const name = formData.get("name") as string;
	// process the form...
	result = { success: true };
}
---
<html>
<body>
	{result?.success && <p>Done!</p>}
	<form method="POST">
		<input name="name" type="text" />
		<button type="submit">Submit</button>
	</form>
</body>
</html>
```

## Client-Side JavaScript

Extensions can include inline JavaScript for client-side behavior:

```astro
<button id="my-btn">Click me</button>
<div id="status"></div>

<script is:inline>
(function() {
	document.getElementById("my-btn").addEventListener("click", function() {
		document.getElementById("status").textContent = "Clicked!";
		fetch("https://api.example.com/trigger", { method: "POST" })
			.then(function(res) {
				document.getElementById("status").textContent = res.ok ? "Done!" : "Failed";
			});
	});
})();
</script>
```

## Security

- Extension names are validated against a strict slug regex
- Resolved paths are checked to not escape the project root
- The iframe route validates the slug client-side before constructing the src URL
- Extensions must check auth themselves (`user.role < 50`)
- The emdash middleware chain (auth, CSRF) runs before the extension page
- Extensions run as trusted code (same as any Astro page in the project)

