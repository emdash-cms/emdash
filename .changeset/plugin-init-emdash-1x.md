---
"@emdash-cms/plugin-cli": patch
---

Fixes `emdash-plugin init` so a new plugin installs EmDash 1.x for local development and tests. Plugins scaffolded by earlier versions installed EmDash 0.x; to move one to 1.x, set `emdash` to `^1.0.0` and `@emdash-cms/plugin-test` to `^0.2.6` in its `devDependencies`.
