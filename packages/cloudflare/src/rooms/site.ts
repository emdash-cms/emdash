/**
 * `EmDashRoomSite`: how a room reaches its site, through its own Worker. Rooms call it over the
 * `exports` loopback. Like every named entrypoint, it isn't routable from the internet.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import {
	createRoomSite,
	type CheckpointInput,
	type EntryRef,
	type LoadedEntry,
	type RecoveryInput,
	type SaveResult,
} from "emdash/internal/co-editing";

async function site() {
	// Loaded on first use, as the plugin bridge loads it.
	const { withEmDashRuntime } = await import("emdash/middleware");
	return createRoomSite((fn) => withEmDashRuntime(fn));
}

export class EmDashRoomSite extends WorkerEntrypoint {
	async load(entry: EntryRef): Promise<LoadedEntry | null> {
		return (await site()).load(entry);
	}

	async save(entry: EntryRef, checkpoint: CheckpointInput): Promise<SaveResult> {
		return (await site()).save(entry, checkpoint);
	}

	async saveRecovery(entry: EntryRef, recovery: RecoveryInput): Promise<void> {
		await (await site()).saveRecovery(entry, recovery);
	}
}
