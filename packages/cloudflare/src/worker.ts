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
import { exports as workerExports, WorkerEntrypoint } from "cloudflare:workers";

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

async function invalidateContentTags(tags: string[]): Promise<void> {
	if (tags.length === 0) return;
	const provider = await getCacheProvider();
	if (!provider) return;
	await provider.invalidate({ tags });
}

async function invalidateDefaultEntrypointTags(tags: string[]): Promise<void> {
	if (tags.length === 0) return;
	// Workers Cache purges are scoped to the calling entrypoint. Cron invocations
	// must use RPC on the default entrypoint, not fetch or a named entrypoint.
	const entrypoint = (
		workerExports as {
			default?: { emdashInvalidateCache: (tags: string[]) => Promise<void> };
		}
	)?.default;
	if (!entrypoint) {
		throw new Error("Default-entrypoint cache invalidation requires Cloudflare loopback exports");
	}
	await entrypoint.emdashInvalidateCache(tags);
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
	/** Requires EmDashWorker (or a subclass) as the site's default export. */
	invalidateViaDefaultEntrypoint?: boolean;
}

export function createScheduledHandler(
	options?: ScheduledHandlerOptions,
): ExportedHandlerScheduledHandler {
	const generalCron = options?.generalCron?.trim();
	if (options?.generalCron !== undefined && !generalCron) {
		throw new Error("Configured scheduled-handler expressions must be non-empty");
	}

	// The runtime retains this callback for request-less plugin actions, so it
	// must not capture an invocation's ExecutionContext or RPC stub.
	const invalidate = options?.invalidateViaDefaultEntrypoint
		? invalidateDefaultEntrypointTags
		: invalidateContentTags;

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
						onPublished: (refs) =>
							invalidate([...new Set(refs.flatMap((ref) => [ref.collection, ref.id]))]),
						invalidateContentCache: invalidate,
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
const handler = astroHandler as Omit<ExportedHandler, "fetch"> & {
	fetch?: (request: Request, env: unknown, ctx: ExecutionContext) => Response | Promise<Response>;
};

function workerFetch(request: Request, env: unknown, ctx: ExecutionContext) {
	const upgrade = handleRoomUpgrade(request, env);
	if (upgrade) return upgrade;
	if (!handler.fetch) throw new Error("The Astro handler has no fetch");
	return handler.fetch(request, env, ctx);
}

const scheduledHandler = createScheduledHandler();
const rpcScheduledHandler = createScheduledHandler({ invalidateViaDefaultEntrypoint: true });

/** Legacy object-style handler. Use EmDashWorker as default for Workers Cache cron purges. */
export default {
	...handler,
	fetch: workerFetch,
	scheduled: scheduledHandler,
} satisfies ExportedHandler;

/**
 * Export as the site's default entrypoint to invalidate Workers Cache from Cron Triggers.
 * Extend this class when the site needs custom fetch or scheduled handling.
 */
export class EmDashWorker extends WorkerEntrypoint {
	override fetch(request: Request): Response | Promise<Response> {
		return workerFetch(request, this.env, this.ctx);
	}

	override scheduled(controller: ScheduledController): void | Promise<void> {
		return rpcScheduledHandler(controller, this.env, this.ctx);
	}

	async emdashInvalidateCache(tags: string[]): Promise<void> {
		await invalidateContentTags(tags);
	}
}
