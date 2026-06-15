/**
 * Resolve runtime environment for OAuth providers.
 *
 * Astro v6 removed `locals.runtime.env`. On Cloudflare Workers, bindings are
 * now read from `cloudflare:workers`. On Node-based adapters that module does
 * not exist, so fall back to `import.meta.env`.
 */
export async function getOAuthEnv(): Promise<Record<string, unknown>> {
	try {
		// @ts-ignore - runtime-only Cloudflare Workers virtual module
		const { env } = await import("cloudflare:workers");
		return env as Record<string, unknown>;
	} catch {
		return import.meta.env as Record<string, unknown>;
	}
}
