/**
 * Custom Worker Entrypoint for EmDash
 *
 * Exports:
 * - default: Astro handler
 * - PluginBridge: WorkerEntrypoint for sandboxed plugin RPC
 */

import handler from "@astrojs/cloudflare/entrypoints/server";
import {
	createMediaUsageQueueHandler,
	createMediaUsageFetchHandler,
	createScheduledHandler,
	type MediaUsageWakeMessage,
	PluginBridge,
} from "@emdash-cms/cloudflare/worker";

export { PluginBridge };

const resolveMediaUsageQueue = (env: Env) => env.MEDIA_USAGE_QUEUE;

export default {
	...handler,
	fetch: createMediaUsageFetchHandler(handler, resolveMediaUsageQueue),
	scheduled: createScheduledHandler(),
	queue: createMediaUsageQueueHandler(resolveMediaUsageQueue),
} satisfies ExportedHandler<Env, MediaUsageWakeMessage>;
