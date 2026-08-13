/**
 * Custom Worker Entrypoint for EmDash
 *
 * Exports:
 * - default: Astro handler
 * - PluginBridge: WorkerEntrypoint for sandboxed plugin RPC
 */

import handler from "@astrojs/cloudflare/entrypoints/server";
import { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";

export { PluginBridge };

export default {
	...handler,
	scheduled: createScheduledHandler(),
} satisfies ExportedHandler<Env>;
