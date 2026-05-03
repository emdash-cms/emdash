# Phase 6: Verify & Iterate

Seed content, run the dev server, compare screenshots, and iterate until pages match.

## 6.1 Start Dev Server

The seed is applied on the first request when the database is empty. If you've already run the dev server against an existing database, delete `data.db` first so the seed reapplies.

Kill any existing server first:

```bash
lsof -ti:4321 | xargs kill -9 2>/dev/null || true
rm -f data.db   # only if you need a clean slate
pnpm dev
```

Watch the logs for any seed validation errors and fix them before continuing.

## 6.3 Screenshot Each Page Type

Screenshot every page type you captured in Phase 1:

```bash
# Homepage
agent-browser open http://localhost:4321
agent-browser screenshot output/homepage.png --full

# Single post
agent-browser open http://localhost:4321/posts/hello-world
agent-browser screenshot output/single-post.png --full

# Blog archive
agent-browser open http://localhost:4321/posts
agent-browser screenshot output/archive.png --full

# Category page
agent-browser open http://localhost:4321/categories/news
agent-browser screenshot output/category.png --full

# Static page
agent-browser open http://localhost:4321/pages/about
agent-browser screenshot output/page.png --full

# 404 page
agent-browser open http://localhost:4321/nonexistent
agent-browser screenshot output/404.png --full
```

## 6.4 Compare & Iterate

Compare each screenshot pair:

| Page Type   | Reference                               | Output                   |
| ----------- | --------------------------------------- | ------------------------ |
| Homepage    | `discovery/screenshots/homepage.png`    | `output/homepage.png`    |
| Single Post | `discovery/screenshots/single-post.png` | `output/single-post.png` |
| Archive     | `discovery/screenshots/archive.png`     | `output/archive.png`     |
| Category    | `discovery/screenshots/category.png`    | `output/category.png`    |
| Page        | `discovery/screenshots/page.png`        | `output/page.png`        |
| 404         | `discovery/screenshots/404.png`         | `output/404.png`         |

For each page, identify differences and fix:

1. **Layout** - CSS grid/flexbox, content width, spacing
2. **Typography** - Font family, sizes, line height
3. **Colors** - Background, text, links, borders
4. **Components** - Headers, footers, cards, buttons
5. **Responsive** - Check mobile viewport too

Re-screenshot after each round of fixes.

**Don't aim for pixel-perfect** - aim for "same design language."

## 6.5 Final Build Test

```bash
pnpm run build
```

## License Compliance

WordPress themes are GPL-licensed. Every ported theme needs:

1. **LICENSE** - GPL-2.0 text (download with curl, don't output directly):

   ```bash
   curl -o LICENSE https://raw.githubusercontent.com/spdx/license-list-data/main/text/GPL-2.0-or-later.txt
   ```

2. **README.md** - Credits to original theme

3. **package.json** - `"license": "GPL-2.0-or-later"`
