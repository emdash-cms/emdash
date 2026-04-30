---
"emdash": patch
---

Fixes `npm install` peer dependency conflicts (#819) by removing `@tanstack/react-query` and `@tanstack/react-router` from `peerDependencies`. These libraries are internal implementation details of the bundled admin UI (`@emdash-cms/admin`) and consuming Astro apps don't import them directly. Listing them as peers of `emdash` was forcing every npm-based install to install and resolve them at the top level, which produced ERESOLVE errors and bloat. The admin package continues to declare them as its own runtime dependencies.
