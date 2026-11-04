/**
 * Error messages for the Forms admin pages.
 *
 * Kept free of React and Kumo imports so the status handling can be unit tested.
 * A 403 is a permission problem: it must never be shown as an empty list or a
 * generic failure, and it must never be swallowed silently.
 */

export const FORMS_LOAD_FAILED = "Failed to load forms";
export const SUBMISSIONS_LOAD_FAILED = "Failed to load submissions";

const FORBIDDEN = 403;

/** Message for a failed forms/list request. */
export function formsLoadError(res: { status: number }): string {
	return res.status === FORBIDDEN ? "You don't have permission to view forms." : FORMS_LOAD_FAILED;
}

/** Message for a failed submissions/list request. */
export function submissionsLoadError(res: { status: number }): string {
	return res.status === FORBIDDEN
		? "You don't have permission to view submissions."
		: SUBMISSIONS_LOAD_FAILED;
}

/**
 * Message for a failed write (update, duplicate, delete, export).
 * Editors can read forms but the write routes require plugins:manage.
 */
export function writeError(res: { status: number }, fallback: string): string {
	return res.status === FORBIDDEN ? "You don't have permission to do this." : fallback;
}
