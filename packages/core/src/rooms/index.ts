/**
 * The co-editing host boundary, `emdash/internal/co-editing`, for hosts outside this package.
 * It has no path to the room engine, which `emdash/internal/co-editing/room` exports, so Yjs and
 * the editor schema load only where a room runs. Notifications and the room's site have their
 * own subpaths too, so the database and content code they import stay out of a Worker's startup.
 */

export { MAX_UPDATE_BYTES, ROOM_STATE_LIFETIME_MS } from "./limits.js";
export { joinParts, splitBytes, splitText } from "./parts.js";
export { CLOSE_CODES, isRoomToken, parseRoomId, RoomSaveError, roomIdFromPath } from "./types.js";
export { COMMIT, VERSION } from "../version.js";

export type {
	CheckpointInput,
	CloseCode,
	ConnectionInfo,
	EntryRef,
	LoadedEntry,
	OutsideValue,
	RecoveryInput,
	RoomConnection,
	RoomRecord,
	RoomStore,
	RoomTimers,
	RuntimeRoomHost,
	SaveResult,
	TokenClaims,
} from "./types.js";
