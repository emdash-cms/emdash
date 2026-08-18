/**
 * Cloudflare Worker entry for EmDash sites.
 *
 * Wraps the Astro Cloudflare server handler with a `scheduled()` handler so a
 * Cron Triggers drive general maintenance and the separately bounded Media
 * Usage lane without request side effects. Re-exports the `PluginBridge`
 * Durable Object so the sandbox binding resolves against the entry module.
 *
 * The `@astrojs/cloudflare/entrypoints/server` import is resolved by the
 * consuming app's Astro build (it pulls the build-time `virtual:astro:app`
 * module), so this package keeps the adapter external.
 */

// @ts-ignore - resolved against the consuming app's Astro build
import astroHandler from "@astrojs/cloudflare/entrypoints/server";
import { createApp } from "astro/app/entrypoint";
import {
	runMediaUsageMaintenanceStep,
	runScheduledMediaUsageTasks,
	runScheduledTasks,
} from "emdash/middleware";

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
 * Build a Worker `scheduled()` handler. By default the every-two-minutes
 * expression runs Media Usage maintenance and every other expression runs
 * general maintenance. Configuring a general expression changes that lane
 * from catch-all to exact.
 */
export interface MediaUsageWakeMessage {
	version: 1;
}

export type OptionalMediaUsageQueueResolver<Env> = (
	env: Env,
) => Queue<MediaUsageWakeMessage> | undefined;

export type MediaUsageQueueResolver<Env> = (env: Env) => Queue<MediaUsageWakeMessage>;

export interface ScheduledHandlerOptions<Env = unknown> {
	generalCron?: string;
	mediaUsageCron?: string;
	resolveMediaUsageQueue?: OptionalMediaUsageQueueResolver<Env>;
}

const DEFAULT_MEDIA_USAGE_CRON = "*/2 * * * *";

export function createScheduledHandler<Env = unknown>(
	options?: ScheduledHandlerOptions<Env>,
): ExportedHandlerScheduledHandler<Env> {
	const generalCron = options?.generalCron?.trim();
	const mediaUsageCron = options?.mediaUsageCron?.trim() ?? DEFAULT_MEDIA_USAGE_CRON;
	if ((options?.generalCron !== undefined && !generalCron) || !mediaUsageCron) {
		throw new Error("Configured scheduled-handler expressions must be non-empty");
	}
	if (generalCron === mediaUsageCron) {
		throw new Error("General and Media Usage Cron expressions must differ");
	}

	return (controller, env, ctx) => {
		if (controller.cron === mediaUsageCron) {
			let queue: Queue<MediaUsageWakeMessage> | undefined;
			try {
				queue = options?.resolveMediaUsageQueue?.(env);
			} catch {
				console.error("[scheduled] Failed to queue Media Usage maintenance wake");
				return;
			}
			if (queue) {
				ctx.waitUntil(
					queue.send({ version: 1 }).catch(() => {
						console.error("[scheduled] Failed to queue Media Usage maintenance wake");
					}),
				);
				return;
			}
			ctx.waitUntil(
				runScheduledMediaUsageTasks().catch((error: unknown) => {
					console.error("[scheduled] Media Usage maintenance failed:", error);
				}),
			);
			return;
		}
		if (generalCron !== undefined && controller.cron !== generalCron) {
			console.warn(`[scheduled] Ignoring unexpected Cron expression: ${controller.cron}`);
			return;
		}
		ctx.waitUntil(
			// Invalidate incrementally as each collection batch publishes, so a
			// scheduled() invocation killed mid-sweep (CPU/wall-clock limits on a
			// large backlog) still purged the cache tags for everything it managed
			// to publish — not just whatever completed before a single end-of-sweep
			// purge that may never run.
			runScheduledTasks({ onPublished: invalidatePublishedTags })
				.then(({ published }) => {
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

export function createMediaUsageQueueHandler<Env>(
	resolveMediaUsageQueue: MediaUsageQueueResolver<Env>,
): ExportedHandlerQueueHandler<Env, MediaUsageWakeMessage> {
	return async (batch, env) => {
		let hasValidWake = false;
		for (const message of batch.messages) {
			if (isMediaUsageWakeMessage(message.body)) {
				hasValidWake = true;
			} else {
				message.ack();
				console.warn("[queue] Ignoring invalid Media Usage wake");
			}
		}
		if (!hasValidWake) return;

		const queue = resolveMediaUsageQueue(env);
		if (!queue) throw new Error("Media Usage Queue binding is unavailable");

		const result = await runMediaUsageMaintenanceStep();
		if (result.continuation.kind === "none") return;
		if (result.continuation.kind === "delayed") {
			await queue.send({ version: 1 }, { delaySeconds: result.continuation.delaySeconds });
			return;
		}
		await queue.send({ version: 1 });
	};
}

function isMediaUsageWakeMessage(value: unknown): value is MediaUsageWakeMessage {
	return typeof value === "object" && value !== null && "version" in value && value.version === 1;
}

// eslint-disable-next-line typescript/no-unsafe-type-assertion -- astroHandler is the adapter's { fetch } worker object; resolved at app-build time
const handler = astroHandler as ExportedHandler;

export default {
	...handler,
	scheduled: createScheduledHandler(),
} satisfies ExportedHandler;
