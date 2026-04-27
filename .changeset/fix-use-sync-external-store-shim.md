---
"emdash": patch
---

Fixes hydration of the inline PortableText editor on pnpm projects by aliasing `use-sync-external-store/shim` to the main `use-sync-external-store` package. The shim is a CJS-only React<18 polyfill imported transitively by `@tiptap/react`; under pnpm's virtual store Vite cannot pre-bundle it, and the browser receives raw `module.exports` which fails to load as ESM (`SyntaxError: ... does not provide an export named 'useSyncExternalStore'`). The aliases redirect to React's built-in `useSyncExternalStore` (peer-dep floor is React 18), so users no longer need to add the workaround themselves in `astro.config.mjs`.
