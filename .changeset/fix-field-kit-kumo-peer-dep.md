---
"@emdash-cms/plugin-field-kit": patch
---

Fixes the `@cloudflare/kumo` peer-dependency range to match the `2.x` release used by `emdash`, `@emdash-cms/admin`, and `@emdash-cms/blocks`.

The published `0.1.0` tarball still declared a `^1.0.0` peer range, which made `npm install` fail with a conflicting peer dependency (`ERESOLVE`) when users added the plugin alongside recent EmDash releases.
