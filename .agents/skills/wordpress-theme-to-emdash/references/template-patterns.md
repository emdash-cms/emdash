# PHP → Astro Template Patterns

Common WordPress PHP patterns and their Astro/EmDash equivalents.

## The Loop

### Basic Loop

```php
// WordPress
<?php if (have_posts()) : ?>
  <?php while (have_posts()) : the_post(); ?>
    <article>
      <h2><a href="<?php the_permalink(); ?>"><?php the_title(); ?></a></h2>
      <?php the_excerpt(); ?>
    </article>
  <?php endwhile; ?>
<?php else : ?>
  <p>No posts found.</p>
<?php endif; ?>
```

```astro
---
// Astro/EmDash
import { getEmDashCollection } from "emdash";
const { entries: posts } = await getEmDashCollection("posts");
---
{posts.length > 0 ? (
  posts.map(post => (
    <article>
      <h2><a href={`/posts/${post.id}`}>{post.data.title}</a></h2>
      <p>{post.data.excerpt}</p>
    </article>
  ))
) : (
  <p>No posts found.</p>
)}
```

### Custom Query

```php
// WordPress
$args = [
  'post_type' => 'portfolio',
  'posts_per_page' => 6,
  'orderby' => 'date',
  'order' => 'DESC',
];
$query = new WP_Query($args);
while ($query->have_posts()) : $query->the_post();
  // ...
endwhile;
wp_reset_postdata();
```

```astro
---
// Astro/EmDash
import { getEmDashCollection } from "emdash";
const { entries: items } = await getEmDashCollection("portfolio", {
  limit: 6,
  orderBy: { published_at: "desc" },
});
---
{items.map(item => (
  // ...
))}
```

## Single Post/Page

### Basic Single

```php
// WordPress single.php
<?php get_header(); ?>
<main>
  <?php while (have_posts()) : the_post(); ?>
    <article>
      <h1><?php the_title(); ?></h1>
      <div class="meta">
        <?php the_date(); ?> | <?php the_author(); ?>
      </div>
      <?php the_content(); ?>
    </article>
  <?php endwhile; ?>
</main>
<?php get_footer(); ?>
```

```astro
---
// Astro pages/posts/[slug].astro
// NOTE: EmDash pages are always server-rendered (no getStaticPaths)
import { getEmDashEntry } from "emdash";
import { PortableText } from "emdash/ui";
import Base from "../../layouts/Base.astro";

const { slug } = Astro.params;
const { entry: post } = await getEmDashEntry("posts", slug!);

if (!post) {
  return Astro.redirect("/404");
}
---
<Base title={post.data.title}>
	<main>
		<article>
			<h1>{post.data.title}</h1>
			<div class="meta">
				{post.data.publishedAt} | {post.data.byline?.displayName ?? "Unknown"}
			</div>
			<PortableText value={post.data.content} />
		</article>
  </main>
</Base>
```

## Featured Image

```php
// WordPress
<?php if (has_post_thumbnail()) : ?>
  <figure class="featured-image">
    <?php the_post_thumbnail('large'); ?>
  </figure>
<?php endif; ?>
```

```astro
---
// Astro
const { featured_image } = post.data;
---
{featured_image && (
  <figure class="featured-image">
    <img src={featured_image} alt={post.data.title} />
  </figure>
)}
```

## Pagination

### Archive Pagination

```php
// WordPress
<?php
the_posts_pagination([
  'prev_text' => '&laquo; Previous',
  'next_text' => 'Next &raquo;',
]);
?>
```

```astro
---
// Astro - using cursor pagination
import { getEmDashCollection } from "emdash";
const page = Astro.url.searchParams.get('page') || '1';
const { entries, nextCursor, prevCursor } = await getEmDashCollection("posts", {
  limit: 10,
  cursor: Astro.url.searchParams.get('cursor'),
});
---
<nav class="pagination">
  {prevCursor && <a href={`?cursor=${prevCursor}`}>&laquo; Previous</a>}
  {nextCursor && <a href={`?cursor=${nextCursor}`}>Next &raquo;</a>}
</nav>
```

### Post Navigation (Prev/Next)

```php
// WordPress
<?php
the_post_navigation([
  'prev_text' => '&larr; %title',
  'next_text' => '%title &rarr;',
]);
?>
```

```astro
---
// Astro - requires fetching adjacent posts
// This is more complex; typically done at query time
// or by storing prev/next references
---
```

## Conditionals

### Check Post Type

```php
// WordPress
<?php if (is_singular('portfolio')) : ?>
  <!-- Portfolio-specific content -->
<?php endif; ?>
```

```astro
---
// Astro - handled by file-based routing
// pages/portfolio/[slug].astro IS the portfolio single
---
```

### Check Page Template

```php
// WordPress
<?php if (is_page_template('templates/full-width.php')) : ?>
  <div class="full-width">
<?php else : ?>
  <div class="with-sidebar">
<?php endif; ?>
```

```astro
---
// Astro - add a "template" select field to your pages collection
// with options like "Default", "Full Width", etc.
// Then in your page route, map templates to layout components:

import PageDefault from "../../layouts/PageDefault.astro";
import PageFullWidth from "../../layouts/PageFullWidth.astro";

const layouts = {
  "Default": PageDefault,
  "Full Width": PageFullWidth,
};

const Layout = layouts[page.data.template as keyof typeof layouts] ?? PageDefault;
---
<Layout page={page} />
```

## Template Parts

### Include Template Part

```php
// WordPress
<?php get_template_part('template-parts/content', get_post_type()); ?>
// Loads template-parts/content-{post_type}.php
```

```astro
---
// Astro - use components
import PostCard from '../components/PostCard.astro';
import PortfolioCard from '../components/PortfolioCard.astro';

const CardComponent = post.collection === 'portfolio' ? PortfolioCard : PostCard;
---
<CardComponent post={post} />
```

### Reusable Card Component

```php
// WordPress template-parts/content.php
<article id="post-<?php the_ID(); ?>" <?php post_class(); ?>>
  <header class="entry-header">
    <?php the_title('<h2 class="entry-title"><a href="' . esc_url(get_permalink()) . '">', '</a></h2>'); ?>
  </header>
  <div class="entry-content">
    <?php the_excerpt(); ?>
  </div>
</article>
```

```astro
---
// Astro components/PostCard.astro
interface Props {
  post: {
    id: string;
    data: {
      title: string;
      excerpt?: string;
    };
  };
}
const { post } = Astro.props;
---
<article id={`post-${post.id}`} class="post">
  <header class="entry-header">
    <h2 class="entry-title">
      <a href={`/posts/${post.id}`}>{post.data.title}</a>
    </h2>
  </header>
  <div class="entry-content">
    <p>{post.data.excerpt}</p>
  </div>
</article>
```

## Navigation Menus

```php
// WordPress
<?php
wp_nav_menu([
  'theme_location' => 'primary',
  'container' => 'nav',
  'container_class' => 'primary-nav',
]);
?>
```

```astro
---
// Astro/EmDash - First-class menu support
import { getMenu } from "emdash";

const primaryMenu = await getMenu("primary");
---
<nav class="primary-nav">
  {primaryMenu && (
    <ul>
      {primaryMenu.items.map(item => (
        <li class={item.cssClasses}>
          <a
            href={item.url}
            target={item.target}
            title={item.titleAttr}
          >
            {item.label}
          </a>
          {/* Nested items for dropdowns */}
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

### Recursive Menu Component

```astro
---
// components/MenuItem.astro
interface Props {
  item: {
    label: string;
    url: string;
    target?: string;
    cssClasses?: string;
    children: Props['item'][];
  };
}
const { item } = Astro.props;
---
<li class={item.cssClasses}>
  <a href={item.url} target={item.target}>{item.label}</a>
  {item.children.length > 0 && (
    <ul class="submenu">
      {item.children.map(child => (
        <Astro.self item={child} />
      ))}
    </ul>
  )}
</li>
```

## Sidebars / Widget Areas

```php
// WordPress
<?php if (is_active_sidebar('sidebar-1')) : ?>
  <aside class="sidebar">
    <?php dynamic_sidebar('sidebar-1'); ?>
  </aside>
<?php endif; ?>
```

```astro
---
// Astro/EmDash - First-class widget area support
import { getWidgetArea, getMenu, getTaxonomyTerms, getEmDashCollection } from "emdash";
import { PortableText } from "emdash/astro";

const sidebar = await getWidgetArea("sidebar");
---
{sidebar && (
  <aside class="sidebar">
    {sidebar.widgets.map(async (widget) => (
      <div class="widget">
        {widget.title && <h3 class="widget-title">{widget.title}</h3>}

        {/* Content widget - rich text */}
        {widget.type === "content" && widget.content && (
          <PortableText value={widget.content} />
        )}

        {/* Menu widget - displays a navigation menu */}
        {widget.type === "menu" && widget.menuName && (
          <MenuWidget menuName={widget.menuName} />
        )}

        {/* Component widget - renders a registered component */}
        {widget.type === "component" && (
          <WidgetComponent
            componentId={widget.componentId}
            props={widget.componentProps}
          />
        )}
      </div>
    ))}
  </aside>
)}
```

### Widget Component Handler

```astro
---
// components/WidgetComponent.astro
import { getTaxonomyTerms, getEmDashCollection } from "emdash";

interface Props {
  componentId: string;
  props?: Record<string, unknown>;
}
const { componentId, props = {} } = Astro.props;

// Handle core widget components
let content = null;

if (componentId === "core:recent-posts") {
  const limit = (props.limit as number) || 5;
  const collection = (props.collection as string) || "posts";
  const { entries: posts } = await getEmDashCollection(collection, { limit });
  content = posts;
}

if (componentId === "core:categories") {
  const taxonomy = (props.taxonomy as string) || "categories";
  content = await getTaxonomyTerms(taxonomy);
}

if (componentId === "core:tag-cloud") {
  const taxonomy = (props.taxonomy as string) || "tags";
  content = await getTaxonomyTerms(taxonomy);
}
---
{componentId === "core:recent-posts" && content && (
  <ul class="recent-posts">
    {content.map(post => (
      <li><a href={`/posts/${post.data.slug}`}>{post.data.title}</a></li>
    ))}
  </ul>
)}

{componentId === "core:categories" && content && (
  <ul class="categories">
    {content.map(cat => (
      <li>
        <a href={`/categories/${cat.slug}`}>
          {cat.label}
          {props.showCounts && <span>({cat.count})</span>}
        </a>
      </li>
    ))}
  </ul>
)}

{componentId === "core:tag-cloud" && content && (
  <div class="tag-cloud">
    {content.map(tag => (
      <a href={`/tags/${tag.slug}`} class="tag">{tag.label}</a>
    ))}
  </div>
)}

{componentId === "core:search" && (
  <form action="/search" method="get">
    <input
      type="search"
      name="q"
      placeholder={props.placeholder || "Search..."}
    />
    <button type="submit">Search</button>
  </form>
)}
```

## Taxonomy Archives

### Category Archive

```php
// WordPress category.php
<?php
$category = get_queried_object();
?>
<h1><?php echo $category->name; ?></h1>
<p><?php echo $category->description; ?></p>

<?php while (have_posts()) : the_post(); ?>
  <!-- post loop -->
<?php endwhile; ?>
```

```astro
---
// Astro pages/categories/[slug].astro
// NOTE: EmDash pages are always server-rendered (no getStaticPaths)
import { getTerm, getEntriesByTerm } from "emdash";
import Base from "../../layouts/Base.astro";

const { slug } = Astro.params;
const category = await getTerm("categories", slug!);
const posts = await getEntriesByTerm("posts", "categories", slug!);

if (!category) {
  return Astro.redirect("/404");
}
---
<Base title={category.label}>
  <h1>{category.label}</h1>
  {category.description && <p>{category.description}</p>}

  {posts.map(post => (
    <article>
      <a href={`/posts/${post.data.slug}`}>{post.data.title}</a>
    </article>
  ))}
</Base>
```

### Tag Archive

```php
// WordPress tag.php
<?php
$tag = get_queried_object();
?>
<h1>Posts tagged: <?php echo $tag->name; ?></h1>
```

```astro
---
// Astro pages/tags/[slug].astro
// NOTE: EmDash pages are always server-rendered (no getStaticPaths)
import { getTerm, getEntriesByTerm } from "emdash";

const { slug } = Astro.params;
const tag = await getTerm("tags", slug!);
const posts = await getEntriesByTerm("posts", "tags", slug!);

if (!tag) {
  return Astro.redirect("/404");
}
---
<h1>Posts tagged: {tag.label}</h1>
{posts.map(post => (
  <article>
    <a href={`/posts/${post.data.slug}`}>{post.data.title}</a>
  </article>
))}
```

### Display Post Terms

```php
// WordPress - in single.php
<?php
$categories = get_the_category();
$tags = get_the_tags();
?>
<div class="post-meta">
  <span>Categories:
    <?php foreach ($categories as $cat) : ?>
      <a href="<?php echo get_category_link($cat); ?>"><?php echo $cat->name; ?></a>
    <?php endforeach; ?>
  </span>
  <span>Tags:
    <?php the_tags('', ', '); ?>
  </span>
</div>
```

```astro
---
// Astro - in post template
import { getEntryTerms } from "emdash";

const categories = await getEntryTerms("posts", post.id, "categories");
const tags = await getEntryTerms("posts", post.id, "tags");
---
<div class="post-meta">
  {categories.length > 0 && (
    <span>Categories:
      {categories.map((cat, i) => (
        <>
          {i > 0 && ", "}
          <a href={`/categories/${cat.slug}`}>{cat.label}</a>
        </>
      ))}
    </span>
  )}

  {tags.length > 0 && (
    <span>Tags:
      {tags.map((tag, i) => (
        <>
          {i > 0 && ", "}
          <a href={`/tags/${tag.slug}`}>{tag.label}</a>
        </>
      ))}
    </span>
  )}
</div>
```

### Hierarchical Category List

```php
// WordPress
<?php wp_list_categories(['hierarchical' => true]); ?>
```

```astro
---
// Astro - recursive category tree
import { getTaxonomyTerms } from "emdash";

const categories = await getTaxonomyTerms("categories");

// Recursive component for nested categories
function CategoryTree({ terms }) {
  return (
    <ul>
      {terms.map(term => (
        <li>
          <a href={`/categories/${term.slug}`}>
            {term.label} ({term.count})
          </a>
          {term.children?.length > 0 && (
            <CategoryTree terms={term.children} />
          )}
        </li>
      ))}
    </ul>
  );
}
---
<CategoryTree terms={categories} />
```

## Site Settings

```php
// WordPress
<?php
$site_name = get_bloginfo('name');
$site_desc = get_bloginfo('description');
$custom_logo_id = get_theme_mod('custom_logo');
$logo_url = wp_get_attachment_image_url($custom_logo_id, 'full');
?>
<header>
  <?php if ($logo_url) : ?>
    <img src="<?php echo $logo_url; ?>" alt="<?php echo $site_name; ?>" />
  <?php endif; ?>
  <h1><?php echo $site_name; ?></h1>
  <p><?php echo $site_desc; ?></p>
</header>
```

```astro
---
// Astro - using EmDash site settings
import { getSiteSettings } from "emdash";

const settings = await getSiteSettings();
---
<header>
  {settings.logo?.url && (
    <img src={settings.logo.url} alt={settings.logo.alt || settings.title} />
  )}
  <h1>{settings.title}</h1>
  {settings.tagline && <p>{settings.tagline}</p>}
</header>
```

## Comments

```php
// WordPress
<?php
if (comments_open() || get_comments_number()) :
  comments_template();
endif;
?>
```

EmDash doesn't include comments. Options:

1. **Giscus** - GitHub Discussions-based
2. **Disqus** - Third-party
3. **Custom** - Build with EmDash collections

```astro
---
// Astro with Giscus
---
<script src="https://giscus.app/client.js"
  data-repo="your/repo"
  data-repo-id="..."
  data-category="Comments"
  data-category-id="..."
  data-mapping="pathname"
  crossorigin="anonymous"
  async>
</script>
```

## Search

```php
// WordPress
<?php get_search_form(); ?>

// search.php
<?php if (have_posts()) : ?>
  <h1>Search Results for: <?php the_search_query(); ?></h1>
  <?php while (have_posts()) : the_post(); ?>
    <!-- results -->
  <?php endwhile; ?>
<?php else : ?>
  <p>No results found.</p>
<?php endif; ?>
```

```astro
---
// Astro pages/search.astro
import { getEmDashCollection } from "emdash";
import Base from "../layouts/Base.astro";

const query = Astro.url.searchParams.get('q') || '';
let results = [];

if (query) {
  // Note: Full-text search depends on EmDash implementation
  const { entries: posts } = await getEmDashCollection("posts");
  results = posts.filter(p =>
    p.data.title.toLowerCase().includes(query.toLowerCase())
  );
}
---
<Base title={`Search: ${query}`}>
  <form action="/search" method="get">
    <input type="search" name="q" value={query} />
    <button type="submit">Search</button>
  </form>

  {query && (
    <h1>Search Results for: {query}</h1>
    {results.length > 0 ? (
      results.map(post => (
        <!-- results -->
      ))
    ) : (
      <p>No results found.</p>
    )}
  )}
</Base>
```

## Custom Fields (ACF-style)

```php
// WordPress with ACF
<?php
$subtitle = get_field('subtitle');
$gallery = get_field('gallery');
?>
<h2><?php echo $subtitle; ?></h2>
<div class="gallery">
  <?php foreach ($gallery as $image) : ?>
    <img src="<?php echo $image['url']; ?>" />
  <?php endforeach; ?>
</div>
```

```astro
---
// Astro - fields are on post.data
const { subtitle, gallery } = post.data;
---
<h2>{subtitle}</h2>
<div class="gallery">
  {gallery?.map(image => (
    <img src={image.url} />
  ))}
</div>
```

## Date Formatting

```php
// WordPress
<?php echo get_the_date('F j, Y'); ?> // January 23, 2025
<?php echo human_time_diff(get_the_time('U'), current_time('timestamp')); ?> ago
```

```astro
---
// Astro
const date = post.data.publishedAt;
const formatted = date?.toLocaleDateString('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

// For relative time
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const diff = date ? Date.now() - date.getTime() : 0;
const days = Math.floor(diff / (1000 * 60 * 60 * 24));
const relative = rtf.format(-days, 'day');
---
<time datetime={date?.toISOString()}>{formatted}</time>
<span>{relative}</span>
```
