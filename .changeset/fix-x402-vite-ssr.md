---
"@emdash-cms/x402": patch
---

fix(x402): add tsdown config and exclude middleware from Vite SSR optimizer

- Add `tsdown.config.ts` to build both `src/index.ts` and `src/middleware.ts` as ESM outputs
- Add `optimizeDeps.exclude` and `ssr.optimizeDeps.exclude` for `@emdash-cms/x402` to prevent esbuild from failing on `virtual:x402/config`
