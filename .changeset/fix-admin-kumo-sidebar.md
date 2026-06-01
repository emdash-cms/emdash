---
"@emdash-cms/admin": patch
---

Fix admin crash on authenticated load with @cloudflare/kumo 2.4.x (#1240). The
sidebar was using `Sidebar.GroupContent` and group-level `collapsible`/
`defaultOpen` props, which were removed in kumo 2.4.0. The four nav sections
(Content, Manage, Admin, Plugins) now render as plain `Sidebar.Group` blocks.
The workspace catalog range for `@cloudflare/kumo` is bumped from `^2.3.0` to
`^2.4.0` to match.
