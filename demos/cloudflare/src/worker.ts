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
	createScheduledHandler,
	type MediaUsageWakeMessage,
	PluginBridge,
} from "@emdash-cms/cloudflare/worker";

export { PluginBridge };

const resolveMediaUsageQueue = (env: Env) => env.MEDIA_USAGE_QUEUE;

export default {
	...handler,
	scheduled: createScheduledHandler({ resolveMediaUsageQueue }),
	queue: createMediaUsageQueueHandler(resolveMediaUsageQueue),
} satisfies ExportedHandler<Env, MediaUsageWakeMessage>;
