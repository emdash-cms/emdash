/**
 * Cloudflare Worker entry for EmDash sites.
 *
 * Wraps the Astro Cloudflare server handler with a `scheduled()` handler so a
 * Cron Trigger drives scheduled publishing, plugin cron, and system cleanup
 * without any request side effects. Re-exports the `PluginBridge` Durable
 * Object so the sandbox binding resolves against the entry module.
 *
 * Templates use this as their entire `src/worker.ts`:
 *
 *   export { default, PluginBridge } from "@emdash-cms/cloudflare/worker";
 *
 * and add a Cron Trigger to wrangler.jsonc:
 *
 *   "triggers": { "crons": ["* * * * *"] }
 *
 * The `@astrojs/cloudflare/entrypoints/server` import is resolved by the
 * consuming app's Astro build (it pulls the build-time `virtual:astro:app`
 * module), so this package keeps the adapter external.
 */

// @ts-ignore - resolved against the consuming app's Astro build
import astroHandler from "@astrojs/cloudflare/entrypoints/server";
import { createApp } from "astro/app/entrypoint";
import { runScheduledTasks } from "emdash/middleware";

export { PluginBridge } from "./sandbox/index.js";

// The Astro App wraps the build manifest; reuse one per isolate so each tick
// doesn't re-resolve the cache provider.
let app: ReturnType<typeof createApp> | null = null;

/**
 * Purge edge-cache tags for content the sweep just published. Without a
 * request there's no `locals.cache`, so we reach the configured cache provider
 * through the Astro App pipeline — the same provider routes invalidate against.
 * A no-op when no cache provider is configured.
 */
async function invalidatePublishedTags(
	published: ReadonlyArray<{ collection: string; id: string }>,
): Promise<void> {
	if (published.length === 0) return;
	app ??= createApp();
	const provider = await app.pipeline.getCacheProvider();
	if (!provider) return;
	const tags = [...new Set(published.flatMap((ref) => [ref.collection, ref.id]))];
	await provider.invalidate({ tags });
}

/**
 * Build a Worker `scheduled()` handler that runs EmDash's scheduled
 * maintenance batch and purges edge-cache tags for anything it published.
 * Exported for sites that assemble their own Worker object; most sites get it
 * via this module's default export.
 */
export function createScheduledHandler(): ExportedHandlerScheduledHandler {
	return (_controller, _env, ctx) => {
		ctx.waitUntil(
			runScheduledTasks()
				.then(async ({ published }) => {
					await invalidatePublishedTags(published);
					if (published.length > 0) {
						console.log(`[scheduled] Published ${published.length} scheduled item(s)`);
					}
					return undefined;
				})
				.catch((error: unknown) => {
					console.error("[scheduled] runScheduledTasks failed:", error);
				}),
		);
	};
}

// eslint-disable-next-line typescript/no-unsafe-type-assertion -- astroHandler is the adapter's { fetch } worker object; resolved at app-build time
const handler = astroHandler as ExportedHandler;

export default {
	...handler,
	scheduled: createScheduledHandler(),
} satisfies ExportedHandler;
