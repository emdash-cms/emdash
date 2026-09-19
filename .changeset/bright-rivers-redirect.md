---
"@emdash-cms/plugin-types": minor
"emdash": minor
"@emdash-cms/cloudflare": minor
"@emdash-cms/sandbox-workerd": minor
"@emdash-cms/plugin-test": minor
"@emdash-cms/plugin-cli": minor
"@emdash-cms/registry-lexicons": minor
"@emdash-cms/admin": minor
---

Adds capability-gated redirect access for sandboxed plugins. Declare `redirects:read` to list redirect rules with cursor pagination and read a rule with an opaque `_rev`. Declare `redirects:write` to create, update, and delete redirect rules; write access implies read access and installation consent states that the plugin can change where visitors are sent.

Redirect mutations use EmDash's redirect validation and cache invalidation path. Writes are serialized across runtimes so duplicate-source and loop validation use a consistent rule graph. The expanded redirect schema remains compatible with writes from previous host processes during rolling deployments. Loop validation runs when a rule is created or its source or destination changes; enabled-only updates retain the host API's existing behavior. Updates and deletes require the latest `_rev`, reject concurrent changes with `CONFLICT`, and do not let plugins set the host-owned automatic redirect marker. The Cloudflare Worker Loader and Node.js workerd runners expose the same API, and `createPluginRuntimeTestHost()` includes redirect fixtures and inspection for production-boundary tests.
