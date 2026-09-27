---
"emdash": minor
---

Removes the legacy `emdash plugin` command group, including its marketplace login, logout, scaffold, validation, bundle, and publish commands.

Use the dedicated `@emdash-cms/plugin-cli` package for sandboxed plugin authoring and registry publishing:

```sh
pnpm add -D @emdash-cms/plugin-cli
pnpm exec emdash-plugin --help
```

Native plugins are npm packages and continue to use their package build scripts.
