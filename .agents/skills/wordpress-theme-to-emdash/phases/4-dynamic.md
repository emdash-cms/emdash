# Phase 4: Dynamic Features

Implement CMS-driven features: site settings, menus, taxonomies, and widgets.

## 4.1 Site Settings

Map WordPress customizer values to EmDash site settings:

| WP Customizer Setting | EmDash Site Setting |
| --------------------- | ------------------- |
| Site Title            | `title`             |
| Tagline               | `tagline`           |
| Site Icon             | `favicon`           |
| Custom Logo           | `logo`              |
| Posts per page        | `postsPerPage`      |
| Date format           | `dateFormat`        |

```astro
---
import { getSiteSettings } from "emdash";
const settings = await getSiteSettings();
---
<header>
  {settings.logo ? (
    <img src={settings.logo.url} alt={settings.title} />
  ) : (
    <span class="site-title">{settings.title}</span>
  )}
  {settings.tagline && <p class="tagline">{settings.tagline}</p>}
</header>
```

## 4.2 Navigation Menus

Identify menus in `functions.php`:

```php
register_nav_menus([
    'primary' => 'Primary Navigation',
    'footer' => 'Footer Links',
]);
```

Use in templates:

```astro
---
import { getMenu } from "emdash";
const primaryNav = await getMenu("primary");
---
<nav class="primary-nav">
  {primaryNav && (
    <ul>
      {primaryNav.items.map(item => (
        <li>
          <a href={item.url} aria-current={Astro.url.pathname === item.url ? 'page' : undefined}>
            {item.label}
          </a>
          {item.children.length > 0 && (
            <ul class="submenu">
              {item.children.map(child => (
                <li><a href={child.url}>{child.label}</a></li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  )}
</nav>
```

## 4.3 Taxonomies

Identify taxonomies in theme:

```php
register_taxonomy('genre', 'book', [
    'label' => 'Genres',
    'hierarchical' => true,
]);
```

Use in templates:

```astro
---
import { getTaxonomyTerms, getEntryTerms, getEntriesByTerm } from "emdash";

// Get all terms
const genres = await getTaxonomyTerms("genre");

// Get terms for a specific entry
const bookGenres = await getEntryTerms("books", book.id, "genre");

// Get entries by term
const fictionBooks = await getEntriesByTerm("books", "genre", "fiction");
---
```

## 4.4 Widget Areas

Identify sidebars in theme:

```php
register_sidebar([
    'name' => 'Main Sidebar',
    'id' => 'sidebar-1',
]);
```

Use in templates:

```astro
---
import { getWidgetArea } from "emdash";
import { PortableText } from "emdash/ui";

const sidebar = await getWidgetArea("sidebar");
---
{sidebar && sidebar.widgets.length > 0 && (
  <aside class="sidebar">
    {sidebar.widgets.map(widget => (
      <div class="widget">
        {widget.title && <h3>{widget.title}</h3>}
        {widget.type === "content" && <PortableText value={widget.content} />}
      </div>
    ))}
  </aside>
)}
```

## 4.5 Widget Components

Map WP widgets to Astro components:

| WP Widget        | EmDash Component    |
| ---------------- | ------------------- |
| Recent Posts     | `core:recent-posts` |
| Categories       | `core:categories`   |
| Tag Cloud        | `core:tags`         |
| Search           | `core:search`       |
| Archives         | `core:archives`     |
| Text/Custom HTML | `type: 'content'`   |
| Navigation Menu  | `type: 'menu'`      |

See `references/emdash-api.md` for full API reference.
