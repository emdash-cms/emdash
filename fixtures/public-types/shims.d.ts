// Astro-generated virtual modules. Real EmDash sites get accurate types for
// these from `astro sync` (.astro/types.d.ts). This harness is hermetic and
// type-only -- it deliberately does not run an Astro build -- so these are
// stubbed. The harness's job is the shipped source's own TypeScript: kysely
// queries, fetch/Response handling, business logic. The Astro-virtual surface
// is covered by `astro check` in real sites and by the demos/templates
// typecheck jobs. Keep these as loose as possible without masking the source's
// own type errors.

declare module "astro:assets" {
	export const getImage: (...args: unknown[]) => Promise<unknown>;
	export const Image: unknown;
	export const Picture: unknown;
}
