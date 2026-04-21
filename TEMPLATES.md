# EmDash Templates

Starter templates for building sites with EmDash CMS. Each template includes a seed file with demo content, so you can see how everything works right away.

## Available Templates

### Blog

A clean, minimal blog with posts, pages, categories, tags, and search.

**Features:**

- Featured post hero on homepage
- Post grid with reading time estimates
- Category and tag archives
- Full-text search
- RSS feed
- SEO metadata and JSON-LD
- Dark/light mode

**Pages:** Homepage, post archive, single post, single page, category archive, tag archive, search results, 404

### Marketing

A landing page template for products and services with modular content blocks.

**Features:**

- Hero, features, testimonials, pricing, and FAQ blocks
- Contact form with validation
- Portable Text content editing
- SEO metadata and JSON-LD
- Dark/light mode

**Pages:** Homepage, pricing, contact, 404

### Portfolio

A portfolio for showcasing creative work with project pages and tag filtering.

**Features:**

- Project grid with hover effects
- Tag-based filtering on work page
- Individual project pages with galleries
- Contact page
- RSS feed for new projects
- SEO metadata and JSON-LD
- Dark/light mode

**Pages:** Homepage, work listing, single project, about, contact, 404

### Starter

A flexible baseline template for agencies building local business sites.

**Features:**

- Dynamic page routes for CMS-created pages
- Posts, pages, categories, and tags
- `setup:business` wizard for name/contact/hours/socials with structured site settings
- Design preset generator (classic/coastal/orchard)
- Minimal, editable structure for custom components

**Pages:** Homepage, post archive, single post, dynamic content pages, category archive, tag archive, 404

## Using a Template

Each template has runtime variants:

- **Node.js** (`templates/blog`, `templates/marketing`, `templates/portfolio`, `templates/starter`) — uses SQLite and local file storage
- **Vercel** (`templates/starter-vercel`) — Vercel adapter with production-safe env-based DB/storage config
- **Netlify** (`templates/starter-netlify`) — Netlify adapter with production-safe env-based DB/storage config
- **Cloudflare** (`templates/blog-cloudflare`, etc.) — uses D1 and R2

### Quick Start

```bash
# Copy the template you want
cp -r templates/blog my-site
cd my-site

# Install dependencies
pnpm install

# Initialize the database and seed demo content
pnpm bootstrap

# Optional: personalize content and apply a design preset
pnpm setup:business

# Start the dev server
pnpm dev
```

Open http://localhost:4321 to see your site, and http://localhost:4321/\_emdash/admin for the CMS.

### Template Structure

```
templates/blog/
├── src/
│   ├── components/     # Astro components
│   ├── layouts/        # Page layouts
│   ├── pages/          # Route pages
│   ├── utils/          # Helper functions
│   └── live.config.ts  # EmDash content loader
├── seed/
│   └── seed.json       # Demo content
├── astro.config.mjs    # Astro + EmDash config
├── package.json
└── tsconfig.json
```

## Contributing

### Runtime Variants

Runtime variants share most of their code with the base templates. Only runtime-specific files differ:

- `astro.config.mjs` (platform adapter + runtime database/storage)
- `package.json` (different dependencies)
- provider config files where applicable (for example `wrangler.jsonc`)
- `.env.example` for serverless variants

Everything else is synced from the base template using a script:

```bash
./scripts/sync-cloudflare-templates.sh
```

**Run this after making changes** to `src/`, `seed/`, `scripts/`, `tsconfig.json`, `emdash-env.d.ts`, or `.gitignore` in any base template. It copies those files to corresponding runtime variants.

### Deploying Starter to Vercel or Netlify

`starter-vercel` and `starter-netlify` are designed for:

- local development fallback with SQLite + local uploads
- production deployment with external database + object storage

Required production environment variables:

- `DATABASE_URL`
- `S3_ENDPOINT`
- `S3_BUCKET`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_REGION`
- `S3_PUBLIC_URL`

Recommended workflow for agency handoff:

1. Copy `templates/starter-vercel` or `templates/starter-netlify`
2. Run `pnpm install`
3. Run `pnpm setup:business` and enter business details + design preset
4. Run `pnpm bootstrap`
5. Push to Git provider and connect to Vercel/Netlify
6. Set the environment variables from `.env.example`
7. Deploy and hand off admin access

The primary Node demo is also synced from the blog template:

```bash
./scripts/sync-blog-demos.sh
```

This script does two kinds of sync:

- full template sync for `templates/blog` -> `demos/simple`
- frontend-only sync (keeping runtime-specific files) for:
  - `templates/blog-cloudflare` -> `demos/cloudflare`
  - `templates/blog-cloudflare` -> `demos/preview`
  - `templates/blog` -> `demos/postgres`

### Taking Screenshots

Template screenshots live in `assets/templates/{template}/latest/` and are used in the README. To update them after making visual changes:

```bash
# Screenshot all templates (starts each dev server automatically)
pnpm screenshots

# Screenshot specific templates
pnpm screenshots blog
pnpm screenshots blog marketing
```

The script starts each template's dev server, captures screenshots, then stops the server before moving to the next template.

Page definitions are in `templates/screenshots.json`. Each page is captured at desktop (1440x900) and mobile (390x844) in both light and dark mode at 2x resolution. Screenshots are JPEG at 80% quality.

Output goes to `assets/templates/{template}/{datetime}/` and is copied to `assets/templates/{template}/latest/`. The dated directories are gitignored; only `latest/` is committed. The README references images from `latest/`.

Filenames follow the pattern `{page}-{mode}-{breakpoint}.jpg`, e.g. `homepage-light-desktop.jpg`, `post-dark-mobile.jpg`.

To add pages for a template, edit `templates/screenshots.json`.

### Adding a New Template

1. Create the base template in `templates/{name}/`
2. Include a seed file at `seed/seed.json` (or configure the path in `package.json` under `emdash.seed`)
3. Add the `typecheck` script to `package.json`
4. Create runtime variants as needed (for example `templates/{name}-cloudflare`, `templates/{name}-vercel`, `templates/{name}-netlify`) with the appropriate adapter config
5. Add base-to-variant pairs to `scripts/sync-cloudflare-templates.sh`
6. Add the template's pages to `templates/screenshots.json` and run the screenshot script
7. Update the README template gallery

### Seed Files

Each template includes a seed file with demo content. The seed file format is documented in the CLI (`emdash seed --help`). Key points:

- Use `status: "published"` and include `published_at` for content that should appear on the site
- Reference media by URL — the seeder downloads and uploads images automatically
- Use the `taxonomies` object for categories and tags
- The `emdash.seed` field in `package.json` specifies the seed file location

### Testing Templates

Templates are covered by smoke tests that verify:

- Seed files parse correctly
- Seeds apply without errors
- The database passes doctor checks after seeding

Run the smoke tests:

```bash
pnpm --filter emdash exec vitest run --config vitest.smoke.config.ts
```
