---
"emdash": patch
---

Fixes a cryptic build failure when a configured plugin has no resolvable entrypoint (#1416). Passing an inline `definePlugin({...})` result directly to `plugins: []` previously failed deep in the bundler with an unhelpful "failed to resolve import" error. The build now fails fast with a clear message that names the offending plugin and explains that `plugins: []` entries must resolve to a file or package entrypoint — move the plugin into its own module and reference it from there.
