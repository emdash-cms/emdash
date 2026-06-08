---
"emdash": minor
---

The Astro dev server now prints absolute, clickable URLs for the admin UI and (when enabled) the MCP server, along with a dev-bypass shortcut link that signs you in as a dev admin without going through passkey setup or auth. The startup banner also shows the installed EmDash version. The dev-bypass link is dev-only and the underlying endpoint returns 403 in production.
