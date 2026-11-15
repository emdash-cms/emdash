This is an EmDash ecommerce site template built on Astro.

## Commands

```bash
pnpm dev
pnpm typecheck
```

The public site runs at `http://localhost:4321`; the admin is at `/_emdash/admin`.

## Key files

- `astro.config.mjs` enables the shop runtime, local storage, email templates, and Resend.
- `seed/seed.json` defines pages, products, services, categories, menus, and demo content.
- `src/layouts/Base.astro` contains the shared navigation, metadata, footer, and newsletter entry point.
- `src/components/ItemDetail.astro` handles product/service detail pages and the local cart payload.
- `src/pages/shop/checkout.astro` creates orders through the EmDash shop API.

## Content model

- `products` is for physical or digital products with price, stock, variants, images, and details.
- `services` is for bookable or open-enrollment services. Use `registration_mode: "scheduled"` with `requires_booking: true` when the customer must choose a slot.
- `pages` contains the home content fields and the editable informational pages used by the footer.
- The taxonomy name is `category`; use that exact name when querying or filtering terms.

## Email setup

The template registers `emailTemplatesPlugin({ enabled: true })` and `resendEmail()`.
After starting the site, configure the Resend API key and sender address in `Admin → Settings → Plugins → Resend Email`. The API key belongs in the plugin secret field and must not be committed to the repository.

## Rules

- Keep content pages server-rendered. Do not add `getStaticPaths()` for CMS content.
- Image fields are objects. Render them with `<Image image={...} />` from `emdash/ui`.
- Call `Astro.cache.set(cacheHint)` on pages that query content.
- Keep product and service cart items on the existing `/shop/checkout` flow so the server can validate stock and service capacity.
- Run `pnpm lint:quick` and `pnpm typecheck` after changes.
