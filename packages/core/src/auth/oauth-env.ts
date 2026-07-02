/**
 * Resolve runtime environment for OAuth providers.
 *
 * Astro v6 removed `locals.runtime.env`. On Cloudflare Workers, bindings are
 * now read from `cloudflare:workers`. On Node-based adapters that module does
 * not exist, so fall back to `import.meta.env`.
 */

type OAuthEnvLoader = () => Promise<Record<string, unknown>>;

function hasEnv(value: unknown): value is { env: Record<string, unknown> } {
	if (typeof value !== "object" || value === null || !("env" in value)) return false;
	return typeof value.env === "object" && value.env !== null;
}

async function loadCloudflareOAuthEnv(): Promise<Record<string, unknown>> {
	// Keep the Cloudflare virtual module out of Node-target bundles. Otherwise
	// non-Cloudflare builds try to resolve it before the runtime fallback runs.
	const moduleUrl = `data:text/javascript,${encodeURIComponent(
		'export { env } from "cloudflare:workers";',
	)}`;
	const module = await import(/* @vite-ignore */ moduleUrl);
	return hasEnv(module) ? module.env : {};
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
		return import.meta.env;
	}
}
