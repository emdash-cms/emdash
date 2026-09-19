/**
 * Keep this route on demand so Astro emits the server bundle and the
 * Cloudflare adapter deploys the custom Worker entrypoint from wrangler.jsonc.
 * The Worker handles /mcp before requests reach Astro's route handler.
 */
export const prerender = false;
