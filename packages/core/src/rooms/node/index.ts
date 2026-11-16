/**
 * The Node.js room host, `emdash/internal/co-editing/node`. Only `virtual:emdash/rooms` imports
 * it, on `@astrojs/node` with co-editing on, so its code never reaches a Workers bundle.
 */

import cluster from "node:cluster";

import type { EmDashRuntime } from "../../emdash-runtime.js";
import { runInFreshRequestContext } from "../../request-context.js";
import { COMMIT, VERSION } from "../../version.js";
import { createRoomSite } from "../site.js";
import type { RuntimeRoomHost } from "../types.js";
import { RoomRegistry } from "./registry.js";
import { watchServers } from "./upgrades.js";

/**
 * The runtime's room registry, or null in a `node:cluster` worker: the cluster's primary hands
 * out connections without seeing their paths, so no room path can be routed to one worker.
 */
export function createRoomHost(runtime: EmDashRuntime): RuntimeRoomHost | null {
	if (cluster.isWorker) return null;
	watchServers();
	return new RoomRegistry({
		db: runtime.db,
		// Never the queuing request's context, whose cached reads go stale, nor `getRuntime`, which
		// builds a new runtime during a development restart.
		site: createRoomSite((fn) => runInFreshRequestContext(() => fn(runtime))),
		build: { version: VERSION, commit: COMMIT },
	});
}
