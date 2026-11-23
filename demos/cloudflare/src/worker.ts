/**
 * Custom Worker Entrypoint for EmDash
 *
 * Exports:
 * - default: Astro handler, after co-editing room upgrades
 * - PluginBridge: WorkerEntrypoint for sandboxed plugin RPC
 * - EmDashRoom: Durable Object for co-editing rooms
 * - EmDashRoomSite: WorkerEntrypoint rooms call back into
 */

import handler from "@astrojs/cloudflare/entrypoints/server";
import {
	createScheduledHandler,
	EmDashRoom,
	EmDashRoomSite,
	handleRoomUpgrade,
	PluginBridge,
} from "@emdash-cms/cloudflare/worker";

export { EmDashRoom, EmDashRoomSite, PluginBridge };

export default {
	...handler,
	fetch: (request, env, ctx) => handleRoomUpgrade(request, env) ?? handler.fetch(request, env, ctx),
	scheduled: createScheduledHandler(),
} satisfies ExportedHandler<Env>;
