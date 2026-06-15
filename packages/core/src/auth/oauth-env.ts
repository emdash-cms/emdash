/**
 * Resolve runtime environment for OAuth providers.
 *
 * Astro v6 removed `locals.runtime.env`. On Cloudflare Workers, bindings are
 * now read from `cloudflare:workers`. On Node-based adapters that module does
 * not exist, so fall back to `import.meta.env`.
 */

type OAuthEnvLoader = () => Promise<Record<string, unknown>>;

async function loadCloudflareOAuthEnv(): Promise<Record<string, unknown>> {
	const specifier = "cloudflare:workers";
	const module = (await import(/* @vite-ignore */ specifier)) as {
		env?: Record<string, unknown>;
	};
	return module.env ?? {};
}

function isMissingCloudflareWorkersModule(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const message = error.message;
	return (
		message.includes("cloudflare:workers") &&
		(message.includes("Cannot find package") ||
			message.includes("ERR_MODULE_NOT_FOUND") ||
			message.includes("Failed to resolve") ||
			message.includes("Could not resolve") ||
			message.includes("No such module"))
	);
}

export async function getOAuthEnv(
	loadEnv: OAuthEnvLoader = loadCloudflareOAuthEnv,
): Promise<Record<string, unknown>> {
	try {
		return await loadEnv();
	} catch (error) {
		if (!isMissingCloudflareWorkersModule(error)) throw error;
		return import.meta.env as Record<string, unknown>;
	}
}
