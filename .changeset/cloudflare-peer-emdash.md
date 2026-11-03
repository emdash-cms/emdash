---
"@emdash-cms/cloudflare": patch
"emdash": patch
---

Fixes `@emdash-cms/cloudflare` installing its own copy of `emdash` when the site has a different `emdash` version. The adapter now declares `emdash` as a peer dependency with its exact matching version, so a site always has a single `emdash`.

Keep both packages on the same version and update them together:

```sh
npm install emdash@latest @emdash-cms/cloudflare@latest
```

A project with mismatched versions now fails `npm install` with an `ERESOLVE` error instead of installing a second copy. pnpm and Yarn print a peer dependency warning, and `astro build` and `astro dev` warn as before.
