---
"emdash": minor
"@emdash-cms/cloudflare": minor
"@emdash-cms/sandbox-workerd": minor
---

Adds the authenticated caller to plugin route handlers. Private plugin API routes now receive the requesting user as `ctx.user` (native format) / `routeCtx.user` (standard format) — `{ id, email, name, role, createdAt }` — so plugins can implement per-user logic without trusting a user id from the request body. Public routes and machine tokens with no bound user receive `undefined`.
