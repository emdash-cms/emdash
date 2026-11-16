/**
 * Cloudflare Worker entry for EmDash sites.
 *
 * Wraps the Astro Cloudflare server handler with a `scheduled()` handler for
 * general maintenance, and forwards co-editing room upgrades to their Durable
 * Object. Re-exports the `PluginBridge` Durable Object so the sandbox binding
 * resolves against the entry module, and the co-editing room classes so the
 * `EMDASH_ROOMS` binding and the rooms' site loopback do too.
 *
 * The `@astrojs/cloudflare/entrypoints/server` import is resolved by the
 * consuming app's Astro build (it pulls the build-time `virtual:astro:app`
 * module), so this package keeps the adapter external.
 */

// @ts-ignore - resolved against the consuming app's Astro build
import astroHandler from "@astrojs/cloudflare/entrypoints/server";
import { createApp } from "astro/app/entrypoint";

import { handleRoomUpgrade } from "./rooms/upgrade.js";

export { PluginBridge } from "./sandbox/bridge.js";
export { EmDashRoom } from "./rooms/object.js";
export { EmDashRoomSite } from "./rooms/site.js";
export { handleRoomUpgrade };

const APP_KEY = Symbol.for("@emdash-cms/cloudflare:astro-app");
const CACHE_PROVIDER_KEY = Symbol.for("@emdash-cms/cloudflare:cache-provider");
const runtimeGlobals = globalThis as Record<symbol, unknown>;

function getApp(): ReturnType<typeof createApp> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton values are scoped by private Symbol.for keys
	const existing = runtimeGlobals[APP_KEY] as ReturnType<typeof createApp> | undefined;
	if (existing) return existing;
	const app = createApp();
	runtimeGlobals[APP_KEY] = app;
	return app;
}

async function loadCacheProvider() {
	const app = getApp();
	const module = await app.manifest.cacheProvider?.();
	return module?.default?.(app.manifest.cacheConfig?.options) ?? null;
}

function getCacheProvider(): ReturnType<typeof loadCacheProvider> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton values are scoped by private Symbol.for keys
	const existing = runtimeGlobals[CACHE_PROVIDER_KEY] as
		| ReturnType<typeof loadCacheProvider>
		| undefined;
	if (existing) return existing;
	const provider = loadCacheProvider().catch((error: unknown) => {
		if (runtimeGlobals[CACHE_PROVIDER_KEY] === provider) {
			delete runtimeGlobals[CACHE_PROVIDER_KEY];
		}
		throw error;
	});
	runtimeGlobals[CACHE_PROVIDER_KEY] = provider;
	return provider;
}

/**
 * Purge edge-cache tags for content the sweep just published. Without a
 * request there's no `locals.cache`, so we reach the configured cache provider
 * through the Astro App manifest — the same provider routes invalidate against.
 * A no-op when no cache provider is configured.
 */
async function invalidatePublishedTags(
	published: ReadonlyArray<{ collection: string; id: string }>,
): Promise<void> {
	if (published.length === 0) return;
	const provider = await getCacheProvider();
	if (!provider) return;
	const tags = [...new Set(published.flatMap((ref) => [ref.collection, ref.id]))];
	await provider.invalidate({ tags });
}

async function invalidateContentTags(tags: string[]): Promise<void> {
	if (tags.length === 0) return;
	const provider = await getCacheProvider();
	if (!provider) return;
	await provider.invalidate({ tags });
}

/**
 * How long each Cron Trigger run waits for upcoming scheduled content, so it
 * goes live at its scheduled time rather than whenever the next trigger
 * starts. Just over the one-minute trigger interval, so runs overlap as little
 * as possible.
 */
const PUBLISH_UPCOMING_WITHIN_MS = 70 * 1000;

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
					const { runScheduledTasks } = await import("emdash/middleware");
					// Invalidate incrementally as each collection batch publishes, so a
					// scheduled() invocation killed mid-sweep (CPU/wall-clock limits on a
					// large backlog) still purged the cache tags for everything it managed
					// to publish — not just whatever completed before a single end-of-sweep
					// purge that may never run.
					const { published } = await runScheduledTasks({
						onPublished: invalidatePublishedTags,
						invalidateContentCache: invalidateContentTags,
						publishUpcomingWithinMs: PUBLISH_UPCOMING_WITHIN_MS,
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
	// Room upgrades go to their Durable Object before Astro runs.
	fetch(request, env, ctx) {
		const upgrade = handleRoomUpgrade(request, env);
		if (upgrade) return upgrade;
		if (!handler.fetch) throw new Error("The Astro handler has no fetch");
		return handler.fetch(request, env, ctx);
	},
	scheduled: createScheduledHandler(),
} satisfies ExportedHandler;
