# Starter Image Guidelines

Use these minimum dimensions to avoid blurry or awkward crops:

- Post cards: `1600x900` (16:9)
- Post hero images: `2000x1125` (16:9)
- Site logo: `600x240`
- Favicon: `512x512`

Guardrails included in this template:

- Starter pages render a visual placeholder when a featured image is missing.
- `pnpm check:images` validates seed image coverage and alt text for posts.

Recommended workflow:

1. Run `pnpm check:images` before deploying.
2. Ensure every featured image has descriptive `alt` text.
3. Use compressed JPG/WebP for photos and SVG/PNG for logos.

Developer workflow:

1. Customize layout and styles directly in `src/pages`, `src/layouts`, and `src/styles`.
2. Keep design ownership with the developer; hand off content editing in admin.
