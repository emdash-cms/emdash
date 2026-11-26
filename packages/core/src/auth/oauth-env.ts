/**
 * Choose the env object OAuth provider credentials are read from.
 *
 * A non-null `platformEnv` is the Cloudflare Workers env and is returned
 * unchanged. Otherwise the runtime env is used. `buildEnv` fills gaps only
 * in dev: Vite inlines `import.meta.env`, so spreading it in a production
 * server bundle bakes build-machine secrets in and shadows credentials
 * configured on the host. See `readDefaultEnv` in `config/secrets.ts`.
 */
export function resolveOAuthEnv(
	platformEnv: Record<string, unknown> | null | undefined,
	runtimeEnv: Record<string, unknown> | undefined,
	buildEnv: Record<string, unknown>,
	dev: boolean,
): Record<string, unknown> {
	if (platformEnv != null) return platformEnv;
	return dev ? { ...buildEnv, ...runtimeEnv } : { ...runtimeEnv };
}

/**
 * Read OAuth credentials for the current adapter.
 *
 * `virtual:emdash/env` is the Worker env on Cloudflare and `undefined` on
 * Node. Production reads `process.env` only. Build-time `import.meta.env`
 * is a dev fallback for values `astro dev` loaded from `.env`.
 */
export async function getOAuthEnv(): Promise<Record<string, unknown>> {
	const { env: platformEnv } = await import("virtual:emdash/env");
	return resolveOAuthEnv(
		platformEnv,
		typeof process !== "undefined" ? process.env : undefined,
		import.meta.env.DEV ? import.meta.env : {},
		import.meta.env.DEV,
	);
}
