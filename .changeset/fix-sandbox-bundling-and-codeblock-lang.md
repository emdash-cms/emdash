---
"emdash": patch
"@emdash-cms/blocks": patch
"@emdash-cms/plugin-webhook-notifier": patch
"@emdash-cms/plugin-sandboxed-test": patch
---

Fix sandboxed plugin entries failing with "Unexpected token '{'" by bundling them with esbuild at build time instead of embedding raw TypeScript source. Also fix CodeBlock crash on unsupported language values by normalizing aliases before passing to Kumo.
