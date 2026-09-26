---
"emdash": patch
---

Fixes the admin UI hanging indefinitely on "Loading EmDash…" in local dev on Windows, with no visible error. The Lingui macro compiler used to build admin source in dev mode compared file paths using a Windows-style backslash path against Vite's forward-slash-normalized module ids, so the comparison always failed and macro compilation silently never ran — shipping raw, uncompiled `@lingui/*/macro` imports to the browser, which then threw during hydration. A second, previously-masked bug in the same code path passed a raw Windows drive-letter path to a dynamic `import()`, which Node's ESM loader rejects.
