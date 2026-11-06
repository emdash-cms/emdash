# emdash

The core EmDash CMS package - an Astro-native, agent-portable reimplementation of WordPress.

## Installation

```shell
npm install emdash
```

## Features

- **Content Management** - Collections, fields, Live Collections integration
- **Media Library** - Upload via signed URLs, S3-compatible storage
- **Full-Text Search** - FTS5 with Porter stemming, per-collection config
- **Navigation Menus** - Hierarchical menus with URL resolution
- **Taxonomies** - Categories, tags, custom taxonomies
- **Widget Areas** - Content, menu, and component widgets
- **Sections** - Reusable content blocks
- **Plugin System** - Hooks, storage, settings, admin pages
- **WordPress Import** - WXR, REST API, WordPress.com

## Quick Start

```typescript
// astro.config.mjs
import { defineConfig } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";

export default defineConfig({
	integrations: [
		emdash({
			database: sqlite({ url: "file:./data.db" }),
			storage: local({
				directory: "./uploads",
				baseUrl: "/_emdash/api/media/file",
			}),
		}),
	],
});
```

```typescript
// src/live.config.ts
import { defineLiveCollection } from "astro:content";
import { emdashLoader } from "emdash/runtime";

export const collections = {
	_emdash: defineLiveCollection({ loader: emdashLoader() }),
};
```

## API

```typescript
import {
	getEmDashCollection,
	getEmDashEntry,
	getSiteSettings,
	getMenu,
	getTaxonomyTerms,
	getWidgetArea,
	search,
} from "emdash";

// Content
const { entries } = await getEmDashCollection("posts");
const { entry } = await getEmDashEntry("posts", "hello-world");

// Site settings
const settings = await getSiteSettings();

// Navigation
const menu = await getMenu("primary");

// Taxonomies
const categories = await getTaxonomyTerms("categories");

// Widgets
const sidebar = await getWidgetArea("sidebar");

// Search
const results = await search("hello world", { collections: ["posts"] });
```

## Internal entrypoints

Subpaths under `emdash/internal/` are loaded by the EmDash Astro integration and by first-party packages such as `@emdash-cms/cloudflare`. They are not public API, and their exports can change or be removed in any release. Import from the documented entrypoints instead.

## Documentation

See the [documentation site](https://docs.emdashcms.com) for guides, API reference, and plugin development.
