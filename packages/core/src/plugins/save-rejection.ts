/**
 * Thrown by a `content:beforeSave` hook to reject a save with a message
 * that is safe to show to the editor. The runtime converts it into a
 * structured `SAVE_REJECTED` API error; any other exception thrown by the
 * hook cancels the save with a generic error that hides the exception
 * message.
 */
export class ContentSaveRejectedError extends Error {
	override readonly name = "ContentSaveRejectedError";
}

/**
 * Matches by name as well as by prototype: bundlers can duplicate this
 * module across SSR chunks, and an `instanceof` against the wrong copy of
 * the class would misreport a rejection as a plugin crash.
 */
export function isContentSaveRejection(error: unknown): error is ContentSaveRejectedError {
	if (error instanceof ContentSaveRejectedError) return true;
	return error instanceof Error && error.name === "ContentSaveRejectedError";
}
