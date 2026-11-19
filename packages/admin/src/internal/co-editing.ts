/**
 * The co-editing room's wire protocol, coverage rule and shared document layout.
 *
 * Server-safe: the room and the editor share it, so both read and write the shared document and
 * its messages the same way.
 */

export {
	MESSAGE_AWARENESS,
	MESSAGE_ROOM,
	MESSAGE_SYNC,
	decodeMessage,
	encodeAwareness,
	encodeRoomMessage,
	encodeSyncStep1,
	encodeSyncStep2,
	encodeUpdate,
} from "../co-editing/protocol.js";
export { snapshotContains } from "../co-editing/snapshot.js";
export {
	ENTRY_SLUG,
	FIELDS_MAP,
	FRAGMENT_PREFIX,
	editorSchema,
	fragmentName,
	readField,
	readFields,
	readSlug,
	touchedFields,
	writeField,
} from "../co-editing/layout.js";
export { CLOSE_CODES } from "../co-editing/types.js";

export type { LayoutField } from "../co-editing/layout.js";
export type {
	AwarenessEntry,
	CloseCode,
	Message,
	Notice,
	OutsideValue,
	RoomAccess,
	RoomMessage,
} from "../co-editing/types.js";
