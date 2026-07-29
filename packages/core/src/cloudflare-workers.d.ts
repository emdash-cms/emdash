/**
 * Minimal ambient types for optional `cloudflare:workers` APIs used by core.
 * Full types live in @cloudflare/workers-types; this only covers what we call.
 */
declare module "cloudflare:workers" {
	export const env: Record<string, unknown>;

	export const cache:
		| {
				purge(options: {
					purgeEverything?: boolean;
					tags?: string[];
					pathPrefixes?: string[];
				}): Promise<{ success: boolean; errors: { code?: number; message: string }[] }>;
		  }
		| undefined;
}
