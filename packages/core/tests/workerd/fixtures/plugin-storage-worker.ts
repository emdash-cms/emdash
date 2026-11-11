import { WorkerEntrypoint } from "cloudflare:workers";

import { PluginBridge as StorageBridge } from "../../../../cloudflare/src/sandbox/bridge.js";
import type {
	CheckpointInput,
	EntryRef,
	LoadedEntry,
	RecoveryInput,
	RoomSite,
	SaveResult,
} from "../../../src/rooms/types.js";

export { EmDashRoom } from "../../../../cloudflare/src/rooms/object.js";

export class PluginBridge extends StorageBridge {}

const ROOM_SITE = Symbol.for("emdash:test:room-site");

/** The site rooms reach, set by each test on `globalThis`, which this isolate shares with tests. */
export function setRoomSite(site: RoomSite | null): void {
	(globalThis as Record<symbol, unknown>)[ROOM_SITE] = site;
}

function roomSite(): RoomSite {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- set by setRoomSite
	const site = (globalThis as Record<symbol, unknown>)[ROOM_SITE] as RoomSite | null | undefined;
	if (!site) throw new Error("No room site is set");
	return site;
}

export class EmDashRoomSite extends WorkerEntrypoint {
	load(entry: EntryRef): Promise<LoadedEntry | null> {
		return roomSite().load(entry);
	}

	save(entry: EntryRef, checkpoint: CheckpointInput): Promise<SaveResult> {
		return roomSite().save(entry, checkpoint);
	}

	saveRecovery(entry: EntryRef, recovery: RecoveryInput): Promise<void> {
		return roomSite().saveRecovery(entry, recovery);
	}
}
