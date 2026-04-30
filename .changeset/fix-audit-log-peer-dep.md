---
"@emdash-cms/plugin-audit-log": patch
---

Republishes with `emdash` as a `peerDependency` instead of a runtime `dependency`. The previously published `0.1.1` release pinned `emdash` to an ancient `0.1.1` as a hard dependency, which made `npm install` of any template that included this plugin (e.g. the blog template) install two copies of `emdash` side-by-side, or fail outright with ERESOLVE on stricter npm configurations (#819). The package source already declared the dependency correctly; this version simply ships the corrected `package.json`.
