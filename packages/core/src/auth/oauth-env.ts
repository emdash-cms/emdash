/**
 * Resolve the environment record used to read OAuth provider credentials.
 *
 * Resolution order:
 *   1. locals.runtime.env  — Astro v5 + @astrojs/cloudflare
 *   2. cloudflare:workers  — Astro v6 + @astrojs/cloudflare (locals.runtime.env was removed)
 *   3. import.meta.env     — Node.js / Vite dev server fallback
 *
 * Centralizing the chain here keeps the resolution order in one place so the
 * OAuth start and callback routes cannot drift apart.
 */
export async function resolveOAuthEnv(locals: App.Locals): Promise<Record<string, unknown>> {
	try {
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- locals.runtime is injected by the Cloudflare adapter at runtime; not declared on App.Locals since the adapter is optional
		const runtimeLocals = locals as unknown as { runtime?: { env?: Record<string, unknown> } };
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- import.meta.env is typed as ImportMetaEnv but we need Record<string, unknown> for getOAuthConfig
		return runtimeLocals.runtime?.env ?? (import.meta.env as Record<string, unknown>);
	} catch (error) {
		// Astro v6: locals.runtime.env accessor throws — import from cloudflare:workers instead.
		// The module id is held in a variable so Rollup cannot statically resolve it: in the
		// Node template builds the specifier does not exist, and a literal import would fail
		// the build. It resolves at runtime only on Cloudflare Workers.
		console.warn("[oauth] locals.runtime.env unavailable, trying cloudflare:workers", error);
		try {
			// Built at runtime (not a string literal) so neither this package's bundler nor
			// the downstream Astro/Rollup template build statically resolves "cloudflare:workers".
			const cfWorkersModId = ["cloudflare", "workers"].join(":");
			const { env: cfEnv } = await import(/* @vite-ignore */ cfWorkersModId);
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- cloudflare:workers env is typed as Cloudflare.Env; cast to generic record for getOAuthConfig
			return cfEnv as Record<string, unknown>;
		} catch {
			// Not running on Cloudflare Workers — fall back to Vite's import.meta.env
			// eslint-disable-next-line typescript/no-unsafe-type-assertion
			return import.meta.env as Record<string, unknown>;
		}
	}
}
