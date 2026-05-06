---
"emdash": minor
---

`emdash plugin init` now prompts for the plugin format (sandboxed or native) when run interactively, and the scaffolded boilerplate matches the canonical patterns from the docs. Both formats now ship a `dist/` build via tsdown, declare a sample `storage` collection, and demonstrate a hook plus an API route. The sandboxed entry uses an explicitly typed `ContentSaveEvent`; the native entry forwards options through `createPlugin`. The descriptor `id` is now derived from the slug instead of the full scoped package name, so scoped names like `@org/my-plugin` produce a runtime-valid id. Pass `--format=sandboxed`, `--format=native`, or `--native` to skip the prompt; non-TTY runs continue to default to sandboxed.
