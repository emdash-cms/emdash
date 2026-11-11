import type { EmDashRoom } from "./object.js";

/** The room binding in a Worker's bindings, or null when it has none. */
export function roomsBinding(bindings: unknown): DurableObjectNamespace<EmDashRoom> | null {
	if (typeof bindings !== "object" || bindings === null || !("EMDASH_ROOMS" in bindings)) {
		return null;
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the binding the Wrangler config declares for EmDashRoom
	return (bindings.EMDASH_ROOMS as DurableObjectNamespace<EmDashRoom> | undefined) ?? null;
}
