---
"@emdash-cms/admin": patch
---

Fixes button and link inconsistencies across the admin UI. Standardises on Kumo's `Button` `icon` prop and `LinkButton` (with `external` for new-tab links) instead of manual icon spacing and raw anchor styling, removes a `<Link><Button>` invalid HTML nesting in the plugin manager, and translates two stray English strings in the user list empty state.
