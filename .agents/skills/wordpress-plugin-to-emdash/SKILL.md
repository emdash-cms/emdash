---
name: wordpress-plugin-to-emdash
description: Port a WordPress plugin to EmDash CMS. Use this skill when asked to migrate, convert, or port a WordPress plugin, theme functionality, or custom post type to EmDash. Provides concept mapping and implementation patterns.
---

# Porting WordPress Plugins to EmDash

This skill maps WordPress concepts to their EmDash equivalents for plugin porting. For general plugin authoring details (plugin structure, `definePlugin()`, hooks, storage, admin UI, etc.), use the **creating-plugins** skill.

## Migration Approach

1. **Understand the plugin** — What does it do, not how
2. **Identify concepts** — Content types, admin pages, hooks, shortcodes
3. **Map to EmDash** — Use the tables below
4. **Implement in TypeScript** — Clean room, not line-by-line port. Use the **creating-plugins** skill for implementation details.
5. **Test behaviour** — Same result, different implementation

## Concept Mapping

### Content & Data

| WordPress               | EmDash                                    | Notes                                         |
| ----------------------- | ----------------------------------------- | --------------------------------------------- |
| `register_post_type()`  | `SchemaRegistry.createCollection()`       | Via Admin API or seed file                    |
| `register_taxonomy()`   | `_emdash_taxonomy_defs` table             | Hierarchical or flat, attached to collections |
| `register_meta()` / ACF | Collection fields via SchemaRegistry      | All become typed schema fields                |
| `get_post_meta()`       | `entry.data.fieldName`                    | Direct typed access                           |
| `get_option()`          | `getSiteSetting()` / `ctx.kv`             | Site settings or plugin-namespaced KV         |
| `WP_Query`              | `getEmDashCollection()`                   | Runtime queries with filters                  |
| `get_post($id)`         | `getEmDashEntry(collection, slug)`        | Returns entry or null                         |
| `wp_insert_post()`      | `POST /_emdash/api/content/{type}`        | REST API                                      |
| `wp_update_post()`      | `PUT /_emdash/api/content/{type}/{id}`    | REST API                                      |
| `wp_delete_post()`      | `DELETE /_emdash/api/content/{type}/{id}` | Soft delete                                   |
| Custom tables           | Plugin storage collections                | `ctx.storage.collectionName.put/get/query`    |

### Site Configuration

| WordPress                | EmDash                      | Notes                                    |
| ------------------------ | --------------------------- | ---------------------------------------- |
| `get_bloginfo('name')`   | `getSiteSetting('title')`   | From `options` table with `site:` prefix |
| `get_option('blogdesc')` | `getSiteSetting('tagline')` | Site settings API                        |
| Theme Customizer         | Site Settings admin page    | `/_emdash/admin/settings`                |
| `site_icon`              | `getSiteSetting('favicon')` | Media reference                          |
| `custom_logo`            | `getSiteSetting('logo')`    | Media reference                          |

### Navigation Menus

| WordPress              | EmDash                                  | Notes                               |
| ---------------------- | --------------------------------------- | ----------------------------------- |
| `register_nav_menu()`  | Create menu via admin or seed           | `_emdash_menus` table               |
| `wp_nav_menu()`        | `getMenu(name)`                         | Returns `{ items: MenuItem[] }`     |
| `wp_nav_menu_item`     | `_emdash_menu_items` table              | Type: custom, page, post, taxonomy  |
| `_menu_item_object_id` | `reference_id` + `reference_collection` | Links to content entries            |
| Menu locations         | Query by name in templates              | No locations concept — direct query |

### Taxonomies

| WordPress             | EmDash                                  | Notes                          |
| --------------------- | --------------------------------------- | ------------------------------ |
| `register_taxonomy()` | `_emdash_taxonomy_defs` table           | Define via admin, seed, or API |
| `get_terms()`         | `getTaxonomyTerms(name)`                | Returns tree for hierarchical  |
| `get_the_terms()`     | `getEntryTerms(collection, id, name)`   | Terms for specific entry       |
| `wp_set_post_terms()` | `TaxonomyRepository.setTermsForEntry()` | Replace terms for entry        |
| Hierarchical taxonomy | `hierarchical: true` in definition      | Categories-style               |
| Flat taxonomy         | `hierarchical: false`                   | Tags-style                     |

### Widgets & Sidebars

| WordPress            | EmDash                                 | Notes                           |
| -------------------- | -------------------------------------- | ------------------------------- |
| `register_sidebar()` | `_emdash_widget_areas` table           | Create via admin or seed        |
| `dynamic_sidebar()`  | `getWidgetArea(name)`                  | Returns `{ widgets: Widget[] }` |
| `WP_Widget` class    | Widget types: content, menu, component | Simplified — 3 types only       |
| Text widget          | `type: 'content'` + Portable Text      | Rich text widget                |
| Nav Menu widget      | `type: 'menu'` + `menuName`            | References a menu               |
| Custom widgets       | `type: 'component'` + `componentId`    | Plugin-registered components    |

### Admin UI

| WordPress                | EmDash                            | Notes                                    |
| ------------------------ | --------------------------------- | ---------------------------------------- |
| `add_menu_page()`        | `admin.pages` in `definePlugin()` | Plugin config                            |
| `add_submenu_page()`     | Nested admin pages                | Parent determines hierarchy              |
| `add_settings_section()` | `admin.settingsSchema`            | Auto-generated settings page             |
| `add_meta_box()`         | Field groups in collection schema | UI config in schema                      |
| `wp_enqueue_script()`    | ESM imports in admin components   | React (trusted) or Block Kit (sandboxed) |
| Admin notices            | Toast notifications               | Via admin UI framework                   |

### Hooks

| WordPress                          | EmDash                                  | Notes                                                 |
| ---------------------------------- | --------------------------------------- | ----------------------------------------------------- |
| `add_action('init')`               | `plugin:install` hook                   | Runs once on first install                            |
| `add_action('save_post')`          | `content:afterSave` hook                | Filter by `event.collection`                          |
| `add_action('before_delete_post')` | `content:beforeDelete` hook             | Return false to prevent                               |
| `add_action('wp_head')`            | `page:metadata` / `page:fragments` hook | Metadata is sandbox-safe; scripts need trusted plugin |
| `add_action('rest_api_init')`      | `definePlugin({ routes })`              | Trusted only                                          |
| `add_filter('the_content')`        | Portable Text components                | Custom block renderers                                |
| `add_filter('the_title')`          | Template logic                          | Handle in Astro component                             |

### Frontend Output

| WordPress               | EmDash                       | Notes                                                |
| ----------------------- | ---------------------------- | ---------------------------------------------------- |
| `add_shortcode()`       | Portable Text custom block   | Content → block. Template → component. Trusted only. |
| `register_block_type()` | PT block + `componentsEntry` | Block data → Astro component props. Trusted only.    |
| Template tags           | Astro expressions            | `get_the_title()` → `{post.data.title}`              |
| Widgets                 | Widget area + components     | Query with `getWidgetArea()`                         |

### Plugin Storage

| WordPress                | EmDash                   | Notes                              |
| ------------------------ | ------------------------ | ---------------------------------- |
| `get_option('plugin_*')` | `ctx.kv.get(key)`        | Namespaced to plugin automatically |
| `update_option()`        | `ctx.kv.set(key, value)` | Scoped KV storage                  |
| `delete_option()`        | `ctx.kv.delete(key)`     | Delete single key                  |
| Custom tables            | `ctx.storage.collection` | Document collections with indexes  |
| Transients               | Plugin KV                | No TTL yet                         |

## Porting-Specific Patterns

These patterns cover WordPress-specific concepts that don't have a direct 1:1 mapping. For general plugin patterns (defining hooks, storage, routes, admin UI), see the **creating-plugins** skill.

### Shortcodes → Portable Text Blocks

WordPress shortcodes (`[youtube id="xxx"]`) become Portable Text custom block types. The block data replaces shortcode attributes, and an Astro component replaces the shortcode render function. This is a trusted-only feature.

```typescript
// WordPress
add_shortcode('youtube', function($atts) {
    return '<iframe src="https://youtube.com/embed/' . $atts['id'] . '"></iframe>';
});

// EmDash — block type declaration in definePlugin()
admin: {
	portableTextBlocks: [{
		type: "youtube",
		label: "YouTube Video",
		icon: "video",
		fields: [
			{ type: "text_input", action_id: "id", label: "YouTube URL" },
			{ type: "text_input", action_id: "title", label: "Title" },
		],
	}],
}

// EmDash — Astro component for rendering
// src/astro/YouTube.astro
const { id, title } = Astro.props.node;
const videoId = id?.match(/(?:v=|youtu\.be\/)([^&]+)/)?.[1] ?? id;
// <iframe src={`https://youtube-nocookie.com/embed/${videoId}`} ... />
```

### Options API → Plugin KV

WordPress's `get_option`/`update_option` maps to the plugin KV store. The key difference: WordPress options are global, EmDash KV is automatically scoped to the plugin.

```typescript
// WordPress
$count = get_option("myplugin_post_count", 0);
update_option("myplugin_post_count", $count + 1);
delete_option("myplugin_temp_data");

// EmDash — no prefix needed, automatically scoped
const count = (await ctx.kv.get<number>("post-count")) ?? 0;
await ctx.kv.set("post-count", count + 1);
await ctx.kv.delete("temp-data");
```

### Custom Database Tables → Storage Collections

WordPress plugins that create custom tables with `$wpdb->query("CREATE TABLE ...")` should use EmDash's storage collections instead. No migrations needed — declare the schema in `definePlugin()` and it's automatically provisioned.

```typescript
// WordPress
$wpdb->insert($table, ['form_id' => $id, 'data' => json_encode($data), 'created_at' => current_time('mysql')]);
$results = $wpdb->get_results("SELECT * FROM $table WHERE form_id = '$id' ORDER BY created_at DESC LIMIT 50");

// EmDash — declared in definePlugin()
storage: {
	submissions: {
		indexes: ["formId", "createdAt", ["formId", "createdAt"]],
	},
},

// In a hook or route handler
await ctx.storage.submissions!.put(entryId, { formId, data, createdAt: new Date().toISOString() });
const result = await ctx.storage.submissions!.query({
	where: { formId },
	orderBy: { createdAt: "desc" },
	limit: 50,
});
```

### Seeding Data (replaces starter content, theme setup)

WordPress plugins that call `wp_insert_term()`, `register_nav_menu()`, or insert default content on activation should use a seed file:

```json
{
	"version": "1",
	"settings": { "title": "My Site", "tagline": "Welcome" },
	"taxonomies": [
		{
			"name": "category",
			"label": "Categories",
			"hierarchical": true,
			"collections": ["posts"],
			"terms": [
				{ "slug": "news", "label": "News" },
				{ "slug": "tutorials", "label": "Tutorials" }
			]
		}
	],
	"menus": [
		{
			"name": "primary",
			"label": "Primary Navigation",
			"items": [
				{ "type": "custom", "label": "Home", "url": "/" },
				{ "type": "page", "ref": "about", "collection": "pages" }
			]
		}
	],
	"redirects": [
		{ "source": "/?p=123", "destination": "/about" },
		{ "source": "/old-contact", "destination": "/contact", "type": 301 }
	]
}
```

```bash
npx emdash seed .emdash/seed.json
```

Use `redirects` for legacy WordPress URLs that still receive traffic after migration.

### Querying Content (replaces WP_Query)

```typescript
// WordPress
$query = new WP_Query(['post_type' => 'post', 'category_name' => 'tech', 'posts_per_page' => 10]);

// EmDash — in Astro component frontmatter
import { getEmDashCollection, getEntryTerms } from "emdash";
const { entries } = await getEmDashCollection("posts", {
	where: { category: "technology" },
	limit: 10,
});
```

### Menus (replaces wp_nav_menu)

```typescript
// WordPress
wp_nav_menu(['theme_location' => 'primary']);

// EmDash — in Astro component
import { getMenu } from "emdash";
const nav = await getMenu("primary");
// nav.items[].label, nav.items[].url, nav.items[].children
```

### Widget Areas (replaces dynamic_sidebar)

```typescript
// WordPress
dynamic_sidebar("sidebar-1");

// EmDash — in Astro component
import { getWidgetArea } from "emdash";
const sidebar = await getWidgetArea("sidebar");
// sidebar.widgets[].type: "content" | "menu" | "component"
```

## Red Flags (Need Human Decision)

Flag these for review — they may need architectural decisions:

1. **Deep WP integration** — Hooks into WP core features not in EmDash
2. **Theme dependencies** — Assumes specific theme structure
3. **Multisite features** — Not supported
4. **Complex WP_Query** — Meta queries may need custom implementation
5. **Direct SQL** — Schema differs, use Kysely or plugin storage
6. **Session/transient abuse** — Needs proper caching layer
7. **User capability checks** — Review role mapping (future)
8. **ob_start() buffering** — PHP pattern, rethink for streaming
9. **Cron jobs** — `wp_schedule_event()` has no direct equivalent; needs platform cron

## Output Format

When porting a plugin, provide:

1. **Analysis** — What the WP plugin does (concepts, not code)
2. **Concept mapping** — Which WP concepts map to which EmDash features
3. **Plugin code** — `src/descriptor.ts` and `src/index.ts` (use **creating-plugins** skill for structure)
4. **Seed data** — If plugin needs default taxonomies/menus/widgets
5. **Astro components** — For frontend output
6. **Flags** — Anything needing human decision
