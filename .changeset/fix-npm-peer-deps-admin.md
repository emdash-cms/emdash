---
"@emdash-cms/admin": patch
---

Fixes `npm install` peer dependency conflicts (#819) by removing `react` and `react-dom` from `dependencies`. They were declared in both `dependencies` and `peerDependencies`, which made npm think the admin package required an exact pinned React version and conflicted with the host Astro app's React. They remain `peerDependencies` (`^18.0.0 || ^19.0.0`), and the host app supplies React.
