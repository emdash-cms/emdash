---
"@emdash-cms/admin": patch
---

Fixes invalid `<a><button>` HTML produced by `<Link><Button>...</Button></Link>` patterns across the admin UI. Introduces a `RouterLinkButton` component that wraps TanStack Router's `<Link>` with Kumo button styling (`variant`, `size`, `shape`, `icon` props), and migrates all existing `<Link className={buttonVariants(...)}>` usages to use it. Extracts the duplicated "Back to settings" header link into a shared `BackToSettingsLink` component.
