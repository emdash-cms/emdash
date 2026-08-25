/**
 * Cloudflare Worker entry for EmDash sites.
 *
 * Wraps the Astro Cloudflare server handler with a `scheduled()` handler for
 * general maintenance. Re-exports the `PluginBridge` Durable Object so the
 * sandbox binding resolves against the entry module.
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
 * Build a Worker `scheduled()` handler for general maintenance.
 */
export interface ScheduledHandlerOptions {
	generalCron?: string;
}

export function createScheduledHandler(
	options?: ScheduledHandlerOptions,
): ExportedHandlerScheduledHandler {
	const generalCron = options?.generalCron?.trim();
	if (options?.generalCron !== undefined && !generalCron) {
		throw new Error("Configured scheduled-handler expressions must be non-empty");
	}

	return (controller, _env, ctx) => {
		if (generalCron !== undefined && controller.cron !== generalCron) {
			console.warn(`[scheduled] Ignoring unexpected Cron expression: ${controller.cron}`);
			return;
		}

		ctx.waitUntil(
			(async () => {
				try {
					// Invalidate incrementally as each collection batch publishes, so a
					// scheduled() invocation killed mid-sweep (CPU/wall-clock limits on a
					// large backlog) still purged the cache tags for everything it managed
					// to publish — not just whatever completed before a single end-of-sweep
					// purge that may never run.
					const { published } = await runScheduledTasks({
						onPublished: invalidatePublishedTags,
					});
					if (published.length > 0) {
						console.log(`[scheduled] Published ${published.length} scheduled item(s)`);
					}
				} catch (error) {
					console.error("[scheduled] runScheduledTasks failed:", error);
				}
			})(),
		);
	};
}

// eslint-disable-next-line typescript/no-unsafe-type-assertion -- astroHandler is the adapter's { fetch } worker object; resolved at app-build time
const handler = astroHandler as ExportedHandler;

export default {
	...handler,
	scheduled: createScheduledHandler(),
} satisfies ExportedHandler;
