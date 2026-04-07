# Phase 1: Discovery & Reference Capture

Before writing any code, gather comprehensive reference materials from the demo site.

## 1.0 Create Discovery Folder

Create a `discovery/` folder in your theme directory to store all reference materials:

```
discovery/
├── screenshots/          # Reference screenshots from demo site
│   ├── homepage.png
│   ├── single-post.png
│   ├── archive.png
│   ├── category.png
│   ├── page.png
│   └── 404.png
├── images/               # Sample images downloaded for seed content
│   ├── featured-1.jpg
│   ├── featured-2.jpg
│   └── hero.jpg
└── notes.md              # Design decisions and observations
```

The `notes.md` file should capture:

- Color values extracted from the demo
- Font families and sizes observed
- Layout patterns (header style, sidebar position, footer columns)
- Special components or interactions to recreate
- Anything that might be forgotten between sessions

## 1.1 Identify All Page Types

Identify the URL of the demo site for the WordPress theme you are converting. For wordpress.org themes, this is usually wp-themes.com/theme-name/. For other themes, use the "Live Preview" link. This may show it inside a frame; if so, ignore the frame and focus on the theme's actual content.

Use the agent-browser to explore the demo site to find every distinct page type:

- **Homepage** - Often has unique layout (hero, featured posts, etc.)
- **Blog/Archive** - Post listing page
- **Single Post** - Individual blog post with content
- **Page** - Static page (About, Contact, etc.)
- **Category/Tag Archive** - Taxonomy listing pages
- **Search Results** - If the theme has custom search styling
- **404 Page** - Error page styling

Use agent-browser to navigate the demo and discover pages:

```bash
agent-browser open https://demo-site.com
# Click around to find different page types
# Check the navigation menu for page links
# Look for "View all posts" or category links
```

## 1.2 Screenshot All Page Types

Capture full-page screenshots of each page type to `discovery/screenshots/`:

```bash
# Homepage
agent-browser open https://demo-site.com
agent-browser screenshot discovery/screenshots/homepage.png --full

# Single post (find a post with featured image and good content)
agent-browser open https://demo-site.com/sample-post/
agent-browser screenshot discovery/screenshots/single-post.png --full

# Blog archive
agent-browser open https://demo-site.com/blog/
agent-browser screenshot discovery/screenshots/archive.png --full

# Category page
agent-browser open https://demo-site.com/category/news/
agent-browser screenshot discovery/screenshots/category.png --full

# Static page
agent-browser open https://demo-site.com/about/
agent-browser screenshot discovery/screenshots/page.png --full

# 404 page
agent-browser open https://demo-site.com/nonexistent-page-xyz/
agent-browser screenshot discovery/screenshots/404.png --full
```

## 1.3 Download Sample Images

If the theme is open source (GPL), download sample images from the demo to `discovery/images/`. This ensures visual consistency when comparing.

```bash
# Find featured images in demo posts
agent-browser eval "Array.from(document.querySelectorAll('article img')).map(i => i.src)"

# Download images for seed content
curl -o discovery/images/featured-1.jpg "https://demo-site.com/wp-content/uploads/photo1.jpg"
curl -o discovery/images/featured-2.jpg "https://demo-site.com/wp-content/uploads/photo2.jpg"
```

For premium themes or when images aren't freely available, use Unsplash images that match the demo's visual style (same aspect ratios, similar subjects).

## 1.4 Document Page Structure

For each page type, document observations in `discovery/notes.md`:

- Header style (sticky? transparent? logo position?)
- Sidebar presence and position
- Footer layout (columns? widgets?)
- Special components (hero sections, CTAs, etc.)
- Color values (use browser DevTools color picker)
- Font families and sizes
- Spacing patterns

This inventory guides which templates and components you need to build, and preserves details that might be forgotten between sessions.

## Theme Source Discovery

### WordPress.org Themes

For themes on wordpress.org (e.g., `https://wordpress.org/themes/theme-name/`):

1. **Demo/Preview**: Click "Preview" button or visit `https://wp-themes.com/theme-name/`
2. **Source Download**: The "Download" button provides a ZIP, or use:
   ```bash
   curl -O https://downloads.wordpress.org/theme/theme-name.zip
   unzip theme-name.zip
   ```
3. **Theme Info**: The page includes author, version, tags, and description

### GitHub-Hosted Themes

1. **Source**: Clone or download the repository
2. **Demo**: Check README for demo URL, or look for `Demo:` in theme description
3. **Documentation**: Usually in README or `/docs` folder

### ThemeForest / Premium Themes

1. **Demo**: Use the "Live Preview" button on the product page
2. **Source**: Requires purchase - ask the user to provide the unzipped theme files
3. **Documentation**: Usually included in the download or linked from the product page

### Auto-Discovery

When given only a theme URL or name, derive URLs yourself:

1. Fetch the listing page to extract demo URL, download URL, and theme info
2. Download the source (if freely available)
3. Open the demo in agent-browser

Don't ask the user for URLs you can derive yourself.
