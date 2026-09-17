---
"@emdash-cms/blocks": minor
"@emdash-cms/admin": minor
"@emdash-cms/plugin-test": minor
"emdash": minor
"@emdash-cms/cloudflare": patch
"@emdash-cms/sandbox-workerd": patch
"@emdash-cms/plugin-cli": patch
---

Adds structured Block Kit navigation and host-attested administrator locale context for sandboxed plugin pages and dashboard widgets.

Plugins can return `link` elements that target saved content, another page declared by the same plugin, generated plugin settings, or an external HTTP, HTTPS, or `mailto:` URL. EmDash constructs internal admin URLs and opens external links with `noopener noreferrer`. Links never dispatch block actions and cannot appear as form fields.

Block Kit route handlers receive `routeCtx.ui` with the validated surface, administrator locale, and text direction. The host validates every sandboxed page and widget response before rendering it, rejects undeclared plugin-page targets and active URL protocols, and permits external images only over HTTPS to hosts declared in `allowedHosts` or under `network:request:unrestricted` consent.

`createPluginRuntimeTestHost()` adds `admin.loadPage()`, `loadWidget()`, `act()`, and `submit()` helpers that exercise the private production route, Worker Loader isolate, host UI context, and response validation. Existing plugin routes and Block Kit controls remain compatible.
