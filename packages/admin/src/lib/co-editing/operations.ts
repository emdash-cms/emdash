import * as React from "react";

/**
 * What the entry's operations need from a room: publishing, scheduling, discarding, restoring and
 * moving to Trash. Outside a room, nothing waits and nothing is blocked.
 */
export interface RoomOperations {
	/**
	 * Resolves once a kept save covers this tab's edits, so the operation runs on them. Rejects
	 * with an error whose message says why.
	 */
	prepare(): Promise<void>;
	/** Offline or without edit access, so operations can't run. */
	readonly blocked: boolean;
	/** The entry is open in a room, so others' edits can land while an operation runs. */
	readonly inRoom: boolean;
}

const SINGLE_EDITOR: RoomOperations = {
	prepare: () => Promise.resolve(),
	blocked: false,
	inRoom: false,
};

export const RoomOperationsContext = React.createContext<RoomOperations>(SINGLE_EDITOR);

export function useRoomOperations(): RoomOperations {
	return React.useContext(RoomOperationsContext);
}
