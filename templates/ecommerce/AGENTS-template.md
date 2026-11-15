## This Template

An ecommerce storefront with editable products, services, categories, informational pages, cart, checkout, order follow-up, and email transport configuration.

## Pages

| Page | Path | Purpose |
| --- | --- | --- |
| Home | `/` | Hero, featured products, promotions, categories, services, and brand story |
| Catalog | `/catalogo` | Product listing with the shared EmDash shop cart |
| Product detail | `/catalogo/[...slug]` | Product information, variants, stock, and add-to-cart |
| Services | `/servicios` | Service listing |
| Service detail | `/servicios/[slug]` | Service information, open enrollment, or booking availability |
| Checkout | `/shop/checkout` | Customer details and order creation |
| Thanks | `/shop/thanks` | Order confirmation |
| Tracking | `/seguimiento` | Entry point for public order lookup |
| Informational pages | `/{slug}` | About, contact, FAQ, shipping, policies, and claims book |

## Customisation

Edit content in the admin before changing page structure. The home page reads its hero and brand-story fields from the `home` entry, while cards read products and services from their collections.

The sample palette uses warm neutral surfaces, terracotta brand colors, and a display serif. Replace the CSS variables in `src/styles/theme.css` to rebrand the site.

The newsletter form is a frontend placeholder. Connect it to a subscription endpoint or the forms plugin before presenting it as an active subscription flow.

## Email transport

The Resend provider is registered in `astro.config.mjs`. The provider reads its API key and sender address from plugin settings. The email templates plugin supplies the admin UI for transactional templates; order-specific email hooks can be added after the store's notification policy is defined.
