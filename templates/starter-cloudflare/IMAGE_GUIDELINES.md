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

Theme workflow:

1. Select a preset via `pnpm setup:business` (writes `theme/theme.json`).
2. Edit tokens in `theme/theme.json` for client-specific design tweaks.
3. Run `pnpm apply:theme` to regenerate `src/styles/theme.css`.
