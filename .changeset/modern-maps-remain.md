---
"@emdash-cms/admin": patch
---

Fixes invalid `<a><button>` HTML produced by `<Link><Button>...</Button></Link>` patterns across the admin UI. Replaces them with `<Link className={buttonVariants(...)}>...</Link>` (TanStack Router `Link` doesn't compose with `LinkButton`). Extracts the duplicated "Back to settings" header link into a shared `BackToSettingsLink` component.
