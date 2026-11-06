/**
 * Re-export the Cloudflare Worker env from a dedicated module.
 *
 * `cloudflare:workers` is a runtime virtual module. Keeping the static import
 * in this small helper means the main `cloudflare-email.ts` loads it through a
 * normal relative dynamic import, which bundles and resolves more reliably
 * inside an Astro Cloudflare Worker than a direct dynamic import of the
 * built-in specifier. The helper is externalised by the build, so the runtime
 * still resolves `cloudflare:workers` on the deployed Worker.
 */

export { env } from "cloudflare:workers";
