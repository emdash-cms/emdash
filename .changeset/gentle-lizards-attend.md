---
"@emdash-cms/plugin-test": patch
---

Fixes intermittent empty-manifest errors when `emdashPluginTest()` runs multiple test files in parallel by isolating each plugin build.

`emdashPluginTest()` no longer writes to the plugin's `dist/` directory. Run `emdash-plugin build` separately if you need build artifacts after testing.
