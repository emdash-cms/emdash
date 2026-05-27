---
"@emdash-cms/admin": patch
"@emdash-cms/blocks": patch
"@emdash-cms/auth-atproto": patch
---

Bumps `@cloudflare/kumo` from 1.16 to 2.3. Two internal call sites picked up breaking API changes from Kumo 2.0: `Collapsible` is now a compound component (`Collapsible.Root` / `.DefaultTrigger` / `.DefaultPanel` instead of `<Collapsible label=...>`), used by the accordion block; and `ChartPalette.color()` was renamed to `ChartPalette.categorical()` in the chart block. No public API changes -- consumers see identical behaviour. Tests in `@emdash-cms/admin` that asserted on `Button`'s native `title` attribute now read `aria-label` instead, because Kumo 2 wraps `<Button title>` in a Tooltip popup rather than setting the DOM attribute.
